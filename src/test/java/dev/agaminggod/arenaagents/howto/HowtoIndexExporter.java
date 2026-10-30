package dev.agaminggod.arenaagents.howto;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.lang.reflect.Field;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileSystem;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.stream.Stream;
import net.minecraft.core.Holder;
import net.minecraft.core.HolderSet;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.flag.FeatureFlags;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.component.Tool;
import net.minecraft.world.item.crafting.Ingredient;
import net.minecraft.world.level.block.Block;

/**
 * Emits the compact "how do I get X" index from Minecraft's own data: the shipped vanilla datapack (recipes,
 * tags, loot tables, villager trades, worldgen) plus the facts that exist only in code after bootstrap
 * (which blocks need the correct tool for drops, each tool's drop rules, brewing mixes).
 */
public final class HowtoIndexExporter {
	private static final String MINECRAFT_VERSION = "26.3";
	private static final int INDEX_VERSION = 1;
	private static final List<String> OTHER_LOOT = List.of("chests", "archaeology", "gameplay", "spawners", "shearing",
			"harvest", "brush", "carve", "charged_creeper", "pots");
	private static final Map<String, String> NOISE_DIMENSIONS = Map.of("overworld", "overworld", "nether", "the_nether", "end", "the_end");

	private final Path data;
	private final Map<String, Map<String, List<String>>> rawTags = new HashMap<>();
	private final Map<String, Set<String>> resolvedTags = new HashMap<>();
	private final Set<String> usedItemTags = new TreeSet<>();
	private final Map<String, List<Object>> recipes = new TreeMap<>();
	private final Map<String, Map<String, String>> blockDrops = new TreeMap<>();
	private final Map<String, Map<String, String>> mobDrops = new TreeMap<>();
	private final Map<String, Set<String>> mobSpawns = new TreeMap<>();
	private final Map<String, Set<String>> loot = new TreeMap<>();
	private final Map<String, List<Object>> trades = new TreeMap<>();
	private final Map<String, Integer> harvest = new TreeMap<>();
	private final List<Map<String, List<String>>> toolSets = new ArrayList<>();
	private final Map<String, Set<List<Integer>>> worldgenY = new TreeMap<>();
	private final Map<String, Set<String>> worldgenDimensions = new TreeMap<>();
	private final Set<String> worldgenUnbounded = new HashSet<>();
	private final Map<String, Integer> skippedRecipeTypes = new TreeMap<>();
	private final Map<String, Integer> fuels = new TreeMap<>();
	private final net.minecraft.core.HolderLookup.Provider lookup = net.minecraft.data.registries.VanillaRegistries.createReloadableLookup(net.minecraft.data.registries.VanillaRegistries.createWorldLookup());

	private HowtoIndexExporter(Path data) {
		this.data = data;
	}

	public static void main(String[] args) throws Exception {
		if (args.length < 1 || args.length > 2 || args.length == 2 && !"--check".equals(args[1])) {
			throw new IllegalArgumentException("usage: HowtoIndexExporter <output> [--check]");
		}
		long started = System.nanoTime();
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		bindVanillaTags();
		Path output = Path.of(args[0]).toAbsolutePath().normalize();
		byte[] encoded;
		try (FileSystem jar = openVanillaData()) {
			HowtoIndexExporter exporter = new HowtoIndexExporter(jar.getPath("/data/minecraft"));
			encoded = exporter.encode();
			System.out.println("howto index skipped recipe types (no fixed ingredients in data): " + exporter.skippedRecipeTypes);
		}
		System.out.println("howto index: " + encoded.length + " bytes in " + (System.nanoTime() - started) / 1_000_000 + " ms");
		if (args.length == 2) {
			if (!Files.isRegularFile(output) || !java.util.Arrays.equals(encoded, Files.readString(output, StandardCharsets.UTF_8)
					.replace("\r\n", "\n").getBytes(StandardCharsets.UTF_8))) {
				throw new IllegalStateException("committed howto index differs from Minecraft " + MINECRAFT_VERSION + " data; run exportHowtoIndex");
			}
			return;
		}
		writeAtomically(output, encoded);
	}

	/** Binds vanilla tags into the built-in registries as a server does, so code that iterates tags (fuel values) works. */
	private static void bindVanillaTags() {
		try (var resources = new net.minecraft.server.packs.resources.MultiPackResourceManager(net.minecraft.server.packs.PackType.SERVER_DATA,
				List.of(net.minecraft.server.packs.repository.ServerPacksSource.createVanillaPackSource().fullResources()))) {
			net.minecraft.tags.TagLoader.loadTagsForExistingRegistries(resources, net.minecraft.core.RegistryAccess.fromRegistryOfRegistries(BuiltInRegistries.REGISTRY))
					.forEach(net.minecraft.core.Registry.PendingTags::apply);
		}
	}

	private static FileSystem openVanillaData() throws Exception {
		URL marker = HowtoIndexExporter.class.getClassLoader().getResource("data/minecraft/recipe/crafting_table.json");
		if (marker == null || !"jar".equals(marker.getProtocol())) throw new IllegalStateException("vanilla datapack is not on the classpath as a jar");
		String spec = marker.toString();
		URI jar = URI.create(spec.substring("jar:".length(), spec.indexOf("!/")));
		return FileSystems.newFileSystem(Path.of(jar));
	}

	private byte[] encode() throws IOException {
		loadTags("item");
		loadTags("block");
		loadTags("worldgen/biome");
		loadTags("villager_trade");
		readRecipes();
		readBrewing();
		readLoot();
		readTrades();
		readHarvestTools();
		readWorldgen();
		readSpawns();
		readFuels();
		Map<String, Object> index = new LinkedHashMap<>();
		index.put("version", INDEX_VERSION);
		index.put("minecraft", MINECRAFT_VERSION);
		index.put("recipes", recipes);
		Map<String, Object> tags = new TreeMap<>();
		for (String tag : usedItemTags) tags.put(tag, new ArrayList<>(resolve("item", "minecraft:" + tag.substring(1))).stream().map(HowtoIndexExporter::shortId).sorted().toList());
		index.put("tags", tags);
		index.put("blockDrops", pairs(blockDrops));
		index.put("harvest", harvest);
		index.put("toolSets", toolSets);
		index.put("mobDrops", pairs(mobDrops));
		index.put("mobSpawns", mobSpawns);
		index.put("loot", loot);
		index.put("trades", trades);
		Map<String, Object> worldgen = new TreeMap<>();
		for (Map.Entry<String, Set<String>> entry : worldgenDimensions.entrySet()) {
			Map<String, Object> row = new LinkedHashMap<>();
			row.put("d", entry.getValue());
			Set<List<Integer>> y = worldgenY.get(entry.getKey());
			if (y != null && !worldgenUnbounded.contains(entry.getKey())) row.put("y", y);
			worldgen.put(entry.getKey(), row);
		}
		index.put("worldgen", worldgen);
		index.put("fuels", fuels);
		Gson gson = new GsonBuilder().disableHtmlEscaping().create();
		return (gson.toJson(index) + "\n").getBytes(StandardCharsets.UTF_8);
	}

	private static Map<String, List<List<String>>> pairs(Map<String, Map<String, String>> sources) {
		Map<String, List<List<String>>> result = new TreeMap<>();
		sources.forEach((item, bySource) -> result.put(item, bySource.entrySet().stream().map(e -> List.of(e.getKey(), e.getValue())).toList()));
		return result;
	}

	// Tags ------------------------------------------------------------------------------------------------

	private void loadTags(String registry) throws IOException {
		Map<String, List<String>> tags = new HashMap<>();
		Path root = data.resolve("tags/" + registry);
		for (Path file : jsonFiles(root)) {
			List<String> values = new ArrayList<>();
			for (JsonElement value : read(file).getAsJsonArray("values")) {
				values.add(value.isJsonObject() ? value.getAsJsonObject().get("id").getAsString() : value.getAsString());
			}
			tags.put("minecraft:" + relativeName(root, file), values);
		}
		rawTags.put(registry, tags);
	}

	private Set<String> resolve(String registry, String tag) {
		String key = registry + "#" + tag;
		Set<String> cached = resolvedTags.get(key);
		if (cached != null) return cached;
		Set<String> members = new TreeSet<>();
		resolvedTags.put(key, members);
		for (String value : rawTags.get(registry).getOrDefault(tag, List.of())) {
			if (value.startsWith("#")) members.addAll(resolve(registry, value.substring(1)));
			else members.add(value);
		}
		return members;
	}

	// Recipes and brewing ---------------------------------------------------------------------------------

	private void readRecipes() throws IOException {
		Path root = data.resolve("recipe");
		for (Path file : jsonFiles(root)) {
			JsonObject recipe = read(file);
			String type = shortId(recipe.get("type").getAsString());
			String recipeId = relativeName(root, file);
			Map<String, Integer> inputs = new LinkedHashMap<>();
			String station;
			switch (type) {
				case "crafting_shaped" -> {
					JsonObject key = recipe.getAsJsonObject("key");
					JsonArray pattern = recipe.getAsJsonArray("pattern");
					boolean small = pattern.size() <= 2;
					for (JsonElement row : pattern) {
						String line = row.getAsString();
						small &= line.length() <= 2;
						for (char symbol : line.toCharArray()) {
							if (symbol != ' ') inputs.merge(ingredient(key.get(String.valueOf(symbol))), 1, Integer::sum);
						}
					}
					station = small ? "inventory" : "crafting_table";
				}
				case "crafting_shapeless" -> {
					JsonArray ingredients = recipe.getAsJsonArray("ingredients");
					for (JsonElement ingredient : ingredients) inputs.merge(ingredient(ingredient), 1, Integer::sum);
					station = ingredients.size() <= 4 ? "inventory" : "crafting_table";
				}
				case "crafting_transmute" -> {
					// 26.3: an empty result keeps the input item, so each input the tag allows is its own recipe.
					JsonElement result = recipe.get("result");
					if (result.isJsonObject() && !result.getAsJsonObject().has("id")) {
						String input = recipe.get("input").getAsString();
						for (String member : input.startsWith("#") ? resolve("item", input.substring(1)) : Set.of(input)) {
							Map<String, Integer> same = new LinkedHashMap<>();
							same.merge(shortId(member), 1, Integer::sum);
							same.merge(ingredient(recipe.get("material")), 1, Integer::sum);
							addRecipe(shortId(member), "inventory", 1, same, recipeId);
						}
						continue;
					}
					inputs.merge(ingredient(recipe.get("input")), 1, Integer::sum);
					inputs.merge(ingredient(recipe.get("material")), 1, Integer::sum);
					station = "inventory";
				}
				case "smelting", "blasting", "smoking", "campfire_cooking", "stonecutting" -> {
					inputs.put(ingredient(recipe.get("ingredient")), 1);
					station = switch (type) {
						case "smelting" -> "furnace";
						case "blasting" -> "blast_furnace";
						case "campfire_cooking" -> "campfire";
						case "stonecutting" -> "stonecutter";
						default -> "smoker";
					};
				}
				case "smithing_transform" -> {
					for (String slot : List.of("template", "base", "addition")) {
						if (recipe.has(slot)) inputs.merge(ingredient(recipe.get(slot)), 1, Integer::sum);
					}
					station = "smithing_table";
				}
				default -> {
					skippedRecipeTypes.merge(type, 1, Integer::sum);
					continue;
				}
			}
			JsonElement result = recipe.get("result");
			String output = shortId(result.isJsonObject() ? result.getAsJsonObject().get("id").getAsString() : result.getAsString());
			int count = result.isJsonObject() && result.getAsJsonObject().has("count") ? result.getAsJsonObject().get("count").getAsInt() : 1;
			addRecipe(output, station, count, inputs, recipeId.equals(output) ? null : recipeId);
		}
	}

	private void addRecipe(String output, String station, int count, Map<String, Integer> inputs, String recipeId) {
		List<Object> row = new ArrayList<>(List.of(station, count, inputs.entrySet().stream().map(e -> List.of(e.getKey(), e.getValue())).toList()));
		if (recipeId != null) row.add(recipeId);
		recipes.computeIfAbsent(output, ignored -> new ArrayList<>()).add(row);
	}

	private String ingredient(JsonElement value) {
		if (value.isJsonArray()) {
			List<String> options = new ArrayList<>();
			for (JsonElement option : value.getAsJsonArray()) options.add(ingredient(option));
			return String.join("|", options);
		}
		String id = value.getAsString();
		if (!id.startsWith("#")) return shortId(id);
		String tag = "#" + shortId(id.substring(1));
		usedItemTags.add(tag);
		return tag;
	}

	/**
	 * Brewing mixes are datapack recipes since 26.3 (one per container). A potion-to-potion recipe is a potion mix;
	 * a recipe that changes the container is a container mix, listed once per container pair as the code table was.
	 */
	private void readBrewing() throws IOException {
		Set<String> containerMixes = new HashSet<>();
		for (Path file : jsonFiles(data.resolve("recipe/brewing"))) {
			JsonObject recipe = read(file);
			if (!"minecraft:brewing".equals(recipe.get("type").getAsString())) continue;
			JsonObject input = recipe.getAsJsonObject("input"), output = recipe.getAsJsonObject("output");
			String reagent = shortId(recipe.getAsJsonObject("reagent").get("item").getAsString());
			String from = shortId(input.get("item").getAsString()), to = shortId(output.get("id").getAsString());
			Map<String, Integer> inputs = new LinkedHashMap<>();
			if (from.equals(to)) {
				if (!from.equals("potion")) continue;
				String fromPotion = input.getAsJsonObject("potion_contents").get("potions").getAsString();
				String toPotion = output.getAsJsonObject("components").getAsJsonObject("minecraft:potion_contents").get("potion").getAsString();
				// One reagent converts one to three bottles; the coordinator applies that batch rule and the fuel use.
				inputs.put("potion:" + shortId(fromPotion), 1);
				inputs.put(reagent, 1);
				addRecipe("potion:" + shortId(toPotion), "brewing_stand", 1, inputs, null);
			} else if (containerMixes.add(from + ">" + to + ">" + reagent)) {
				inputs.put(from, 1);
				inputs.put(reagent, 1);
				addRecipe(to, "brewing_stand", 1, inputs, null);
			}
		}
	}

	/** PotionBrewing.Mix is a package-private record, so its public accessors still need access granted. */
	private static Object component(Object mix, String name) throws ReflectiveOperationException {
		java.lang.reflect.Method accessor = mix.getClass().getDeclaredMethod(name);
		accessor.setAccessible(true);
		return accessor.invoke(mix);
	}

	// Loot tables -----------------------------------------------------------------------------------------

	private void readLoot() throws IOException {
		Path root = data.resolve("loot_table");
		for (Path file : jsonFiles(root.resolve("blocks"))) {
			String block = relativeName(root.resolve("blocks"), file);
			walkTable(read(file), "", (item, flags) -> keepLeastRestrictive(blockDrops, item, block, flags), new HashSet<>());
		}
		for (Path file : jsonFiles(root.resolve("entities"))) {
			String name = relativeName(root.resolve("entities"), file);
			// Variant tables (sheep/white) are reached only through their parent's guarded entry, which keeps the condition.
			if (name.contains("/")) continue;
			String mob = name;
			walkTable(read(file), "", (item, flags) -> keepLeastRestrictive(mobDrops, item, mob, flags), new HashSet<>());
		}
		for (String folder : OTHER_LOOT) {
			for (Path file : jsonFiles(root.resolve(folder))) {
				String source = relativeName(root, file);
				walkTable(read(file), "", (item, flags) -> loot.computeIfAbsent(item, ignored -> new TreeSet<>()).add(source), new HashSet<>());
			}
		}
	}

	private interface DropSink {
		void accept(String item, String flags);
	}

	private static void keepLeastRestrictive(Map<String, Map<String, String>> target, String item, String source, String flags) {
		target.computeIfAbsent(item, ignored -> new TreeMap<>()).merge(source, flags, (left, right) -> tokens(right).size() < tokens(left).size() ? right : left);
	}

	private void walkTable(JsonObject table, String flags, DropSink sink, Set<String> visiting) throws IOException {
		if (!table.has("pools")) return;
		for (JsonElement poolElement : table.getAsJsonArray("pools")) {
			JsonObject pool = poolElement.getAsJsonObject();
			walkEntries(pool.getAsJsonArray("entries"), mergeFlags(flags, conditionFlags(pool.get("condition"))), sink, visiting);
		}
	}

	private void walkEntries(JsonArray entries, String inherited, DropSink sink, Set<String> visiting) throws IOException {
		if (entries == null) return;
		for (JsonElement element : entries) {
			JsonObject entry = element.getAsJsonObject();
			String flags = mergeFlags(inherited, conditionFlags(entry.get("condition")));
			switch (shortId(entry.get("type").getAsString())) {
				case "item" -> sink.accept(shortId(entry.get("name").getAsString()), mayDropNone(entry) ? mergeFlags(flags, "r") : flags);
				case "tag" -> {
					for (String item : resolve("item", entry.has("items") ? entry.get("items").getAsString().replaceFirst("^#", "") : entry.get("name").getAsString())) sink.accept(shortId(item), flags);
				}
				case "loot_table" -> {
					JsonElement value = entry.get("value");
					if (value.isJsonObject()) walkTable(value.getAsJsonObject(), flags, sink, visiting);
					else {
						String reference = shortId(value.getAsString());
						Path file = data.resolve("loot_table/" + reference + ".json");
						if (visiting.add(reference) && Files.isRegularFile(file)) walkTable(read(file), flags, sink, visiting);
					}
				}
				case "alternatives", "group", "sequence" -> walkEntries(entry.getAsJsonArray("children"), flags, sink, visiting);
				default -> {
				}
			}
		}
	}

	/** A set_count that can roll zero (uniform from 0, binomial) makes the drop a chance, as for blaze rods. */
	private static boolean mayDropNone(JsonObject entry) {
		if (!entry.has("modifier")) return false;
		JsonElement modifiers = entry.get("modifier");
		for (JsonElement element : modifiers.isJsonArray() ? modifiers.getAsJsonArray() : List.of(modifiers)) {
			JsonObject function = element.getAsJsonObject();
			if (!"set_count".equals(shortId(function.get("type").getAsString())) || function.has("condition")) continue;
			JsonElement count = function.get("count");
			if (count.isJsonPrimitive()) return count.getAsDouble() <= 0;
			JsonObject provider = count.getAsJsonObject();
			String type = provider.has("type") ? shortId(provider.get("type").getAsString()) : "uniform";
			if ("binomial".equals(type)) return true;
			if (provider.has("min") && provider.get("min").isJsonPrimitive() && provider.get("min").getAsDouble() <= 0) return true;
		}
		return false;
	}

	/**
	 * Comma-separated condition tokens: s silk touch, h shears, t other tool, r chance, p block state such as fully grown,
	 * k player kill, e other condition. A slash joins either-or tokens from any_of, such as h/s for shears or silk touch.
	 */
	// 26.3 loot tables hold one condition (an object, a list or a predicate id) under "condition", typed by "type".
	private String conditionFlags(JsonElement conditions) throws IOException {
		String flags = "";
		if (conditions == null) return flags;
		if (conditions.isJsonArray()) {
			for (JsonElement condition : conditions.getAsJsonArray()) flags = mergeFlags(flags, conditionFlags(condition));
			return flags;
		}
		if (conditions.isJsonPrimitive()) {
			net.minecraft.resources.Identifier id = net.minecraft.resources.Identifier.parse(conditions.getAsString());
			return conditionFlags(read(data.getParent().resolve(id.getNamespace()).resolve("predicate").resolve(id.getPath() + ".json")));
		}
		return conditionFlag(conditions.getAsJsonObject());
	}

	private String conditionFlag(JsonObject condition) throws IOException {
		return switch (shortId(condition.get("type").getAsString())) {
			case "match_tool" -> {
				String predicate = condition.has("predicate") ? condition.get("predicate").toString() : "";
				yield predicate.contains("silk_touch") ? "s" : predicate.contains("shears") ? "h" : "t";
			}
			case "all_of" -> {
				String flags = "";
				for (JsonElement term : condition.getAsJsonArray("terms")) flags = mergeFlags(flags, conditionFlags(term));
				yield flags;
			}
			case "any_of" -> {
				TreeSet<String> either = new TreeSet<>();
				boolean simple = true;
				for (JsonElement term : condition.getAsJsonArray("terms")) {
					Set<String> termTokens = tokens(conditionFlags(term));
					// An unconditional branch makes the whole any_of unconditional.
					if (termTokens.isEmpty()) yield "";
					if (termTokens.size() != 1 || termTokens.iterator().next().contains("/")) simple = false;
					either.addAll(termTokens);
				}
				yield simple ? String.join("/", either) : "e";
			}
			case "random_chance", "random_chance_with_enchanted_bonus", "table_bonus" -> "r";
			case "block_state_property", "match_block" -> "p";
			case "killed_by_player" -> "k";
			case "entity_properties", "damage_source_properties", "location_check", "weather_check", "time_check" -> "e";
			default -> "";
		};
	}

	private static String mergeFlags(String left, String right) {
		TreeSet<String> merged = new TreeSet<>(tokens(left));
		merged.addAll(tokens(right));
		return String.join(",", merged);
	}

	private static Set<String> tokens(String flags) {
		return flags.isEmpty() ? Set.of() : new TreeSet<>(List.of(flags.split(",")));
	}

	// Villager trades -------------------------------------------------------------------------------------

	private void readTrades() throws IOException {
		Path root = data.resolve("trade_set");
		for (Path file : jsonFiles(root)) {
			String[] name = relativeName(root, file).split("/");
			String profession = name[0];
			Integer level = name.length > 1 && name[1].startsWith("level_") ? Integer.valueOf(name[1].substring(6)) : null;
			String tradesTag = read(file).get("trades").getAsString();
			Set<String> tradeIds = tradesTag.startsWith("#") ? resolve("villager_trade", tradesTag.substring(1)) : Set.of(tradesTag);
			for (String tradeId : tradeIds) {
				Path tradeFile = data.resolve("villager_trade/" + shortId(tradeId) + ".json");
				if (!Files.isRegularFile(tradeFile)) continue;
				JsonObject trade = read(tradeFile);
				List<List<Object>> wants = new ArrayList<>();
				for (String slot : List.of("wants", "additional_wants")) {
					if (trade.has(slot)) wants.add(stack(trade.getAsJsonObject(slot)));
				}
				List<Object> gives = stack(trade.getAsJsonObject("gives"));
				List<Object> row = new ArrayList<>();
				row.add(level == null ? profession + "/" + name[name.length - 1] : profession);
				row.add(level == null ? 0 : level);
				row.add(wants);
				row.add(gives.get(1));
				List<Object> rows = trades.computeIfAbsent((String) gives.get(0), ignored -> new ArrayList<>());
				if (!rows.contains(row)) rows.add(row);
			}
		}
	}

	private static List<Object> stack(JsonObject stack) {
		JsonElement count = stack.get("count");
		int amount = count == null ? 1 : count.isJsonPrimitive() ? (int) Math.round(count.getAsDouble())
				: count.getAsJsonObject().has("min") ? (int) Math.round(count.getAsJsonObject().get("min").getAsDouble()) : 1;
		return List.of(shortId(stack.get("id").getAsString()), amount);
	}

	// Tool requirements -----------------------------------------------------------------------------------

	private void readHarvestTools() {
		// Item components bind when a server loads registries; the data generator's lookup binds them here.
		for (var pending : BuiltInRegistries.DATA_COMPONENT_INITIALIZERS.build(lookup)) pending.apply();
		Map<String, List<Tool.Rule>> tools = new TreeMap<>();
		for (Item item : BuiltInRegistries.ITEM) {
			Tool tool = item.components().get(DataComponents.TOOL);
			if (tool != null) tools.put(shortId(BuiltInRegistries.ITEM.getKey(item).toString()), tool.rules());
		}
		Map<String, Set<String>> harvestable = new TreeMap<>();
		Map<String, List<String>> correctTools = new TreeMap<>();
		for (Block block : BuiltInRegistries.BLOCK) {
			if (!block.defaultBlockState().requiresCorrectToolForDrops()) continue;
			String blockId = BuiltInRegistries.BLOCK.getKey(block).toString();
			List<String> correct = new ArrayList<>();
			tools.forEach((toolId, rules) -> {
				if (correctForDrops(rules, blockId)) {
					correct.add(toolId);
					harvestable.computeIfAbsent(toolId, ignored -> new HashSet<>()).add(blockId);
				}
			});
			correctTools.put(shortId(blockId), correct);
		}
		Map<List<String>, Integer> interned = new HashMap<>();
		correctTools.forEach((block, correct) -> harvest.put(block, interned.computeIfAbsent(correct, all -> {
			List<String> weakest = all.stream().filter(tool -> all.stream().noneMatch(other -> {
				Set<String> mine = harvestable.get(tool), theirs = harvestable.get(other);
				return mine.containsAll(theirs) && mine.size() > theirs.size();
			})).toList();
			Map<String, List<String>> set = new LinkedHashMap<>();
			set.put("min", weakest);
			set.put("all", all);
			toolSets.add(set);
			return toolSets.size() - 1;
		})));
	}

	/** Mirrors Tool.isCorrectForDrops: the first rule that matches the block and states correctness decides. */
	private boolean correctForDrops(List<Tool.Rule> rules, String blockId) {
		for (Tool.Rule rule : rules) {
			if (rule.correctForDrops().isPresent() && contains(rule.blocks(), blockId)) return rule.correctForDrops().get();
		}
		return false;
	}

	private boolean contains(HolderSet<Block> blocks, String blockId) {
		return blocks.unwrap().map(tag -> resolve("block", tag.location().toString()).contains(blockId),
				list -> list.stream().anyMatch(holder -> holder.unwrapKey().orElseThrow().identifier().toString().equals(blockId)));
	}

	/** Furnace burn time in ticks per item: the cooking_fuel component's number provider, read as a furnace (not fast). */
	@SuppressWarnings("unchecked")
	private void readFuels() throws IOException {
		for (var pending : BuiltInRegistries.DATA_COMPONENT_INITIALIZERS.build(lookup)) {
			if (!pending.key().equals(net.minecraft.core.registries.Registries.ITEM)) continue;
			Map<String, net.minecraft.world.item.component.CookingFuel> found = new TreeMap<>();
			((net.minecraft.core.component.DataComponentInitializers.PendingComponents<Item>) pending).forEach((holder, components) -> {
				var fuel = components.get(DataComponents.COOKING_FUEL);
				if (fuel != null) found.put(shortId(BuiltInRegistries.ITEM.getKey(holder.value()).toString()), fuel);
			});
			for (var entry : found.entrySet()) {
				int ticks = switch (entry.getValue().burnTime()) {
					case net.minecraft.world.level.storage.loot.providers.number.ints.ResolvableInt.Constant constant -> constant.value();
					case net.minecraft.world.level.storage.loot.providers.number.ints.ResolvableInt.Reference reference ->
							furnaceTicks(new com.google.gson.JsonPrimitive(reference.key().identifier().toString()));
				};
				if (ticks > 0) fuels.put(entry.getKey(), ticks);
			}
		}
	}

	/** Evaluates a vanilla context_int_provider for an ordinary furnace: numbers, references, div and the fast_cooking condition. */
	private int furnaceTicks(JsonElement provider) throws IOException {
		if (provider.isJsonPrimitive() && provider.getAsJsonPrimitive().isNumber()) return provider.getAsInt();
		if (provider.isJsonPrimitive()) {
			String id = provider.getAsString();
			return furnaceTicks(JsonParser.parseString(Files.readString(data.getParent().resolve(net.minecraft.resources.Identifier.parse(id).getNamespace())
					.resolve("context_int_provider").resolve(net.minecraft.resources.Identifier.parse(id).getPath() + ".json"), StandardCharsets.UTF_8)));
		}
		JsonObject object = provider.getAsJsonObject();
		return switch (shortId(object.get("type").getAsString())) {
			case "div" -> furnaceTicks(object.get("left")) / furnaceTicks(object.get("right"));
			case "conditional" -> {
				if (!"minecraft:block/fast_cooking".equals(object.get("condition").getAsString())) throw new IllegalStateException("unknown fuel condition " + object);
				yield furnaceTicks(object.get("on_false"));
			}
			default -> throw new IllegalStateException("unsupported fuel provider " + object);
		};
	}

	// Worldgen --------------------------------------------------------------------------------------------

	private void readWorldgen() throws IOException {
		// Height anchors resolve against the generator's depth (WorldGenerationContext from noise settings), not the
		// dimension type: the Nether builds within 0..127 although its dimension type is 256 tall.
		Map<String, int[]> bounds = new HashMap<>();
		for (Map.Entry<String, String> noise : NOISE_DIMENSIONS.entrySet()) {
			JsonObject settings = read(data.resolve("worldgen/noise_settings/" + noise.getKey() + ".json")).getAsJsonObject("noise");
			bounds.put(noise.getValue(), new int[] {settings.get("min_y").getAsInt(), settings.get("height").getAsInt()});
		}
		Map<String, String> biomeDimensions = biomeDimensions();
		Path biomes = data.resolve("worldgen/biome");
		for (Path file : jsonFiles(biomes)) {
			String dimension = biomeDimensions.get(relativeName(biomes, file));
			if (dimension == null) continue;
			for (JsonElement step : read(file).getAsJsonArray("features")) {
				for (JsonElement placed : step.getAsJsonArray()) {
					walkPlaced(placed, dimension, bounds.get(dimension), null, new HashSet<>());
				}
			}
		}
		for (Map.Entry<String, String> noise : NOISE_DIMENSIONS.entrySet()) {
			Path file = data.resolve("worldgen/noise_settings/" + noise.getKey() + ".json");
			if (Files.isRegularFile(file)) scanBlocks(read(file), noise.getValue(), null, bounds.get(noise.getValue()), new HashSet<>());
		}
	}

	private Map<String, String> biomeDimensions() {
		Map<String, String> biomeDimensions = new HashMap<>();
		for (String dimension : List.of("overworld", "nether", "end")) {
			for (String biome : resolve("worldgen/biome", "minecraft:is_" + dimension)) biomeDimensions.put(shortId(biome), NOISE_DIMENSIONS.get(dimension));
		}
		return biomeDimensions;
	}

	/**
	 * Where each mob spawns naturally: the dimensions of the biomes whose spawners list it, plus "dimension structure"
	 * for structures whose spawn overrides list it (blazes spawn only in fortresses). Spawner blocks, summoning and
	 * structure-placed mobs are not covered.
	 */
	private void readSpawns() throws IOException {
		Map<String, String> biomeDimensions = biomeDimensions();
		Path biomes = data.resolve("worldgen/biome");
		for (Path file : jsonFiles(biomes)) {
			String dimension = biomeDimensions.get(relativeName(biomes, file));
			JsonObject biome = read(file);
			// 26.3 moved biome spawners into the natural_mob_spawns attribute.
			JsonObject attributes = biome.getAsJsonObject("attributes");
			JsonObject natural = attributes == null ? null : attributes.getAsJsonObject("minecraft:gameplay/natural_mob_spawns");
			JsonObject spawners = natural != null ? natural.getAsJsonObject("argument").getAsJsonObject("spawns_by_category") : biome.getAsJsonObject("spawners");
			if (dimension == null || spawners == null) continue;
			for (Map.Entry<String, JsonElement> category : spawners.entrySet()) {
				for (JsonElement row : category.getValue().getAsJsonArray()) addSpawn(row, dimension);
			}
		}
		Path structures = data.resolve("worldgen/structure");
		for (Path file : jsonFiles(structures)) {
			JsonObject structure = read(file);
			JsonObject overrides = structure.getAsJsonObject("spawn_overrides");
			if (overrides == null) continue;
			Set<String> dimensions = new TreeSet<>();
			for (String biome : biomeIds(structure.get("biomes"))) {
				String dimension = biomeDimensions.get(shortId(biome));
				if (dimension != null) dimensions.add(dimension);
			}
			for (Map.Entry<String, JsonElement> category : overrides.entrySet()) {
				for (JsonElement row : category.getValue().getAsJsonObject().getAsJsonArray("spawns")) {
					for (String dimension : dimensions) addSpawn(row, dimension + " " + relativeName(structures, file));
				}
			}
		}
	}

	private void addSpawn(JsonElement row, String place) {
		mobSpawns.computeIfAbsent(shortId(row.getAsJsonObject().get("type").getAsString()), mob -> new TreeSet<>()).add(place);
	}

	/** A holder set: a "#tag", one id, or a list of ids. */
	private Set<String> biomeIds(JsonElement biomes) {
		Set<String> ids = new TreeSet<>();
		if (biomes == null) return ids;
		if (biomes.isJsonArray()) {
			for (JsonElement biome : biomes.getAsJsonArray()) ids.add(biome.getAsString());
		} else if (biomes.getAsString().startsWith("#")) ids.addAll(resolve("worldgen/biome", biomes.getAsString().substring(1)));
		else ids.add(biomes.getAsString());
		return ids;
	}

	private void walkPlaced(JsonElement placed, String dimension, int[] bounds, int[] inheritedY, Set<String> visiting) throws IOException {
		JsonObject feature;
		if (placed.isJsonPrimitive()) {
			String id = shortId(placed.getAsString());
			Path file = data.resolve("worldgen/placed_feature/" + id + ".json");
			if (!Files.isRegularFile(file) || !visiting.add("placed:" + id)) return;
			feature = read(file);
		} else feature = placed.getAsJsonObject();
		int[] y = inheritedY;
		if (feature.has("placement")) {
			for (JsonElement modifier : feature.getAsJsonArray("placement")) {
				JsonObject object = modifier.getAsJsonObject();
				if ("height_range".equals(shortId(object.get("type").getAsString()))) y = heightRange(object.getAsJsonObject("height"), bounds);
			}
		}
		JsonElement configured = feature.get("feature");
		if (configured == null) return;
		if (configured.isJsonPrimitive()) {
			String id = shortId(configured.getAsString());
			// 26.3 renamed worldgen/configured_feature to worldgen/feature.
			Path file = data.resolve("worldgen/feature/" + id + ".json");
			if (!Files.isRegularFile(file) || !visiting.add("configured:" + id + ":" + java.util.Arrays.toString(y))) return;
			scanBlocks(read(file), dimension, y, bounds, visiting);
		} else scanBlocks(configured, dimension, y, bounds, visiting);
	}

	/** Every block state a feature can place, following nested placed features such as tree selectors and patches. */
	private void scanBlocks(JsonElement value, String dimension, int[] y, int[] bounds, Set<String> visiting) throws IOException {
		if (value.isJsonArray()) {
			for (JsonElement child : value.getAsJsonArray()) scanBlocks(child, dimension, y, bounds, visiting);
			return;
		}
		if (value.isJsonPrimitive()) {
			if (value.getAsJsonPrimitive().isString() && Files.isRegularFile(data.resolve("worldgen/placed_feature/" + shortId(value.getAsString()) + ".json"))) {
				walkPlaced(value, dimension, bounds, y, visiting);
			}
			return;
		}
		if (!value.isJsonObject()) return;
		JsonObject object = value.getAsJsonObject();
		if (object.has("feature") && object.has("placement")) {
			walkPlaced(object, dimension, bounds, y, visiting);
			return;
		}
		// 26.3 writes a block state as {"id", "properties"} or as a bare id string, where 26.1 wrote {"Name", "Properties"}.
		if (object.has("id") && object.get("id").isJsonPrimitive() && Set.of("id", "properties").containsAll(object.keySet())) {
			recordWorldgen(shortId(object.get("id").getAsString()), dimension, y);
			return;
		}
		for (Map.Entry<String, JsonElement> entry : object.entrySet()) {
			if ("Name".equals(entry.getKey()) && entry.getValue().isJsonPrimitive()) recordWorldgen(shortId(entry.getValue().getAsString()), dimension, y);
			else if (STATE_FIELDS.contains(entry.getKey()) && entry.getValue().isJsonPrimitive()) {
				recordWorldgen(shortId(entry.getValue().getAsString()), dimension, y);
				scanReference("block_state_provider", entry.getValue(), dimension, y, bounds, visiting);
			}
			else if (STATE_FIELDS.contains(entry.getKey()) && entry.getValue().isJsonArray()) {
				for (JsonElement state : entry.getValue().getAsJsonArray()) {
					if (state.isJsonPrimitive()) recordWorldgen(shortId(state.getAsString()), dimension, y);
					else scanBlocks(state, dimension, y, bounds, visiting);
				}
			}
			else if (RULE_FIELDS.contains(entry.getKey()) && entry.getValue().isJsonPrimitive()) scanReference("material_rule", entry.getValue(), dimension, y, bounds, visiting);
			else if (RULE_FIELDS.contains(entry.getKey()) && entry.getValue().isJsonArray()) {
				for (JsonElement rule : entry.getValue().getAsJsonArray()) {
					if (rule.isJsonPrimitive()) scanReference("material_rule", rule, dimension, y, bounds, visiting);
					else scanBlocks(rule, dimension, y, bounds, visiting);
				}
			}
			else scanBlocks(entry.getValue(), dimension, y, bounds, visiting);
		}
	}

	/** Surface-rule fields that may name another rule; 26.3 keeps state providers and surface rules in their own registries. */
	private static final Set<String> RULE_FIELDS = Set.of("material_rule", "then_run", "sequence");

	private void scanReference(String registry, JsonElement id, String dimension, int[] y, int[] bounds, Set<String> visiting) throws IOException {
		if (!id.getAsJsonPrimitive().isString() || !id.getAsString().contains(":")) return;
		Path file = data.resolve("worldgen/" + registry + "/" + shortId(id.getAsString()) + ".json");
		if (Files.isRegularFile(file) && visiting.add(registry + ":" + shortId(id.getAsString()) + ":" + java.util.Arrays.toString(y))) {
			scanBlocks(read(file), dimension, y, bounds, visiting);
		}
	}

	/** Feature fields whose bare id string is a placed block state (26.1 wrote these as {"Name"} objects), not a block test. */
	private static final Set<String> STATE_FIELDS = Set.of("result_state", "state", "data", "states", "default_block", "default_fluid",
			"high_states", "low_states", "decor_state", "hat_state", "stem_state", "valid_base_block", "inner_placements", "target",
			"contents", "rim", "default_state", "to_place", "state_provider", "foliage_provider", "trunk_provider", "cap_provider",
			"stem_provider", "source", "ground_state", "provider", "then", "barrier", "fluid", "above_root_provider", "muddy_roots_provider",
			"root_provider", "fallback", "block_provider", "alternate_inner_layer_provider", "filling_provider", "inner_layer_provider",
			"middle_layer_provider", "outer_layer_provider", "below_trunk_provider", "hanging_root_state_provider", "root_state_provider",
			"base_block", "pointed_block", "output_state");

	private void recordWorldgen(String block, String dimension, int[] y) {
		if (block.endsWith("air") || !BuiltInRegistries.BLOCK.containsKey(net.minecraft.resources.Identifier.parse("minecraft:" + block))) return;
		worldgenDimensions.computeIfAbsent(block, ignored -> new TreeSet<>()).add(dimension);
		if (y == null) {
			worldgenUnbounded.add(block);
			return;
		}
		// Each placement keeps its own band: iron, for example, peaks both deep underground and high in mountains.
		worldgenY.computeIfAbsent(block, ignored -> new TreeSet<>(HowtoIndexExporter::compareRanges)).add(y[2] == Integer.MIN_VALUE ? List.of(y[0], y[1]) : List.of(y[0], y[1], y[2]));
	}

	private static int compareRanges(List<Integer> left, List<Integer> right) {
		for (int i = 0; i < Math.min(left.size(), right.size()); i++) {
			int order = Integer.compare(left.get(i), right.get(i));
			if (order != 0) return order;
		}
		return Integer.compare(left.size(), right.size());
	}

	/** Absolute [min, max, peak] clipped to the dimension; peak is the trapezoid centre where ore is densest, else MIN_VALUE. */
	private static int[] heightRange(JsonObject height, int[] bounds) {
		String type = height.has("type") ? shortId(height.get("type").getAsString()) : "constant";
		if (!height.has("min_inclusive")) {
			int absolute = anchor(height.has("value") ? height.getAsJsonObject("value") : height, bounds);
			return new int[] {absolute, absolute, absolute};
		}
		int min = anchor(height.getAsJsonObject("min_inclusive"), bounds);
		int max = anchor(height.getAsJsonObject("max_inclusive"), bounds);
		int bottom = bounds[0], top = bounds[0] + bounds[1] - 1;
		int peak = "trapezoid".equals(type) && (!height.has("plateau") || height.get("plateau").getAsInt() == 0) ? Math.max(bottom, Math.min(top, Math.floorDiv(min + max, 2))) : Integer.MIN_VALUE;
		return new int[] {Math.max(bottom, min), Math.min(top, max), peak};
	}

	private static int anchor(JsonObject anchor, int[] bounds) {
		if (anchor.has("absolute")) return anchor.get("absolute").getAsInt();
		if (anchor.has("above_bottom")) return bounds[0] + anchor.get("above_bottom").getAsInt();
		if (anchor.has("below_top")) return bounds[0] + bounds[1] - 1 - anchor.get("below_top").getAsInt();
		return bounds[0];
	}

	// Files -----------------------------------------------------------------------------------------------

	private static List<Path> jsonFiles(Path root) throws IOException {
		if (!Files.isDirectory(root)) return List.of();
		try (Stream<Path> files = Files.walk(root)) {
			return files.filter(file -> file.toString().endsWith(".json")).sorted((a, b) -> a.toString().compareTo(b.toString())).toList();
		}
	}

	private static String relativeName(Path root, Path file) {
		String name = root.relativize(file).toString().replace('\\', '/');
		return name.substring(0, name.length() - ".json".length());
	}

	private static JsonObject read(Path file) throws IOException {
		return JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
	}

	private static String shortId(String id) {
		return id.startsWith("minecraft:") ? id.substring("minecraft:".length()) : id;
	}

	private static void writeAtomically(Path output, byte[] encoded) throws IOException {
		Files.createDirectories(output.getParent());
		Path temporary = Files.createTempFile(output.getParent(), "." + output.getFileName(), ".tmp");
		try {
			Files.write(temporary, encoded);
			try {
				Files.move(temporary, output, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
			} catch (java.nio.file.AtomicMoveNotSupportedException ignored) {
				Files.move(temporary, output, StandardCopyOption.REPLACE_EXISTING);
			}
		} finally {
			Files.deleteIfExists(temporary);
		}
	}
}
