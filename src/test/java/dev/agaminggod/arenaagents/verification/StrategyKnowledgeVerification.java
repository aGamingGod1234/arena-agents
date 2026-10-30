package dev.agaminggod.arenaagents.verification;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.zip.ZipFile;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.Bootstrap;
import net.minecraft.SharedConstants;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.component.DataComponentInitializers;
import net.minecraft.core.registries.Registries;
import net.minecraft.data.registries.VanillaRegistries;
import net.minecraft.world.item.Item;

/** Verifies the knowledge page against the resolved vanilla data, without a world or server. */
public final class StrategyKnowledgeVerification {
	private static final String START = "<!-- registry-pickaxe-table -->";
	private static final String END = "<!-- /registry-pickaxe-table -->";
	private static final String BARTER_START = "<!-- registry-barter-odds -->";
	private static final String BARTER_END = "<!-- /registry-barter-odds -->";
	private static final List<String> MATERIALS = List.of("wooden", "gold", "stone", "copper", "iron", "diamond", "netherite");
	private static final List<String> EXTRA_BLOCKS = List.of("stone", "deepslate", "furnace", "obsidian", "crying_obsidian", "ancient_debris");
	private final ZipFile game;
	private final Map<String, Set<String>> tags = new HashMap<>();

	private StrategyKnowledgeVerification(ZipFile game) {
		this.game = game;
	}

	public static void main(String[] args) throws IOException {
		if (args.length < 2 || args.length > 3 || args.length == 3 && !"--write".equals(args[2])) {
			throw new IllegalArgumentException("usage: StrategyKnowledgeVerification <game.jar> <guide.md> [--write]");
		}
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
		try (var game = new ZipFile(args[0])) {
			var verification = new StrategyKnowledgeVerification(game);
			String version = verification.json("version.json").get("id").getAsString();
			String pinned = SharedConstants.getCurrentVersion().name();
			if (!version.equals(pinned)) throw new IllegalStateException("Knowledge jar version differs from resolved game: " + version + " != " + pinned);
			Path guide = Path.of(args[1]);
			String source = Files.readString(guide).replace("\r\n", "\n");
			int start = source.indexOf(START);
			int end = source.indexOf(END);
			if (start < 0 || end <= start) throw new IllegalStateException("Missing pickaxe table markers");
			String table = verification.pickaxeTable();
			String expected = source.substring(0, start + START.length()) + "\n" + table + source.substring(end);
			int barterStart = expected.indexOf(BARTER_START);
			int barterEnd = expected.indexOf(BARTER_END);
			if (barterStart < 0 || barterEnd <= barterStart) throw new IllegalStateException("Missing barter odds markers");
			String barter = verification.barterOdds();
			expected = expected.substring(0, barterStart + BARTER_START.length()) + "\n  " + barter + "  " + expected.substring(barterEnd);
			if (args.length == 3) Files.writeString(guide, expected.replace("\n", "\r\n"), StandardCharsets.UTF_8);
			else if (!source.equals(expected)) throw new IllegalStateException("Guide pickaxe table or barter odds differ from " + version + " tags/loot; run exportStrategyKnowledge");
			Path foodFile = guide.resolveSibling("cookable-foods.json");
			String foodData = verification.cookableFoods(version);
			if (args.length == 3) Files.writeString(foodFile, foodData, StandardCharsets.UTF_8);
			else if (!Files.readString(foodFile).replace("\r\n", "\n").equals(foodData)) throw new IllegalStateException("Cookable food index differs from resolved game recipes; run exportStrategyKnowledge");
			System.out.println("Verified Minecraft " + version + " pickaxe eligibility and loot candidates: " + verification.blocks().size() + " blocks x " + MATERIALS.size() + " materials.");
			System.out.println("Verified " + barter.strip());
		}
	}

	private String barterOdds() throws IOException {
		var pools = json("data/minecraft/loot_table/gameplay/piglin_bartering.json").getAsJsonArray("pools");
		if (pools.size() != 1) throw new IllegalStateException("Barter odds require one unconditional pool");
		JsonObject pool = pools.get(0).getAsJsonObject();
		if (pool.has("conditions") || pool.get("rolls").getAsDouble() != 1 || pool.has("bonus_rolls") && pool.get("bonus_rolls").getAsDouble() != 0) {
			throw new IllegalStateException("Unsupported conditional or multiple-roll barter pool");
		}
		int total = 0;
		int pearls = 0;
		for (JsonElement value : pool.getAsJsonArray("entries")) {
			JsonObject entry = value.getAsJsonObject();
			if (!"minecraft:item".equals(entry.get("type").getAsString()) || entry.has("conditions") || entry.has("quality") && entry.get("quality").getAsInt() != 0) {
				throw new IllegalStateException("Unsupported conditional or luck-dependent barter entry");
			}
			int weight = entry.has("weight") ? entry.get("weight").getAsInt() : 1;
			if (weight <= 0) throw new IllegalStateException("Nonpositive barter weight");
			total += weight;
			if ("minecraft:ender_pearl".equals(entry.get("name").getAsString())) pearls += weight;
		}
		if (pearls == 0) throw new IllegalStateException("No ender pearl barter entry");
		return String.format(Locale.ROOT, "Pearl barter weight %d of %d (about %.2f%%).\n", pearls, total, 100.0 * pearls / total);
	}

	@SuppressWarnings("unchecked")
	private String cookableFoods(String version) throws IOException {
		Set<String> edible = new TreeSet<>();
		// Bootstrap does not bind item components in 26.1; the vanilla initializer
		// exposes them without mutating global holders or starting a world.
		for (var pending : BuiltInRegistries.DATA_COMPONENT_INITIALIZERS.build(net.minecraft.data.registries.VanillaRegistries.createReloadableLookup(net.minecraft.data.registries.VanillaRegistries.createWorldLookup()))) {
			if (!pending.key().equals(Registries.ITEM)) continue;
			((DataComponentInitializers.PendingComponents<Item>) pending).forEach((holder, components) -> {
				if (components.get(DataComponents.FOOD) != null) edible.add(BuiltInRegistries.ITEM.getKey(holder.value()).toString());
			});
		}
		TreeSet<String> foods = new TreeSet<>();
		for (var entry : game.stream().filter(entry -> entry.getName().startsWith("data/minecraft/recipe/") && entry.getName().endsWith(".json")).toList()) {
			JsonObject recipe = json(entry.getName());
			if (!recipe.has("type") || !"minecraft:smelting".equals(recipe.get("type").getAsString())) continue;
			JsonElement ingredient = recipe.get("ingredient");
			if (ingredient == null || !ingredient.isJsonPrimitive()) continue;
			String id = ingredient.getAsString();
			if (id.startsWith("#")) continue;
			String output = recipe.getAsJsonObject("result").get("id").getAsString();
			if (edible.contains(id) && edible.contains(output)) foods.add(id);
		}
		if (foods.isEmpty()) throw new IllegalStateException("No cookable foods in resolved game");
		JsonObject data = new JsonObject();
		data.addProperty("minecraftVersion", version);
		var values = new com.google.gson.JsonArray();
		foods.forEach(values::add);
		data.add("items", values);
		return data.toString() + "\n";
	}

	private TreeSet<String> blocks() throws IOException {
		TreeSet<String> blocks = new TreeSet<>(EXTRA_BLOCKS);
		for (String id : tag("mineable/pickaxe")) {
			String name = id.replace("minecraft:", "");
			if (name.endsWith("_ore")) blocks.add(name);
		}
		return blocks;
	}

	private String pickaxeTable() throws IOException {
		StringBuilder out = new StringBuilder("| Block | Pickaxe materials that yield drops | Loot items (conditional) |\n|---|---|---|\n");
		for (String block : blocks()) {
			String id = "minecraft:" + block;
			var registryBlock = BuiltInRegistries.BLOCK.getValue(Identifier.parse(id));
			if (!BuiltInRegistries.BLOCK.getKey(registryBlock).toString().equals(id) || !registryBlock.defaultBlockState().requiresCorrectToolForDrops()) {
				throw new IllegalStateException("Expected registered pickaxe-required block: " + id);
			}
			List<String> eligible = new ArrayList<>();
			for (String material : MATERIALS) {
				if (tag("mineable/pickaxe").contains(id) && !tag("incorrect_for_" + material + "_tool").contains(id)) eligible.add(material);
			}
			Set<String> loot = new TreeSet<>();
			lootItems(json("data/minecraft/loot_table/blocks/" + block + ".json"), loot);
			if (loot.isEmpty() || eligible.isEmpty()) throw new IllegalStateException("Missing tool or loot entries: " + id);
			if (block.startsWith("deepslate_") && block.endsWith("_ore")) {
				String ordinary = block.substring("deepslate_".length());
				for (String material : MATERIALS) {
					if (tag("incorrect_for_" + material + "_tool").contains(id) != tag("incorrect_for_" + material + "_tool").contains("minecraft:" + ordinary)) {
						throw new IllegalStateException("Deepslate tier differs: " + block);
					}
				}
				continue;
			}
			out.append("| ").append(block).append(" | ").append(String.join(",", eligible)).append(" | ").append(String.join(",", loot)).append(" |\n");
		}
		return out.toString();
	}

	private Set<String> tag(String name) throws IOException {
		if (tags.containsKey(name)) return tags.get(name);
		Set<String> result = new TreeSet<>();
		for (JsonElement entry : json("data/minecraft/tags/block/" + name + ".json").getAsJsonArray("values")) {
			String value = entry.isJsonObject() ? entry.getAsJsonObject().get("id").getAsString() : entry.getAsString();
			if (value.startsWith("#minecraft:")) result.addAll(tag(value.substring("#minecraft:".length())));
			else result.add(value);
		}
		tags.put(name, result);
		return result;
	}

	private JsonObject json(String path) throws IOException {
		var entry = game.getEntry(path);
		if (entry == null) throw new IllegalStateException("Missing game data: " + path);
		try (var input = game.getInputStream(entry)) {
			return JsonParser.parseString(new String(input.readAllBytes(), StandardCharsets.UTF_8)).getAsJsonObject();
		}
	}

	private static void lootItems(JsonElement element, Set<String> names) {
		if (element.isJsonArray()) {
			for (JsonElement value : element.getAsJsonArray()) lootItems(value, names);
		} else if (element.isJsonObject()) {
			JsonObject object = element.getAsJsonObject();
			if (object.has("type") && "minecraft:item".equals(object.get("type").getAsString())) {
				names.add(object.get("name").getAsString().replace("minecraft:", ""));
			}
			for (var entry : object.entrySet()) lootItems(entry.getValue(), names);
		}
	}
}
