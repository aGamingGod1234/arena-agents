package dev.agaminggod.arenaagents.server.runtime;

import java.util.Map;
import java.util.UUID;

public final class BreakOutcomeEvidenceVerification {
	private BreakOutcomeEvidenceVerification() {
	}

	public static int verify() {
		var hand = new BreakOutcomeEvidence.Tool(null, true);
		var pick = new BreakOutcomeEvidence.Tool("minecraft:stone_pickaxe", false);
		UUID drop = UUID.randomUUID();
		check("with hand; no block drops without correct tool/tier; no drops seen",
				BreakOutcomeEvidence.note(new BreakOutcomeEvidence.Outcome(hand, false), false));
		check("no block drops without correct tool/tier; no drops seen",
				BreakOutcomeEvidence.note(new BreakOutcomeEvidence.Outcome(hand, false), true));
		check("with stone_pickaxe; drops seen", BreakOutcomeEvidence.note(new BreakOutcomeEvidence.Outcome(pick, true), false));
		check("drops seen", BreakOutcomeEvidence.note(new BreakOutcomeEvidence.Outcome(pick, true), true));
		check("with mod:custom_tool; no drops seen", BreakOutcomeEvidence.note(
				new BreakOutcomeEvidence.Outcome(new BreakOutcomeEvidence.Tool("mod:custom_tool", false), false), false));
		check("attempted with hand; no block drops without correct tool/tier", "attempted " + hand.note());

		check(true, BreakOutcomeEvidence.dropsSeen(Map.of(), Map.of(drop, 1)), "a new visible item is a drop");
		check(false, BreakOutcomeEvidence.dropsSeen(Map.of(drop, 2), Map.of(drop, 2)), "an unchanged stack is not a drop");
		check(true, BreakOutcomeEvidence.dropsSeen(Map.of(drop, 2), Map.of(drop, 3)), "a grown stack is a drop");
		check(false, BreakOutcomeEvidence.dropsSeen(Map.of(drop, 2), Map.of()), "a vanished stack is not a drop");
		// An item hidden behind the target is recorded before removal, so seeing it afterwards is not a new drop.
		check(false, BreakOutcomeEvidence.dropsSeen(Map.of(drop, 1), Map.of(drop, 1)), "a previously hidden item is not a drop");

		var single = new BreakOutcomeEvidence.Tally();
		check("", single.note());
		check(true, single.summary(null) == null, "no break, no summary");
		single.add(new BreakOutcomeEvidence.Outcome(hand, false));
		check("; broke 1 block with hand; no block drops without correct tool/tier; no drops seen", single.note());
		check(true, new BreakOutcomeEvidence.Summary(1, null, false, true, false).equals(single.summary(null)), "one bare-hand stone break");

		var mixed = new BreakOutcomeEvidence.Tally();
		mixed.add(new BreakOutcomeEvidence.Outcome(hand, false));
		mixed.add(new BreakOutcomeEvidence.Outcome(new BreakOutcomeEvidence.Tool(null, false), true));
		mixed.add(new BreakOutcomeEvidence.Outcome(new BreakOutcomeEvidence.Tool(null, false), true));
		check("; broke 3 blocks with hand; no block drops without correct tool/tier (1); no drops seen (1)", mixed.note());
		check(true, new BreakOutcomeEvidence.Summary(3, null, false, true, false).equals(mixed.summary(null)), "any miss is reported");

		var clean = new BreakOutcomeEvidence.Tally();
		clean.add(new BreakOutcomeEvidence.Outcome(pick, true));
		check("; broke 1 block with stone_pickaxe; drops seen", clean.note());
		check(true, new BreakOutcomeEvidence.Summary(1, "minecraft:stone_pickaxe", true, false, false).equals(clean.summary("minecraft:stone_pickaxe")), "a normal break");

		// A tool used up on removal: the break names it, and the summary says the hand changed since.
		var wornOut = new BreakOutcomeEvidence.Tally();
		wornOut.add(new BreakOutcomeEvidence.Outcome(new BreakOutcomeEvidence.Tool("minecraft:wooden_pickaxe", false), true));
		check("; broke 1 block with wooden_pickaxe; drops seen", wornOut.note());
		check(true, new BreakOutcomeEvidence.Summary(1, "minecraft:wooden_pickaxe", true, false, true).equals(wornOut.summary(null)), "tool gone after the break");

		// Each break keeps its own hand: an empty-hand dirt break then a diamond pickaxe stone break.
		var diamond = new BreakOutcomeEvidence.Tool("minecraft:diamond_pickaxe", false);
		var slots = new BreakOutcomeEvidence.Tally();
		slots.add(new BreakOutcomeEvidence.Outcome(new BreakOutcomeEvidence.Tool(null, false), true));
		slots.add(new BreakOutcomeEvidence.Outcome(diamond, true));
		check("; broke 2 blocks: 1 with hand (drops seen), 1 with diamond_pickaxe (drops seen)", slots.note());
		check(true, new BreakOutcomeEvidence.Summary(2, "minecraft:diamond_pickaxe", true, false, true).equals(slots.summary("minecraft:diamond_pickaxe")),
				"mixed hands are a hand change even when the last hand is still held");
		var slotsMissing = new BreakOutcomeEvidence.Tally();
		slotsMissing.add(new BreakOutcomeEvidence.Outcome(hand, false));
		slotsMissing.add(new BreakOutcomeEvidence.Outcome(new BreakOutcomeEvidence.Tool(null, false), true));
		slotsMissing.add(new BreakOutcomeEvidence.Outcome(diamond, true));
		check("; broke 3 blocks: 2 with hand (no block drops without correct tool/tier for 1; no drops seen for 1), 1 with diamond_pickaxe (drops seen)",
				slotsMissing.note());

		// The requirement comes from vanilla's block tags: tool kind from mineable/*, tier from needs_*_tool.
		check("stone+ pickaxe", BreakOutcomeEvidence.requiredTool(java.util.Set.of("minecraft:mineable/pickaxe", "minecraft:needs_stone_tool")));
		check("iron+ pickaxe", BreakOutcomeEvidence.requiredTool(java.util.Set.of("minecraft:mineable/pickaxe", "minecraft:needs_iron_tool")));
		check("diamond+ pickaxe", BreakOutcomeEvidence.requiredTool(java.util.Set.of("minecraft:mineable/pickaxe", "minecraft:needs_diamond_tool")));
		check("any pickaxe", BreakOutcomeEvidence.requiredTool(java.util.Set.of("minecraft:mineable/pickaxe")));
		check(true, BreakOutcomeEvidence.requiredTool(java.util.Set.of("minecraft:needs_stone_tool")) == null, "no tool kind, no requirement named");
		var bareStone = new BreakOutcomeEvidence.Tool(null, true, "any pickaxe");
		check("with hand; no block drops without correct tool/tier, needs any pickaxe; no drops seen",
				BreakOutcomeEvidence.note(new BreakOutcomeEvidence.Outcome(bareStone, false), false));
		var ironOre = new BreakOutcomeEvidence.Tool("minecraft:wooden_pickaxe", true, "stone+ pickaxe");
		var named = new BreakOutcomeEvidence.Tally();
		named.add(new BreakOutcomeEvidence.Outcome(ironOre, false));
		named.add(new BreakOutcomeEvidence.Outcome(ironOre, false));
		check("; broke 2 blocks with wooden_pickaxe; no block drops without correct tool/tier, needs stone+ pickaxe; no drops seen", named.note());
		var differing = new BreakOutcomeEvidence.Tally();
		differing.add(new BreakOutcomeEvidence.Outcome(ironOre, false));
		differing.add(new BreakOutcomeEvidence.Outcome(new BreakOutcomeEvidence.Tool("minecraft:wooden_pickaxe", true, "iron+ pickaxe"), false));
		check("; broke 2 blocks with wooden_pickaxe; no block drops without correct tool/tier; no drops seen", differing.note());

		boolean rejected = false;
		try {
			new BreakOutcomeEvidence.Summary(0, null, true, true, false);
		} catch (IllegalArgumentException expected) {
			rejected = true;
		}
		check(true, rejected, "no drops seen needs a broken block");

		// A full inventory: the drop is seen and stays on the ground, and the result names its item.
		check("drops seen; no inventory room for cobblestone",
				BreakOutcomeEvidence.note(new BreakOutcomeEvidence.Outcome(pick, true, java.util.List.of("cobblestone")), true));
		check(true, new BreakOutcomeEvidence.Outcome(pick, true, null).noRoom().isEmpty(), "no list means every drop fit");
		var full = new BreakOutcomeEvidence.Tally();
		full.add(new BreakOutcomeEvidence.Outcome(pick, true, java.util.List.of("cobblestone")));
		full.add(new BreakOutcomeEvidence.Outcome(pick, true, java.util.List.of("raw_iron", "cobblestone")));
		full.add(new BreakOutcomeEvidence.Outcome(pick, true));
		check("; broke 3 blocks with stone_pickaxe; drops seen; no inventory room for cobblestone, raw_iron", full.note());
		var fullMixed = new BreakOutcomeEvidence.Tally();
		fullMixed.add(new BreakOutcomeEvidence.Outcome(new BreakOutcomeEvidence.Tool(null, false), true, java.util.List.of("dirt")));
		fullMixed.add(new BreakOutcomeEvidence.Outcome(diamond, true));
		check("; broke 2 blocks: 1 with hand (drops seen), 1 with diamond_pickaxe (drops seen); no inventory room for dirt", fullMixed.note());
		check(true, new BreakOutcomeEvidence.Summary(3, "minecraft:stone_pickaxe", true, false, false).equals(full.summary("minecraft:stone_pickaxe")),
				"the journalled summary keeps its typed fields");
		check("No inventory room for oak_log: no empty slot and no oak_log stack with room; the drop stays on the ground",
				InventoryRoom.noRoomMessage("oak_log"));

		// Vanilla Inventory#add parity: a stack with room (held or offhand slot included) or an empty main slot takes the
		// pickup; a creative player (infinite materials) always does and the drop is consumed; only a full survival
		// inventory leaves it on the ground.
		java.util.function.IntSupplier none = () -> -1;
		check(false, InventoryRoom.canTake(false, none, none), "full survival inventory leaves the drop");
		check(true, InventoryRoom.canTake(false, () -> 40, none), "a partial offhand stack takes the pickup");
		check(true, InventoryRoom.canTake(false, () -> 7, none), "a partial held stack takes the pickup");
		check(true, InventoryRoom.canTake(false, none, () -> 12), "an empty main slot takes the pickup");
		check(true, InventoryRoom.canTake(true, () -> { throw new AssertionError("creative needs no slot search"); },
				() -> { throw new AssertionError("creative needs no slot search"); }), "a full creative inventory still accepts the pickup");
		return 43;
	}

	private static void check(String expected, String actual) {
		if (!expected.equals(actual)) throw new AssertionError("Expected " + expected + ", got " + actual);
	}

	private static void check(boolean expected, boolean actual, String message) {
		if (expected != actual) throw new AssertionError(message);
	}
}
