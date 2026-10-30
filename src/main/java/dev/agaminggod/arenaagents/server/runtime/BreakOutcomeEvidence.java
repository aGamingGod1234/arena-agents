package dev.agaminggod.arenaagents.server.runtime;

import dev.agaminggod.arenaagents.server.perception.ObservationVisibility;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;

/** Break-time hand and visible drop evidence, never a loot-table prediction or a tool selection. */
public final class BreakOutcomeEvidence {
	private BreakOutcomeEvidence() {
	}

	/**
	 * {@code itemId} is null for an empty hand. {@code required} is vanilla's tool rule for the block, such as
	 * "stone+ pickaxe", named only when the hand lacks it and the block's tags state it; otherwise null.
	 */
	public record Tool(String itemId, boolean missingCorrectTool, String required) {
		public Tool(String itemId, boolean missingCorrectTool) {
			this(itemId, missingCorrectTool, null);
		}

		String item() {
			if (itemId == null) return "hand";
			return itemId.startsWith("minecraft:") ? itemId.substring("minecraft:".length()) : itemId;
		}

		String note() {
			return "with " + item() + (missingCorrectTool ? "; " + missingNote(required) : "");
		}
	}

	static String missingNote(String required) {
		return "no block drops without correct tool/tier" + (required == null ? "" : ", needs " + required);
	}

	/** Vanilla's harvest requirement as its block tags state it; null when no tool is required or no tool tag names one. */
	static String requiredTool(BlockState state) {
		if (!state.requiresCorrectToolForDrops()) return null;
		return requiredTool(state.getBlock().builtInRegistryHolder().tags()
				.map(tag -> tag.location().toString()).collect(java.util.stream.Collectors.toSet()));
	}

	static String requiredTool(java.util.Set<String> tags) {
		String kind = null;
		for (String candidate : new String[] { "pickaxe", "axe", "shovel", "hoe" }) {
			if (tags.contains("minecraft:mineable/" + candidate)) {
				kind = candidate;
				break;
			}
		}
		if (kind == null) return null;
		String tier = tags.contains("minecraft:needs_diamond_tool") ? "diamond+ "
				: tags.contains("minecraft:needs_iron_tool") ? "iron+ "
				: tags.contains("minecraft:needs_stone_tool") ? "stone+ " : "any ";
		return tier + kind;
	}

	/**
	 * One completed break: the hand at removal time, whether a new visible drop appeared, and the items of new drops the
	 * inventory had no room for at that moment (they stay on the ground, as a player sees).
	 */
	public record Outcome(Tool tool, boolean dropsSeen, List<String> noRoom) {
		public Outcome {
			noRoom = noRoom == null ? List.of() : List.copyOf(noRoom);
		}

		public Outcome(Tool tool, boolean dropsSeen) {
			this(tool, dropsSeen, List.of());
		}
	}

	/**
	 * The structured counterpart of the result text, for programs and scripts: blocks this action broke (0 when the break
	 * did not complete), the hand of the latest break or attempt, whether any lacked the correct tool, whether any showed no drops,
	 * and whether the hand differs between breaks or from the hand at the result (a tool used up or swapped). handChanged is
	 * null only for a result journalled before that fact existed: unknown, never assumed.
	 */
	public record Summary(int blocks, String heldItemId, boolean correctTool, boolean noDropsSeen, Boolean handChanged) {
		public Summary {
			if (blocks < 0) throw new IllegalArgumentException("blocks must be non-negative");
			if (blocks == 0 && noDropsSeen) throw new IllegalArgumentException("noDropsSeen requires a broken block");
		}
	}

	/** Vanilla's own harvest check, the one destroyBlock uses, so data-driven tool components and mod hooks decide. */
	static Tool tool(ServerPlayer player, BlockState state) {
		boolean missing = !player.isCreative() && !player.hasCorrectToolForDrops(state);
		return new Tool(itemId(player.getMainHandItem()), missing, missing ? requiredTool(state) : null);
	}

	/** The same rule on a bare stack, for verification without a player. */
	static Tool tool(ItemStack held, BlockState state, boolean creative) {
		boolean missing = !creative && state.requiresCorrectToolForDrops() && !held.isCorrectToolForDrops(state);
		return new Tool(itemId(held), missing, missing ? requiredTool(state) : null);
	}

	static String itemId(ItemStack held) {
		return held.isEmpty() ? null : BuiltInRegistries.ITEM.getKey(held.getItem()).toString();
	}

	/** Every item already in the box counts as present, seen or not, so one hidden behind the target is never a new drop. */
	public record Snapshot(Tool tool, Map<UUID, Integer> before) {
		public Outcome after(ServerPlayer player, BlockPos position) {
			Map<UUID, Integer> visible = new HashMap<>();
			TreeSet<String> noRoom = new TreeSet<>();
			var view = ObservationVisibility.frame(player.level(), player);
			for (ItemEntity item : nearbyItems(player, position)) {
				if (!view.canSeeEntity(item)) continue;
				visible.put(item.getUUID(), item.getItem().getCount());
				if (item.getItem().getCount() > before.getOrDefault(item.getUUID(), 0)
						&& !InventoryRoom.canTake(player, item.getItem())) noRoom.add(InventoryRoom.itemName(item.getItem()));
			}
			return new Outcome(tool, dropsSeen(before, visible), List.copyOf(noRoom));
		}
	}

	public static Snapshot capture(ServerPlayer player, BlockPos position, BlockState state) {
		Map<UUID, Integer> present = new HashMap<>();
		for (ItemEntity item : nearbyItems(player, position)) present.put(item.getUUID(), item.getItem().getCount());
		return new Snapshot(tool(player, state), present);
	}

	static boolean dropsSeen(Map<UUID, Integer> before, Map<UUID, Integer> visibleAfter) {
		return visibleAfter.entrySet().stream().anyMatch(entry -> entry.getValue() > before.getOrDefault(entry.getKey(), 0));
	}

	/** Result text for one break_block: the held item is left out when the speed advice already names it. */
	static String note(Outcome outcome, boolean heldNamedElsewhere) {
		StringBuilder text = new StringBuilder();
		if (!heldNamedElsewhere) text.append("with ").append(outcome.tool().item()).append("; ");
		if (outcome.tool().missingCorrectTool()) text.append(missingNote(outcome.tool().required())).append("; ");
		return text.append(outcome.dropsSeen() ? "drops seen" : "no drops seen").append(noRoomNote(outcome.noRoom())).toString();
	}

	static String noRoomNote(java.util.Collection<String> items) {
		return items.isEmpty() ? "" : "; no inventory room for " + String.join(", ", items);
	}

	/** Breaks completed during one action, grouped by the hand each break was made with. */
	static final class Tally {
		private final Map<String, Group> groups = new java.util.LinkedHashMap<>();
		private final TreeSet<String> noRoom = new TreeSet<>();
		private int blocks;
		private Tool latest;

		private static final class Group {
			private final String item;
			private int blocks;
			private int missingTool;
			private int noDrops;
			private String required;
			private boolean requiredSeen;

			Group(String item) {
				this.item = item;
			}
		}

		void add(Outcome outcome) {
			Group group = groups.computeIfAbsent(String.valueOf(outcome.tool().itemId()), key -> new Group(outcome.tool().item()));
			blocks++;
			group.blocks++;
			if (outcome.tool().missingCorrectTool()) {
				group.missingTool++;
				String required = outcome.tool().required();
				// Breaks with different requirements name none, rather than one that is wrong for some of them.
				if (!group.requiredSeen) group.required = required;
				else if (!java.util.Objects.equals(group.required, required)) group.required = null;
				group.requiredSeen = true;
			}
			if (!outcome.dropsSeen()) group.noDrops++;
			noRoom.addAll(outcome.noRoom());
			latest = outcome.tool();
		}

		boolean isEmpty() {
			return blocks == 0;
		}

		/**
		 * One hand: "; broke 3 blocks with hand; no block drops without correct tool/tier (2); no drops seen (2)".
		 * Several hands: "; broke 2 blocks: 1 with hand (no block drops without correct tool/tier; no drops seen), 1 with
		 * diamond_pickaxe (drops seen)". Empty without breaks.
		 */
		String note() {
			if (blocks == 0) return "";
			StringBuilder text = new StringBuilder("; broke ").append(blocks).append(blocks == 1 ? " block" : " blocks");
			if (groups.size() == 1) {
				Group only = groups.values().iterator().next();
				text.append(" with ").append(only.item);
				if (only.missingTool > 0) text.append("; ").append(missingNote(only.required)).append(count(only.missingTool, only.blocks, " (", ")"));
				return text.append(only.noDrops == 0 ? "; drops seen" : "; no drops seen" + count(only.noDrops, only.blocks, " (", ")"))
						.append(noRoomNote(noRoom)).toString();
			}
			String separator = ": ";
			for (Group group : groups.values()) {
				text.append(separator).append(group.blocks).append(" with ").append(group.item).append(" (");
				if (group.missingTool > 0) text.append(missingNote(group.required)).append(count(group.missingTool, group.blocks, " for ", "")).append("; ");
				text.append(group.noDrops == 0 ? "drops seen" : "no drops seen" + count(group.noDrops, group.blocks, " for ", "")).append(')');
				separator = ", ";
			}
			return text.append(noRoomNote(noRoom)).toString();
		}

		/** {@code currentItemId} is the main hand when the result is built, null when empty. */
		Summary summary(String currentItemId) {
			if (blocks == 0) return null;
			boolean missing = groups.values().stream().anyMatch(group -> group.missingTool > 0);
			boolean noDrops = groups.values().stream().anyMatch(group -> group.noDrops > 0);
			return new Summary(blocks, latest.itemId(), !missing, noDrops,
					groups.size() > 1 || !java.util.Objects.equals(currentItemId, latest.itemId()));
		}

		private static String count(int matching, int total, String open, String close) {
			return matching == total ? "" : open + matching + close;
		}
	}

	private static Iterable<ItemEntity> nearbyItems(ServerPlayer player, BlockPos position) {
		return player.level().getEntitiesOfClass(ItemEntity.class, new AABB(position).inflate(1.0D), item -> !item.getItem().isEmpty());
	}
}
