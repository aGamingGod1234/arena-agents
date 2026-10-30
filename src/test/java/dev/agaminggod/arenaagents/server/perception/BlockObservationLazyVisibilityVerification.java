package dev.agaminggod.arenaagents.server.perception;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Random;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Predicate;
import java.util.HashMap;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Blocks;

public final class BlockObservationLazyVisibilityVerification {
	private static final String[] BLOCK_IDS = {
			"minecraft:stone",
			"minecraft:grass_block",
			"minecraft:oak_log",
			"minecraft:coal_ore",
			"minecraft:crafting_table",
			"minecraft:water"
	};

	private BlockObservationLazyVisibilityVerification() {
	}

	public static int verify() {
		int assertions = 0;

		for (long seed = 1L; seed <= 64L; seed++) {
			List<BlockObservationOrdering.Candidate> candidates = candidates(seed);
			Set<BlockObservationOrdering.Candidate> occluded = occluded(candidates, seed);
			Predicate<BlockObservationOrdering.Candidate> visible = candidate -> !occluded.contains(candidate);

			ArrayList<BlockObservationOrdering.Candidate> prefiltered = new ArrayList<>();
			for (BlockObservationOrdering.Candidate candidate : candidates) {
				if (visible.test(candidate)) prefiltered.add(candidate);
			}

			List<BlockObservationOrdering.Candidate> eager = BlockObservationOrdering.select(
					prefiltered, ServerObservationCollector.MAX_BLOCKS,
					ServerObservationCollector.MAX_BLOCKS_PER_TYPE);
			List<BlockObservationOrdering.Candidate> lazy = BlockObservationOrdering.select(
					candidates, ServerObservationCollector.MAX_BLOCKS,
					ServerObservationCollector.MAX_BLOCKS_PER_TYPE, visible);

			assertEquals(eager, lazy, "lazy visibility selection is output-identical (seed " + seed + ")");
			assertEquals(
					lazy,
					BlockObservationOrdering.select(
							candidates.reversed(), ServerObservationCollector.MAX_BLOCKS,
							ServerObservationCollector.MAX_BLOCKS_PER_TYPE, visible),
					"lazy visibility selection is independent of scan order (seed " + seed + ")"
			);
			assertEquals(
					lazy,
					BlockObservationOrdering.selectOrdered(
							BlockObservationOrdering.ordered(candidates),
							ServerObservationCollector.MAX_BLOCKS,
							ServerObservationCollector.MAX_BLOCKS_PER_TYPE,
							visible
					),
					"cached ordered candidates preserve exact selection (seed " + seed + ")"
			);
			assertions += 3;
		}

		List<BlockObservationOrdering.Candidate> saturated = new ArrayList<>();
		for (int x = 1; x <= 40; x++) {
			saturated.add(new BlockObservationOrdering.Candidate(x, 0, 0, "minecraft:stone"));
		}
		saturated.add(new BlockObservationOrdering.Candidate(60, 0, 0, "minecraft:oak_log"));

		AtomicInteger eagerChecks = new AtomicInteger();
		BlockObservationOrdering.select(visibleAll(saturated, eagerChecks), 8, 2);
		AtomicInteger lazyChecks = new AtomicInteger();
		List<BlockObservationOrdering.Candidate> lazy = BlockObservationOrdering.select(
				saturated, 8, 2, candidate -> {
					lazyChecks.incrementAndGet();
					return true;
				});

		assertEquals(3, lazy.size(), "per-type exhaustion does not shorten the global selection");
		assertTrue(
				lazy.getLast().blockId().equals("minecraft:oak_log"),
				"the scan continues past an exhausted per-type quota until the global quota is full"
		);
		assertTrue(
				lazyChecks.get() < eagerChecks.get(),
				"lazy selection tests fewer candidates than pre-filtering: "
						+ lazyChecks.get() + " vs " + eagerChecks.get()
		);
		assertions += 3;

		AtomicInteger boundedChecks = new AtomicInteger();
		BlockObservationOrdering.select(saturated, 2, 8, candidate -> {
			boundedChecks.incrementAndGet();
			return true;
		});
		assertEquals(2, boundedChecks.get(), "a satisfied global quota stops visibility testing immediately");
		assertions += 1;

		ArrayList<SightCandidate> crowded = new ArrayList<>();
		for (int index = 511; index >= 0; index--) crowded.add(new SightCandidate(index, true));
		AtomicInteger lineOfSightChecks = new AtomicInteger();
		List<SightCandidate> visibleEntities = ServerObservationCollector.selectNearestVisible(
				crowded,
				Comparator.comparingInt(SightCandidate::distance),
				ServerObservationCollector.MAX_ENTITIES,
				candidate -> {
					lineOfSightChecks.incrementAndGet();
					return candidate.visible();
				}
		);
		assertEquals(
				java.util.stream.IntStream.range(0, ServerObservationCollector.MAX_ENTITIES)
						.mapToObj(index -> new SightCandidate(index, true)).toList(),
				visibleEntities,
				"nearest-first entity selection preserves the former visible ordering"
		);
		assertEquals(
				ServerObservationCollector.MAX_ENTITIES,
				lineOfSightChecks.get(),
				"crowded observations stop line-of-sight work at the entity limit"
		);

		// Audit fix: a hidden crowd costs a bounded number of line-of-sight tests, says so, and never hides a known threat.
		ArrayList<SightCandidate> hidden = new ArrayList<>();
		for (int index = 9_999; index >= 0; index--) hidden.add(new SightCandidate(index, false));
		SightCandidate farVisible = new SightCandidate(20_000, true);
		SightCandidate farThreat = new SightCandidate(20_001, true);
		hidden.add(farVisible);
		hidden.add(farThreat);
		AtomicInteger hiddenChecks = new AtomicInteger();
		var bounded = ServerObservationCollector.selectNearestVisible(
				hidden,
				Comparator.comparingInt(SightCandidate::distance),
				ServerObservationCollector.MAX_ENTITIES,
				ServerObservationCollector.MAX_ENTITY_VISIBILITY_CHECKS,
				candidate -> candidate == farThreat,
				candidate -> {
					hiddenChecks.incrementAndGet();
					return candidate.visible();
				}
		);
		assertEquals(ServerObservationCollector.MAX_ENTITY_VISIBILITY_CHECKS, hiddenChecks.get(),
				"10,000 hidden entities cost only the line-of-sight budget");
		assertEquals(List.of(farThreat), bounded.selected(), "a threat already seen by the threat scan survives an exhausted budget");
		assertEquals(true, bounded.visibilityChecksLimited(), "an exhausted budget is reported, not mistaken for absence");
		assertEquals(10_002 - ServerObservationCollector.MAX_ENTITY_VISIBILITY_CHECKS - 1, bounded.untested(), "untested candidates are counted");
		var mixed = ServerObservationCollector.selectNearestVisible(
				List.of(new SightCandidate(3, true), new SightCandidate(1, false), new SightCandidate(2, true)),
				Comparator.comparingInt(SightCandidate::distance), 8, 2, candidate -> false, SightCandidate::visible);
		assertEquals(List.of(new SightCandidate(2, true)), mixed.selected(), "the budget is spent nearest first, failures included");
		assertEquals(true, mixed.visibilityChecksLimited(), "the third candidate is untested");
		var ample = ServerObservationCollector.selectNearestVisible(hidden.subList(9_990, 10_002),
				Comparator.comparingInt(SightCandidate::distance), 8, ServerObservationCollector.MAX_ENTITY_VISIBILITY_CHECKS,
				candidate -> false, SightCandidate::visible);
		assertEquals(List.of(farVisible, farThreat), ample.selected(), "within budget a farther visible entity is still found");
		assertEquals(false, ample.visibilityChecksLimited(), "a fully tested crowd is not marked limited");
		assertions += 8;

		// Review fix: hunting hostiles share the observation's budget, a crowd of them cannot exceed it, and none is dropped.
		ArrayList<SightCandidate> hunting = new ArrayList<>();
		for (int index = 0; index < 1_000; index++) hunting.add(new SightCandidate(index, index == 0));
		ArrayList<SightCandidate> others = new ArrayList<>(hunting);
		for (int index = 1_000; index < 2_000; index++) others.add(new SightCandidate(index, false));
		AtomicInteger observedChecks = new AtomicInteger();
		var observed = ServerObservationCollector.selectObservedEntities(hunting, others, Comparator.comparingInt(SightCandidate::distance),
				candidate -> true, candidate -> {
					observedChecks.incrementAndGet();
					return candidate.visible();
				}, ServerObservationCollector.MAX_ENTITIES, ServerObservationCollector.MAX_ENTITY_VISIBILITY_CHECKS);
		assertEquals(ServerObservationCollector.MAX_ENTITY_VISIBILITY_CHECKS, observedChecks.get(),
				"1,000 hidden hunting mobs and 1,000 other entities cost only the shared budget");
		assertEquals(ServerObservationCollector.MAX_ENTITY_VISIBILITY_CHECKS, observed.checks(), "the selection counts the same tests");
		assertEquals(List.of(new SightCandidate(0, true)), observed.seen(), "the visible hunting mob is seen once, not tested again");
		assertEquals(8, observed.heard().size(), "the nearest hidden hunting mobs are heard, at most 8");
		assertEquals(true, observed.visibilityChecksLimited(), "the spent budget is reported");
		var lastThreat = ServerObservationCollector.selectObservedEntities(List.of(new SightCandidate(5, true)), List.of(new SightCandidate(5, true)),
				Comparator.comparingInt(SightCandidate::distance), candidate -> true, SightCandidate::visible, 8, 0);
		assertEquals(List.of(new SightCandidate(5, true)), lastThreat.heard(), "a hunting mob left untested is still reported, as heard");

		// Review fix: focused pages move through candidates, so a hidden first page leads on to the visible entity.
		ArrayList<SightCandidate> crowd = new ArrayList<>();
		for (int index = 0; index < 256; index++) crowd.add(new SightCandidate(index, false));
		crowd.add(new SightCandidate(256, true));
		AtomicInteger pageChecks = new AtomicInteger();
		java.util.function.Function<SightCandidate, com.google.gson.JsonObject> details = candidate -> {
			com.google.gson.JsonObject entry = new com.google.gson.JsonObject();
			entry.addProperty("distance", candidate.distance());
			return entry;
		};
		Predicate<SightCandidate> counted = candidate -> {
			pageChecks.incrementAndGet();
			return candidate.visible();
		};
		var first = ServerObservationCollector.candidatePage(crowd, 0, 8, ServerObservationCollector.MAX_ENTITY_VISIBILITY_CHECKS, counted, details, "test");
		var firstCoverage = first.getAsJsonObject("coverage");
		assertEquals(0, first.getAsJsonArray("entries").size(), "the first page holds only hidden candidates");
		assertEquals(true, firstCoverage.get("hasMore").getAsBoolean(), "and says more follow");
		assertEquals(256, firstCoverage.get("nextOffset").getAsInt(), "continuing past the tested candidates");
		assertEquals(true, firstCoverage.get("visibilityChecksLimited").getAsBoolean(), "the first page ran out of tests");
		assertEquals(256, pageChecks.get(), "one page costs at most the budget");
		var second = ServerObservationCollector.candidatePage(crowd, 256, 8, ServerObservationCollector.MAX_ENTITY_VISIBILITY_CHECKS, counted, details, "test");
		assertEquals(256, second.getAsJsonArray("entries").get(0).getAsJsonObject().get("distance").getAsInt(), "the next page finds the visible entity");
		assertEquals(false, second.getAsJsonObject("coverage").get("hasMore").getAsBoolean(), "and ends the candidates");
		assertEquals(257, second.getAsJsonObject("coverage").get("nextOffset").getAsInt(), "nextOffset counts candidates");
		var small = ServerObservationCollector.candidatePage(List.of(new SightCandidate(1, true), new SightCandidate(2, false), new SightCandidate(3, true)),
				0, 1, 256, SightCandidate::visible, details, "test");
		assertEquals(1, small.getAsJsonObject("coverage").get("nextOffset").getAsInt(), "a full page continues just after its last entry");
		assertions += 15;
		assertEquals(513, BlockObservationOrdering.ordered(crowdedBlocks()).size(),
				"the raw spatial cache retains candidates beyond the former four-times quota");

		AtomicInteger uniformOccludedChecks = new AtomicInteger();
		BlockObservationOrdering.selectOrderedWithVisibilityBudget(
				BlockObservationOrdering.ordered(crowdedBlocks()),
				ServerObservationCollector.MAX_BLOCKS,
				ServerObservationCollector.MAX_BLOCKS_PER_TYPE,
				ServerObservationCollector.MAX_BLOCK_VISIBILITY_CHECKS,
				ServerObservationCollector.MAX_BLOCK_VISIBILITY_CHECKS_PER_TYPE,
				candidate -> {
					uniformOccludedChecks.incrementAndGet();
					return false;
				});
		assertEquals(ServerObservationCollector.MAX_BLOCK_VISIBILITY_CHECKS_PER_TYPE,
				uniformOccludedChecks.get(),
				"uniform occlusion cannot exceed the per-type raycast budget");

		ArrayList<BlockObservationOrdering.Candidate> diverseOccluded = new ArrayList<>();
		for (int index = 0; index < 600; index++) {
			diverseOccluded.add(new BlockObservationOrdering.Candidate(
					index, 0, 0, "fixture:block_" + index));
		}
		AtomicInteger diverseOccludedChecks = new AtomicInteger();
		BlockObservationOrdering.selectOrderedWithVisibilityBudget(
				BlockObservationOrdering.ordered(diverseOccluded),
				ServerObservationCollector.MAX_BLOCKS,
				ServerObservationCollector.MAX_BLOCKS_PER_TYPE,
				ServerObservationCollector.MAX_BLOCK_VISIBILITY_CHECKS,
				ServerObservationCollector.MAX_BLOCK_VISIBILITY_CHECKS_PER_TYPE,
				candidate -> {
					diverseOccludedChecks.incrementAndGet();
					return false;
				});
		assertEquals(ServerObservationCollector.MAX_BLOCK_VISIBILITY_CHECKS,
				diverseOccludedChecks.get(),
				"diverse occlusion cannot exceed the global raycast budget");

		ArrayList<BlockObservationOrdering.Candidate> coneFiltered = new ArrayList<>();
		for (int index = 0; index < 40; index++) {
			coneFiltered.add(new BlockObservationOrdering.Candidate(
					index + 1, 0, 0, "minecraft:stone"));
		}
		AtomicInteger raycastsAfterCone = new AtomicInteger();
		List<BlockObservationOrdering.Candidate> selectedAfterCone =
				BlockObservationOrdering.selectOrderedWithVisibilityBudget(
						BlockObservationOrdering.ordered(coneFiltered),
						ServerObservationCollector.MAX_BLOCKS,
						ServerObservationCollector.MAX_BLOCKS_PER_TYPE,
						ServerObservationCollector.MAX_BLOCK_VISIBILITY_CHECKS,
						ServerObservationCollector.MAX_BLOCK_VISIBILITY_CHECKS_PER_TYPE,
						candidate -> candidate.x() > 32,
						candidate -> {
							raycastsAfterCone.incrementAndGet();
							return true;
						});
		assertEquals(8, selectedAfterCone.size(),
				"cheap cone rejects do not hide later visible blocks of the same type");
		assertEquals(8, raycastsAfterCone.get(),
				"only cone-eligible candidates consume the raycast budget");
		assertions += 7;

		Map<BlockPos, net.minecraft.world.level.block.state.BlockState> mutableStates = new HashMap<>();
		BlockPos cachedPosition = new BlockPos(1, 0, 0);
		List<BlockObservationOrdering.Candidate> cached = List.of(
				new BlockObservationOrdering.Candidate(1, 0, 0, "minecraft:stone"));
		mutableStates.put(cachedPosition, Blocks.STONE.defaultBlockState());
		assertEquals(
				List.of(new BlockObservationOrdering.Candidate(1, 0, 0, "minecraft:stone")),
				ServerObservationCollector.refreshCurrentBlockCandidates(cached, BlockPos.ZERO, mutableStates::get),
				"cached candidates initially reflect the live block state");
		mutableStates.put(cachedPosition, Blocks.DIRT.defaultBlockState());
		assertEquals(
				List.of(new BlockObservationOrdering.Candidate(1, 0, 0, "minecraft:dirt")),
				ServerObservationCollector.refreshCurrentBlockCandidates(cached, BlockPos.ZERO, mutableStates::get),
				"cached candidates refresh their block ID after an in-window mutation");
		mutableStates.put(cachedPosition, Blocks.AIR.defaultBlockState());
		assertEquals(
				List.of(),
				ServerObservationCollector.refreshCurrentBlockCandidates(cached, BlockPos.ZERO, mutableStates::get),
				"cached candidates omit a block that became air");
		assertions += 3;

		return assertions + verifyMixedOcclusionBudgets();
	}

	/** Unlimited equivalence is not the heartbeat contract: rejected LOS checks consume its budget. */
	private static int verifyMixedOcclusionBudgets() {
		ArrayList<BlockObservationOrdering.Candidate> grid = new ArrayList<>();
		for (int x = 1; x <= 5; x++) {
			for (int y = 0; y <= 1; y++) {
				for (int z = -2; z <= 2; z++) {
					grid.add(new BlockObservationOrdering.Candidate(x, y, z, "minecraft:coal_ore"));
				}
			}
		}
		int budget = ServerObservationCollector.MAX_BLOCK_VISIBILITY_CHECKS_PER_TYPE;
		List<BlockObservationOrdering.Candidate> ordered = BlockObservationOrdering.ordered(grid).subList(0, budget + 1);
		var late = ordered.get(budget);
		var boundary = ordered.get(budget - 1);
		List<BlockObservationOrdering.Candidate> eager = BlockObservationOrdering.select(
				ordered.stream().filter(late::equals).toList(), ServerObservationCollector.MAX_BLOCKS,
				ServerObservationCollector.MAX_BLOCKS_PER_TYPE);
		assertEquals(List.of(late), eager, "eager visible reference includes the resource beyond the budget");
		AtomicInteger checks = new AtomicInteger();
		List<BlockObservationOrdering.Candidate> bounded = budgeted(ordered, candidate -> true, late::equals, checks);
		assertEquals(List.of(), bounded, "bounded mixed occlusion explicitly omits the late resource");
		assertEquals(budget, checks.get(), "failed LOS consumes the production per-type budget");
		assertEquals(bounded, budgeted(ordered, candidate -> true, late::equals, new AtomicInteger()),
				"an identical heartbeat does not promise recovery");
		assertEquals(List.of(boundary), budgeted(ordered, candidate -> true, boundary::equals, new AtomicInteger()),
				"visible resource at the budget boundary survives");
		checks.set(0);
		assertEquals(eager, budgeted(ordered, late::equals, late::equals, checks),
				"cheap loading/state/cone rejection preserves the later resource's LOS budget");
		assertEquals(1, checks.get(), "only the eligible resource uses LOS");
		ArrayList<BlockObservationOrdering.Candidate> mixed = new ArrayList<>(ordered);
		var log = new BlockObservationOrdering.Candidate(late.x(), late.y(), late.z(), "minecraft:oak_log");
		mixed.set(budget, log);
		assertEquals(List.of(log), budgeted(BlockObservationOrdering.ordered(mixed), candidate -> true,
				log::equals, new AtomicInteger()), "occluded ore does not exhaust another resource type");
		var coverage = ObservationPage.coverage(new com.google.gson.JsonObject());
		assertEquals(false, coverage.getAsJsonObject("sections").getAsJsonObject("blocks").get("complete").getAsBoolean(),
				"bounded sampling never claims observed absence of omitted resources");
		return 9;
	}

	private static List<BlockObservationOrdering.Candidate> budgeted(List<BlockObservationOrdering.Candidate> ordered,
			Predicate<BlockObservationOrdering.Candidate> eligible, Predicate<BlockObservationOrdering.Candidate> visible,
			AtomicInteger checks) {
		return BlockObservationOrdering.selectOrderedWithVisibilityBudget(ordered,
				ServerObservationCollector.MAX_BLOCKS, ServerObservationCollector.MAX_BLOCKS_PER_TYPE,
				ServerObservationCollector.MAX_BLOCK_VISIBILITY_CHECKS,
				ServerObservationCollector.MAX_BLOCK_VISIBILITY_CHECKS_PER_TYPE, eligible,
				candidate -> { checks.incrementAndGet(); return visible.test(candidate); });
	}

	private static List<BlockObservationOrdering.Candidate> crowdedBlocks() {
		ArrayList<BlockObservationOrdering.Candidate> candidates = new ArrayList<>();
		for (int index = 0; index < 513; index++) {
			candidates.add(new BlockObservationOrdering.Candidate(index, 0, 0, "minecraft:stone"));
		}
		return candidates;
	}

	private static List<BlockObservationOrdering.Candidate> visibleAll(
			List<BlockObservationOrdering.Candidate> candidates,
			AtomicInteger checks
	) {
		ArrayList<BlockObservationOrdering.Candidate> visible = new ArrayList<>();
		for (BlockObservationOrdering.Candidate candidate : candidates) {
			checks.incrementAndGet();
			visible.add(candidate);
		}
		return visible;
	}

	private static List<BlockObservationOrdering.Candidate> candidates(long seed) {
		Random random = new Random(seed);
		ArrayList<BlockObservationOrdering.Candidate> candidates = new ArrayList<>();
		HashSet<Long> occupied = new HashSet<>();
		int target = 200 + random.nextInt(400);
		while (candidates.size() < target) {
			int x = random.nextInt(13) - 6;
			int y = random.nextInt(7) - 3;
			int z = random.nextInt(13) - 6;
			if (!occupied.add(((long) (x + 8) << 16) | ((long) (y + 8) << 8) | (z + 8))) continue;
			candidates.add(new BlockObservationOrdering.Candidate(
					x, y, z, BLOCK_IDS[random.nextInt(BLOCK_IDS.length)]));
		}
		return List.copyOf(candidates);
	}

	private static Set<BlockObservationOrdering.Candidate> occluded(
			List<BlockObservationOrdering.Candidate> candidates,
			long seed
	) {
		Random random = new Random(seed * 31L + 7L);
		HashSet<BlockObservationOrdering.Candidate> occluded = new HashSet<>();
		for (BlockObservationOrdering.Candidate candidate : candidates) {
			if (random.nextInt(3) != 0) occluded.add(candidate);
		}
		return occluded;
	}

	private static void assertEquals(Object expected, Object actual, String label) {
		if (!expected.equals(actual)) {
			throw new AssertionError(label + ": expected <" + expected + "> but was <" + actual + ">");
		}
	}

	private static void assertTrue(boolean condition, String label) {
		if (!condition) throw new AssertionError(label);
	}

	private record SightCandidate(int distance, boolean visible) {
	}
}
