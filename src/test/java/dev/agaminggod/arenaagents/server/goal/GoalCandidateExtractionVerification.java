package dev.agaminggod.arenaagents.server.goal;

import com.google.gson.JsonParser;
import dev.agaminggod.arenaagents.agent.AgentDomainException;
import dev.agaminggod.arenaagents.agent.goal.GoalPredicate;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import net.minecraft.core.RegistryAccess;

/** Regression coverage uses the actual ladder requests, including every list noun. */
public final class GoalCandidateExtractionVerification {
	private static final RegistryAccess REGISTRIES = RegistryAccess.EMPTY;
	private static final GoalCompiler COMPILER = new GoalCompiler();
	private static int checks;

	private GoalCandidateExtractionVerification() { }

	public static int verify() {
		int before = checks;
		verifyLadderCandidates();
		verifyListsAndQuantities();
		verifyDimensionEntries();
		verifyStructureEntries();
		return checks - before;
	}

	private static void verifyLadderCandidates() {
		Map<String, List<String>> expected = Map.ofEntries(
				Map.entry("L-A1", ids("wooden_pickaxe", "stone_pickaxe")),
				Map.entry("L-A1b", ids("stone_axe", "stone_sword", "furnace")),
				Map.entry("L-A2", ids("iron_ingot")), Map.entry("L-A2b", ids("iron_ingot")),
				Map.entry("L-A3", ids("iron_pickaxe", "bucket", "shield", "flint_and_steel")),
				Map.entry("L-A3b", ids("iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots", "iron_sword")),
				Map.entry("L-A4", ids("cooked_beef", "cooked_porkchop")),
				Map.entry("L-A5", ids("story/enter_the_nether")), Map.entry("L-A5b", ids("story/enter_the_nether")),
				Map.entry("L-A6", List.of()), Map.entry("L-B1", ids("nether/find_bastion", "nether/find_fortress")),
				Map.entry("L-B2", ids("golden_helmet")), Map.entry("L-B3", ids("gold_ingot")),
				Map.entry("L-C1", ids("ender_pearl")), Map.entry("L-C2", ids("ender_pearl")), Map.entry("L-C3", ids("ender_pearl")),
				Map.entry("L-D1", ids("blaze_rod")), Map.entry("L-E1", ids("ender_eye")),
				Map.entry("L-E2", List.of()), Map.entry("L-F1", ids("story/follow_ender_eye")),
				Map.entry("L-G1", ids("story/enter_the_end")), Map.entry("L-H0", List.of()), Map.entry("L-H1", ids("ender_dragon")));
		try {
			var scenarios = JsonParser.parseString(Files.readString(Path.of("scripts/quality/ladder.json")))
					.getAsJsonObject().getAsJsonArray("scenarios");
			check(scenarios.size() == expected.size(), "every ladder goal has explicit candidate expectations");
			for (var entry : scenarios) {
				var scenario = entry.getAsJsonObject();
				String id = scenario.get("id").getAsString(), request = scenario.get("goal").getAsString();
				var candidates = COMPILER.candidateIdsFor(request, REGISTRIES);
				check(candidates.containsAll(expected.get(id)), id + " retains every requested registry noun: " + candidates);
				check(candidates.equals(new TreeSet<>(candidates).stream().toList()) && candidates.size() <= 64,
						id + " has a sorted, distinct, bounded catalog");
				if (expected.get(id).isEmpty()) check(candidates.isEmpty(), id + " does not invent item identifiers");
				else if (!id.equals("L-E1") && !id.equals("L-A4")) {
					GoalPredicate predicate = COMPILER.compile(request, REGISTRIES, 100).acceptedSpec().orElseThrow().completion();
					COMPILER.translationConstraintFor(request, REGISTRIES).validate(predicate); checks++;
					check(!COMPILER.translationRequiresOperatorConfirmation(request, REGISTRIES), id + " completes factually");
				}
			}
		} catch (java.io.IOException exception) {
			throw new AssertionError("Could not read ladder regression requests", exception);
		}
		String food = "Get at least 20 cooked beef or cooked porkchops in total.";
		var mixedFood = new GoalPredicate.InventoryContainsAny(ids("cooked_beef", "cooked_porkchop"), 20);
		COMPILER.translationConstraintFor(food, REGISTRIES).validate(mixedFood); checks++;
		reject(() -> COMPILER.translationConstraintFor(food, REGISTRIES).validate(
				new GoalPredicate.InventoryContainsAny(mixedFood.itemIds(), 19)), "mixed food preserves the total quantity");
		check(!COMPILER.translationRequiresOperatorConfirmation(food, REGISTRIES), "mixed food is factual");
	}

	private static void verifyListsAndQuantities() {
		for (String request : List.of(
				"Get a stone axe, a stone sword and a furnace.",
				"Get the stone axe, the stone sword, and the furnace.",
				"Get stone axes, stone swords, furnaces.",
				"Collect a stone axe and a stone sword and a furnace.")) {
			var predicate = COMPILER.compile(request, REGISTRIES, 100).acceptedSpec().orElseThrow().completion();
			check(predicate.equals(new GoalPredicate.AllOf(List.of(
					new GoalPredicate.InventoryContains("minecraft:stone_axe", 1),
					new GoalPredicate.InventoryContains("minecraft:stone_sword", 1),
					new GoalPredicate.InventoryContains("minecraft:furnace", 1)))), "all noun-list variants compile: " + request);
		}
		for (String request : List.of("Get flint and steel.", "Get the flint and steel.",
				"Get a flint and steel.", "Get minecraft:flint_and_steel.")) {
			check(COMPILER.candidateIdsFor(request, REGISTRIES).equals(ids("flint_and_steel")), "one lexical item: " + request);
			check(COMPILER.compile(request, REGISTRIES, 100).acceptedSpec().orElseThrow().completion()
					.equals(new GoalPredicate.InventoryContains("minecraft:flint_and_steel", 1)), "lexical conjunction is not a list");
		}
		String counted = "Get 20 cooked beef, 2 buckets, and an iron pickaxe and flint and steel.";
		GoalPredicate predicate = COMPILER.compile(counted, REGISTRIES, 100).acceptedSpec().orElseThrow().completion();
		var constraint = COMPILER.translationConstraintFor(counted, REGISTRIES);
		constraint.requireCatalog(COMPILER.candidateIdsFor(counted, REGISTRIES)); checks++;
		constraint.validate(predicate); checks++;
		check(((GoalPredicate.AllOf) predicate).predicates().getFirst().equals(
				new GoalPredicate.InventoryContains("minecraft:cooked_beef", 20)), "count belongs to its noun");
		reject(() -> constraint.validate(new GoalPredicate.InventoryContains("minecraft:flint_and_steel", 1)),
				"the last noun alone cannot satisfy a multi-item request");
		reject(() -> constraint.validate(new GoalPredicate.OperatorConfirmed()), "confirmation cannot replace known items");
		String entities = "Kill a zombie, a skeleton, and an enderman.";
		check(COMPILER.candidateIdsFor(entities, REGISTRIES).containsAll(ids("zombie", "skeleton", "enderman")),
				"entity lists retain every noun");
		check(COMPILER.compile("Kill zombies and skeletons", REGISTRIES, 100).kind() == GoalCompilation.Kind.ACCEPTED,
				"plural entities compile");
		var kills = COMPILER.translationConstraintFor("Kill 2 zombies, 3 skeletons and an enderman", REGISTRIES);
		check(kills.killClauses().stream().map(clause -> clause.alternatives().getFirst().count()).toList().equals(List.of(2, 3, 1)),
				"counts stay attached to entity clauses");
		check(COMPILER.compile("Go to 1, 64, 2", REGISTRIES, 100).kind() == GoalCompilation.Kind.ACCEPTED,
				"coordinate commas retain their spatial meaning");
		String mixedPosition = "Get an iron pickaxe and go to coordinates x=1, y=64, z=2";
		COMPILER.translationConstraintFor(mixedPosition, REGISTRIES).validate(new GoalPredicate.AllOf(List.of(
				new GoalPredicate.InventoryContains("minecraft:iron_pickaxe", 1),
				new GoalPredicate.PositionWithin(1, 64, 2, 1, 20)))); checks++;
		check(COMPILER.translationRequiresOperatorConfirmation("Get a good pickaxe", REGISTRIES), "subjective outcome retains confirmation");
		check(COMPILER.translationRequiresOperatorConfirmation("Get a zzzunknownitem", REGISTRIES), "unknown registry nouns cannot claim factual completion");
	}

	private static void verifyDimensionEntries() {
		for (String dimension : List.of("Nether", "End")) {
			String advancement = "minecraft:story/enter_the_" + dimension.toLowerCase(java.util.Locale.ROOT);
			var expected = new GoalPredicate.AdvancementGranted(advancement);
			for (String verb : List.of("Enter", "Go to", "Travel to", "Reach")) {
				String request = verb + " the " + dimension + ".";
				check(GoalCompiler.looksLikeGoalRequest(request), "dimension request reaches the goal router");
				check(COMPILER.compile(request, REGISTRIES, 100, id -> id.equals(advancement)).acceptedSpec().orElseThrow()
						.completion().equals(expected), "dimension entry compiles to the exact advancement");
				check(COMPILER.compile(request, REGISTRIES, 100, id -> false).kind() == GoalCompilation.Kind.REJECTED,
						"missing server advancement fails closed");
				var constraint = COMPILER.translationConstraintFor(request, REGISTRIES);
				constraint.requireCatalog(ids("story/enter_the_" + dimension.toLowerCase(java.util.Locale.ROOT))); checks++;
				constraint.validate(expected); checks++;
				reject(() -> constraint.requireCatalog(List.of()), "entry advancement must be offered");
				reject(() -> constraint.validate(new GoalPredicate.PositionWithin(0, 64, 0, 1, 20)), "invented coordinates cannot replace entry");
				reject(() -> constraint.validate(new GoalPredicate.AnyOf(List.of(expected, new GoalPredicate.OperatorConfirmed()))),
						"every completion path must prove entry");
				check(COMPILER.normalizeTranslatedPredicate(request, new GoalPredicate.AllOf(List.of(expected,
						new GoalPredicate.OperatorConfirmed())), REGISTRIES).equals(expected), "factual entry drops redundant confirmation");
			}
			String mixed = "Get a shield and enter the " + dimension;
			COMPILER.translationConstraintFor(mixed, REGISTRIES).validate(new GoalPredicate.AllOf(List.of(
					new GoalPredicate.InventoryContains("minecraft:shield", 1), expected))); checks++;
			check(!COMPILER.translationRequiresOperatorConfirmation(mixed, REGISTRIES), "item plus dimension entry remains factual");
		}
	}

	private static void verifyStructureEntries() {
		Map<String, String> entries = Map.of(
				"a Nether fortress", "nether/find_fortress", "a fortress", "nether/find_fortress",
				"a bastion remnant", "nether/find_bastion", "the bastion", "nether/find_bastion",
				"a stronghold", "story/follow_ender_eye", "an End city", "end/find_end_city");
		for (var entry : entries.entrySet()) for (String verb : List.of("Enter", "Reach", "Go to", "Travel to")) {
			String request = verb + " " + entry.getKey() + ".";
			var expected = new GoalPredicate.AdvancementGranted("minecraft:" + entry.getValue());
			check(COMPILER.compile(request, REGISTRIES, 100).acceptedSpec().orElseThrow().completion().equals(expected),
					"structure entry compiles to public advancement: " + request);
			check(COMPILER.candidateIdsFor(request, REGISTRIES).equals(List.of(expected.advancementId())), "entry catalog is exact");
			COMPILER.translationConstraintFor(request, REGISTRIES).validate(expected); checks++;
			check(!COMPILER.translationRequiresOperatorConfirmation(request, REGISTRIES), "entry needs factual evidence, not confirmation");
		}
		String alternative = "Enter a Nether fortress or a bastion remnant.";
		var fortress = new GoalPredicate.AdvancementGranted("minecraft:nether/find_fortress");
		var bastion = new GoalPredicate.AdvancementGranted("minecraft:nether/find_bastion");
		var expected = new GoalPredicate.AnyOf(List.of(bastion, fortress));
		check(COMPILER.compile(alternative, REGISTRIES, 100).acceptedSpec().orElseThrow().completion().equals(expected),
				"either requested structure is accepted without inventing coordinates");
		var constraint = COMPILER.translationConstraintFor(alternative, REGISTRIES);
		constraint.requireCatalog(ids("nether/find_bastion", "nether/find_fortress")); checks++;
		constraint.validate(expected); checks++;
		constraint.validate(fortress); checks++;
		reject(() -> constraint.requireCatalog(ids("nether/find_fortress")), "alternative catalogs retain both options");
		reject(() -> constraint.validate(new GoalPredicate.OperatorConfirmed()), "confirmation cannot replace entry evidence");
		reject(() -> constraint.validate(new GoalPredicate.AnyOf(List.of(fortress, new GoalPredicate.OperatorConfirmed()))),
				"an alternative cannot bypass actual entry");
		reject(() -> constraint.validate(new GoalPredicate.AdvancementGranted("minecraft:story/enter_the_nether")),
				"dimension entry is not structure entry");
		check(COMPILER.compile(alternative, REGISTRIES, 100, id -> id.equals(fortress.advancementId())).kind() == GoalCompilation.Kind.REJECTED,
				"every requested entry advancement must exist");
		String compound = "Get 7 blaze rods and enter a fortress";
		var combined = new GoalPredicate.AllOf(List.of(new GoalPredicate.InventoryContains("minecraft:blaze_rod", 7), fortress));
		COMPILER.translationConstraintFor(compound, REGISTRIES).validate(combined); checks++;
		reject(() -> COMPILER.translationConstraintFor(compound, REGISTRIES).validate(fortress), "entry cannot drop an item quantity");
		check(COMPILER.candidateIdsFor("Enter a fortress or a village", REGISTRIES).isEmpty(), "unknown entry alternatives are not dropped");
		check(COMPILER.compile("Build a fortress", REGISTRIES, 100).kind() != GoalCompilation.Kind.ACCEPTED,
				"building a structure does not become a discovery advancement");
	}

	private static List<String> ids(String... paths) { return java.util.Arrays.stream(paths).map(path -> "minecraft:" + path).toList(); }
	private static void check(boolean condition, String label) { if (!condition) throw new AssertionError(label); checks++; }
	private static void reject(Runnable action, String label) {
		try { action.run(); } catch (AgentDomainException expected) { checks++; return; }
		throw new AssertionError(label);
	}
}
