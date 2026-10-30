package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.agaminggod.arenaagents.mixin.AbstractFurnaceBlockEntityAccessor;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.inventory.AbstractFurnaceMenu;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.entity.AbstractFurnaceBlockEntity;

/**
 * Remembers used furnaces without loading chunks. World reads run in transaction ticks and bridge endTick;
 * synchronization also protects the memory and cache when synthetic sources are sampled concurrently.
 */
public final class FurnaceMemory {
	private final Map<UUID, LinkedHashMap<Key, Entry>> players = new HashMap<>();
	// Shared across memory instances so replacing an executor cannot reuse an attention identity.
	private static final java.util.concurrent.atomic.AtomicLong SEQUENCE = new java.util.concurrent.atomic.AtomicLong(System.currentTimeMillis());
	static final int MAX_FURNACES = 8;
	static final long IDLE_TTL_MS = 60_000, UNLOADED_TTL_MS = 600_000;
	private final Map<UUID, Cached> cached = new HashMap<>();
	private record Cached(String dimension, long tick, JsonArray rows) { }

	record Key(String dimension, BlockPos position) { }
	public record Stack(String itemId, int count) {
		static Stack of(ItemStack stack) { return new Stack(BuiltInRegistries.ITEM.getKey(stack.getItem()).toString(), stack.getCount()); }
		JsonObject json() { JsonObject row = new JsonObject(); row.addProperty("itemId", itemId); row.addProperty("count", count); return row; }
	}
	public record Sample(Stack input, Stack fuel, Stack output, int burnTicks, int cookTicks, int cookTotalTicks, int fuelTicks, int outputCapacity, int resultCount) {
		public Sample(Stack input, Stack fuel, Stack output, int burnTicks, int cookTicks, int cookTotalTicks, int fuelTicks) {
			this(input, fuel, output, burnTicks, cookTicks, cookTotalTicks, fuelTicks, Math.max(0, 64 - output.count), 1);
		}
		public int readyCount() {
			if (cookTotalTicks <= 0) return 0;
			long fueled = (cookTicks + burnTicks + (long) fuel.count * fuelTicks) / cookTotalTicks;
			return (int) Math.min(input.count, Math.min(outputCapacity, fueled));
		}
		public Long partialReadyInMs() {
			int count = readyCount();
			return count == 0 ? null : Math.max(0, (long) count * cookTotalTicks - cookTicks) * 50;
		}
		public Long readyInMs() {
			if (input.count == 0) return 0L;
			return readyCount() == input.count ? partialReadyInMs() : null;
		}
		String stall() {
			if (input.count == 0 || cookTotalTicks <= 0) return "";
			if (outputCapacity == 0) return "output full";
			return burnTicks <= 0 && (fuel.count == 0 || fuelTicks == 0) ? "no fuel" : "";
		}
		String limit() {
			if (cookTotalTicks <= 0) return "no cooking recipe";
			return outputCapacity < input.count && readyCount() == outputCapacity ? "output full" : "out of fuel";
		}
	}
	public record Probe(boolean loaded, Sample sample) { }
	@FunctionalInterface public interface Source { Probe read(String dimension, BlockPos position); }
	private static final class Entry {
		Sample sample;
		long observedAt, lastWorkAt, readySequence, stalledSequence;
		String stall = "";
		boolean armed;
		Entry(Sample sample, long now) { this.sample = sample; observedAt = lastWorkAt = now; }
	}

	/** Vanilla burn ticks of a fuel: 26.3 moved fuel to the cooking_fuel item component, resolved by the furnace. */
	private static int burnDuration(net.minecraft.server.level.ServerLevel level, BlockPos position, ItemStack fuel) {
		return burnDuration(level, level.getBlockEntity(position) instanceof AbstractFurnaceBlockEntity furnace ? furnace : null, fuel);
	}

	private static int burnDuration(net.minecraft.server.level.ServerLevel level, AbstractFurnaceBlockEntity furnace, ItemStack fuel) {
		net.minecraft.world.item.component.CookingFuel component = fuel.get(net.minecraft.core.component.DataComponents.COOKING_FUEL);
		if (component == null) return 0;
		if (furnace != null) return ((AbstractFurnaceBlockEntityAccessor) furnace).arenaagents$burnDuration(level, fuel);
		return component.burnTime() instanceof net.minecraft.world.level.storage.loot.providers.number.ints.ResolvableInt.Constant constant ? constant.value() : 0;
	}

	public synchronized void remember(ServerPlayer player, BlockPos position, AbstractFurnaceMenu menu, boolean loaded) {
		int total = menu.getClass().getSimpleName().equals("FurnaceMenu") ? 200 : 100;
		Sample sample = new Sample(Stack.of(menu.getSlot(0).getItem()), Stack.of(menu.getSlot(1).getItem()), Stack.of(menu.getSlot(2).getItem()),
				0, Math.round(menu.getBurnProgress() * total), 0, burnDuration(player.level(), position, menu.getSlot(1).getItem()));
		Probe live = probe(player, player.level().dimension().identifier().toString(), position);
		if (live.sample != null) sample = live.sample;
		remember(player.getUUID(), player.level().dimension().identifier().toString(), position, sample, loaded, System.currentTimeMillis());
	}

	public synchronized void remember(UUID player, String dimension, BlockPos position, Sample sample, boolean loaded, long now) {
		cached.remove(player);
		LinkedHashMap<Key, Entry> entries = players.computeIfAbsent(player, ignored -> new LinkedHashMap<>());
		Key key = new Key(dimension, position.immutable());
		Entry entry = entries.remove(key);
		if (entry == null) entry = new Entry(sample, now);
		entries.put(key, entry);
		while (entries.size() > MAX_FURNACES) entries.remove(entries.keySet().iterator().next());
		entry.sample = sample;
		entry.observedAt = entry.lastWorkAt = now;
		if (loaded) { entry.armed = sample.input.count > 0; entry.readySequence = 0; }
		if (sample.output.count == 0) entry.readySequence = 0;
	}

	private static Probe probe(ServerPlayer player, String dimension, BlockPos position) {
		if (!player.level().dimension().identifier().toString().equals(dimension) || !player.level().hasChunkAt(position)) return new Probe(false, null);
		if (!(player.level().getBlockEntity(position) instanceof AbstractFurnaceBlockEntity furnace)) return new Probe(true, null);
		if (!(furnace instanceof AbstractFurnaceBlockEntityAccessor access)) return new Probe(false, null);
		var data = access.arenaagents$getFurnaceData();
		net.minecraft.world.item.crafting.RecipeType<? extends net.minecraft.world.item.crafting.AbstractCookingRecipe> type =
				furnace instanceof net.minecraft.world.level.block.entity.BlastFurnaceBlockEntity ? net.minecraft.world.item.crafting.RecipeType.BLASTING
				: furnace instanceof net.minecraft.world.level.block.entity.SmokerBlockEntity ? net.minecraft.world.item.crafting.RecipeType.SMOKING
				: net.minecraft.world.item.crafting.RecipeType.SMELTING;
		var input = new net.minecraft.world.item.crafting.SingleRecipeInput(furnace.getItem(0));
		var recipe = player.level().recipeAccess().getRecipeFor(type, input, player.level());
		int outputCapacity = 0, resultCount = 1;
		if (recipe.isPresent()) {
			ItemStack result = recipe.get().value().assemble(input);
			ItemStack output = furnace.getItem(2);
			if (!result.isEmpty()) {
				resultCount = result.getCount();
				if (output.isEmpty() || ItemStack.isSameItemSameComponents(output, result))
					outputCapacity = Math.max(0, (Math.min(furnace.getMaxStackSize(), result.getMaxStackSize()) - output.getCount()) / resultCount);
			}
		}
		return new Probe(true, new Sample(Stack.of(furnace.getItem(0)), Stack.of(furnace.getItem(1)), Stack.of(furnace.getItem(2)),
				data.get(0), data.get(2), recipe.isPresent() ? data.get(3) : 0, burnDuration(player.level(), furnace, furnace.getItem(1)), outputCapacity, resultCount));
	}

	public synchronized JsonArray sample(ServerPlayer player) {
		long tick = player.level().getGameTime();
		String dimension = player.level().dimension().identifier().toString();
		Cached previous = cached.get(player.getUUID());
		if (previous != null && previous.tick == tick && previous.dimension.equals(dimension)) return previous.rows.deepCopy();
		JsonArray rows = sample(player.getUUID(), (rememberedDimension, position) -> probe(player, rememberedDimension, position), System.currentTimeMillis());
		if (!rows.isEmpty()) cached.put(player.getUUID(), new Cached(dimension, tick, rows.deepCopy()));
		return rows;
	}

	public synchronized JsonArray sample(UUID player, Source source, long now) {
		JsonArray rows = new JsonArray();
		LinkedHashMap<Key, Entry> entries = players.get(player);
		if (entries == null) return rows;
		var iterator = entries.reversed().entrySet().iterator();
		while (iterator.hasNext()) {
			var item = iterator.next();
			Key key = item.getKey(); Entry entry = item.getValue();
			Probe probe = source.read(key.dimension, key.position);
			if (probe.loaded && probe.sample == null) { iterator.remove(); continue; }
			if (!probe.loaded && now - entry.observedAt >= UNLOADED_TTL_MS) { iterator.remove(); continue; }
			if (probe.loaded && probe.sample != null) {
				entry.sample = probe.sample; entry.observedAt = now;
				if (entry.sample.input.count > 0 || entry.sample.output.count > 0) entry.lastWorkAt = now;
				else if (now - entry.lastWorkAt >= IDLE_TTL_MS) { iterator.remove(); continue; }
				String stall = entry.sample.stall();
				if (!stall.equals(entry.stall)) {
					entry.stall = stall;
					entry.stalledSequence = stall.isEmpty() ? 0 : SEQUENCE.incrementAndGet();
				}
				if (entry.sample.output.count == 0) entry.readySequence = 0;
				if (entry.armed && entry.sample.input.count == 0) {
					if (entry.sample.output.count > 0) entry.readySequence = SEQUENCE.incrementAndGet();
					entry.armed = false;
				}
			}
			Sample sample = entry.sample;
			JsonObject row = new JsonObject();
			row.addProperty("dimension", key.dimension);
			row.addProperty("x", key.position.getX()); row.addProperty("y", key.position.getY()); row.addProperty("z", key.position.getZ());
			row.addProperty("state", probe.loaded ? "loaded" : "estimate");
			row.add("input", sample.input.json()); row.add("fuel", sample.fuel.json()); row.add("output", sample.output.json());
			row.addProperty("observedAtEpochMs", entry.observedAt);
			Long readyIn = sample.readyInMs();
			if (readyIn != null) row.addProperty("estimatedReadyAtEpochMs", entry.observedAt + readyIn);
			else {
				Long partial = sample.partialReadyInMs();
				if (partial != null) {
					row.addProperty("estimatedReadyAtEpochMs", entry.observedAt + partial);
					row.addProperty("estimatedReadyCount", sample.readyCount() * sample.resultCount);
				}
				row.addProperty("estimate", (partial == null ? "No additional output can finish: " + sample.limit()
						: sample.readyCount() * sample.resultCount + " additional output ready by " + (entry.observedAt + partial) + ", then " + sample.limit()));
			}
			if (entry.stalledSequence > 0) {
				row.addProperty("stalledSequence", entry.stalledSequence);
				row.addProperty("message", "furnace at " + key.position.getX() + "," + key.position.getY() + "," + key.position.getZ() + ": stalled: " + entry.stall);
			}
			if (entry.readySequence > 0) {
				row.addProperty("readySequence", entry.readySequence);
				row.addProperty("message", "furnace at " + key.position.getX() + "," + key.position.getY() + "," + key.position.getZ()
						+ ": " + sample.output.count + " " + sample.output.itemId + " ready");
			}
			rows.add(row);
		}
		if (entries.isEmpty()) { players.remove(player); cached.remove(player); }
		return rows;
	}

	/** Stable completion identities survive quiet resampling and failed observation publication. */
	public static java.util.Set<String> readyFacts(JsonObject observation) {
		java.util.Set<String> facts = new java.util.TreeSet<>();
		if (observation.has("furnaces")) for (var value : observation.getAsJsonArray("furnaces")) {
			JsonObject row = value.getAsJsonObject();
			for (String event : java.util.List.of("readySequence", "stalledSequence"))
				if (row.has(event)) facts.add("furnace." + row.get("dimension").getAsString() + ":"
						+ row.get("x") + "," + row.get("y") + "," + row.get("z") + ":" + event + ":" + row.get(event));
		}
		return facts;
	}
}
