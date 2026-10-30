package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.client.navigation.LocalPathfinder;
import dev.agaminggod.arenaagents.client.navigation.PathOutcome;
import dev.agaminggod.arenaagents.client.navigation.PathPlan;
import dev.agaminggod.arenaagents.client.navigation.WalkabilityView;
import dev.agaminggod.arenaagents.server.perception.SeenTerrain;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

public final class SeenNavigationVerification {
	private static int assertions;
	private static final GridPosition START = new GridPosition(0, 64, 0);
	private static final GridPosition GOAL = new GridPosition(12, 64, 0);

	private SeenNavigationVerification() { }

	static final class World implements BlockGetter, SeenTerrain.Source<BlockState> {
		final Map<BlockPos, BlockState> states = new HashMap<>();
		int seenThrough = 3;
		boolean visible = true;
		boolean headVisible = true;
		@Override public BlockEntity getBlockEntity(BlockPos position) { return null; }
		@Override public BlockState getBlockState(BlockPos position) {
			return states.getOrDefault(position, position.getY() == 63 ? Blocks.STONE.defaultBlockState() : Blocks.AIR.defaultBlockState());
		}
		@Override public FluidState getFluidState(BlockPos position) { return getBlockState(position).getFluidState(); }
		@Override public int getHeight() { return 384; }
		@Override public int getMinY() { return -64; }
		@Override public BlockState live(int x, int y, int z) { return getBlockState(new BlockPos(x, y, z)); }
		@Override public boolean sees(int x, int y, int z) {
			return visible && x >= 0 && x <= seenThrough && z == 0 && y >= 63 && y <= 66 && (y != 65 || headVisible);
		}
		@Override public boolean touches(int x, int y, int z) { return x == 0 && z == 0 && y >= 63 && y <= 65; }
	}

	static MinecraftNavigationWorld view(World world, SeenTerrain.Memory<BlockState> memory, long tick) {
		return new MinecraftNavigationWorld(world, new SeenTerrain.Reader<>(memory, world, tick, null));
	}

	/** A navigation view that has seen every cell around a jump from (0,64,0). */
	static MinecraftNavigationWorld sweptView(World world) {
		SeenTerrain.Source<BlockState> sight = new SeenTerrain.Source<>() {
			@Override public BlockState live(int x, int y, int z) { return world.live(x, y, z); }
			@Override public boolean sees(int x, int y, int z) { return x >= -1 && x <= 3 && z >= -1 && z <= 2 && y >= 57 && y <= 67; }
		};
		return new MinecraftNavigationWorld(world, new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), sight, 1L, null));
	}

	static LocalPathfinder.Search search() {
		return new LocalPathfinder().beginSearch(START, Set.of(GOAL), GOAL, 16, Set.of());
	}

	static PathPlan finish(LocalPathfinder.Search search, WalkabilityView view) {
		PathPlan plan;
		do {
			plan = search.advance(view, new LocalPathfinder.SearchBudget(8192, Long.MAX_VALUE, () -> 0L));
		} while (!search.finished());
		return plan;
	}

	public static int verify() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		assertions = 0;
		World world = new World();
		SeenTerrain.Memory<BlockState> memory = new SeenTerrain.Memory<>();
		MinecraftNavigationWorld first = view(world, memory, 1L);
		check(first.cellAt(GOAL) == WalkabilityView.Cell.UNLOADED, "unseen air remains unknown");
		world.states.put(new BlockPos(12, 64, 0), Blocks.STONE.defaultBlockState());
		check(view(world, new SeenTerrain.Memory<>(), 1L).cellAt(GOAL) == WalkabilityView.Cell.UNLOADED, "unseen solid remains unknown");
		world.states.clear();
		LocalPathfinder.Search firstSearch = search();
		PathPlan route = finish(firstSearch, first);
		check(route.outcome() == PathOutcome.FOUND, "seen prefix provides a partial route");
		check(route.nodes().getLast().position().equals(new GridPosition(3, 64, 0)), "partial route ends at farthest seen point, even below eight cells");
		check(firstSearch.endedAtUnknown(), "partial route identifies unseen continuation");
		for (var node : route.nodes()) check(node.position().x() <= 3 && first.isTraversable(node.position()), "every committed node has acquired clearance and support");
		world.states.put(new BlockPos(4, 63, 0), Blocks.LAVA.defaultBlockState());
		world.states.put(new BlockPos(4, 64, 0), Blocks.STONE.defaultBlockState());
		world.states.put(new BlockPos(3, 63, 1), Blocks.LAVA.defaultBlockState());
		MinecraftNavigationWorld changed = view(world, memory, 2L);
		check(route.nodes().equals(finish(search(), changed).nodes()), "hidden lava, wall and floor changes leave route identical");
		check(first.exposureCost(new GridPosition(3, 64, 0)) == changed.exposureCost(new GridPosition(3, 64, 0)), "unseen adjacent lava cannot change route costs");
		check(first.isCurrent(new SeenTerrain.Reader<>(memory, world, 3L, null)), "hidden mutations do not invalidate retained planning");
		check(Double.isNaN(changed.supportHeight(GOAL, 12.5D, 0.5D)), "unseen support height remains unknown");
		check(changed.inwardStandingTarget(GOAL, new Vec3(12.5D, 64D, 0.5D), new AABB(0.2D, 64D, 0.2D, 0.8D, 65.8D, 0.8D)) == null, "hidden collision cannot select an inward target");
		world.states.clear();
		world.seenThrough = 12;
		MinecraftNavigationWorld surveyed = view(world, memory, 4L);
		LocalPathfinder.Search surveyedSearch = search();
		check(finish(surveyedSearch, surveyed).nodes().getLast().position().equals(GOAL), "acquired goal and route restore full navigation");
		check(!surveyedSearch.endedAtUnknown(), "a goal route is not labelled a frontier");
		World corridor = new World();
		corridor.seenThrough = 20;
		GridPosition distant = new GridPosition(20, 64, 0);
		LocalPathfinder.Search bounded = new LocalPathfinder().beginSearch(START, Set.of(distant), distant, 8, Set.of());
		check(finish(bounded, view(corridor, new SeenTerrain.Memory<>(), 1L)).nodes().getLast().position().equals(new GridPosition(8, 64, 0)), "known long route reaches its local search boundary");
		check(!bounded.endedAtUnknown(), "unknown terrain beside a known continuation cannot end long navigation");
		corridor.seenThrough = 8;
		LocalPathfinder.Search sightBoundary = new LocalPathfinder().beginSearch(START, Set.of(distant), distant, 8, Set.of());
		check(finish(sightBoundary, view(corridor, new SeenTerrain.Memory<>(), 1L)).nodes().getLast().position().equals(new GridPosition(8, 64, 0)), "local and sight boundaries may coincide");
		check(sightBoundary.endedAtUnknown(), "an unknown continuation at the search boundary is still a sight frontier");
		check(!first.isCurrent(new SeenTerrain.Reader<>(memory, world, 4L, null)), "newly acquired previously unknown facts invalidate retained search");
		world.visible = false;
		world.states.put(new BlockPos(3, 63, 0), Blocks.AIR.defaultBlockState());
		check(view(world, memory, 5L).cellAt(new GridPosition(3, 63, 0)) == WalkabilityView.Cell.SAFE_SUPPORT, "remembered hidden floor keeps its old value");
		check(!surveyed.isCurrent(new SeenTerrain.Reader<>(memory, world, 205L, null)), "expiry invalidates a retained route snapshot");
		check(view(world, memory, 205L).cellAt(new GridPosition(3, 63, 0)) == WalkabilityView.Cell.UNLOADED, "expired hidden support is unknown");
		check(view(world, memory, 205L).isStandable(START), "body-contact support remains available without eye sight");
		world.visible = true;
		world.seenThrough = 3;
		world.states.clear();
		world.states.put(new BlockPos(12, 64, 0), Blocks.AIR.defaultBlockState());
		MinecraftNavigationWorld partial = view(world, new SeenTerrain.Memory<>(), 1L);
		ServerNavigationController.Preparation preparation = new ServerNavigationController.Preparation(START, new Vec3(12.5D, 64D, 0.5D), 0.2D, null);
		check(preparation.advance(partial, p -> partial.supportHeight(p, p.x() + 0.5D, p.z() + 0.5D), () -> true), "unseen-goal preparation completes");
		check(preparation.unknownGoal && !preparation.destinationHasNoSupport && preparation.goals.isEmpty(), "unknown goal cannot claim missing support");
		world.seenThrough = 12;
		world.states.put(new BlockPos(12, 63, 0), Blocks.AIR.defaultBlockState());
		MinecraftNavigationWorld noFloor = view(world, new SeenTerrain.Memory<>(), 1L);
		ServerNavigationController.Preparation unsupported = new ServerNavigationController.Preparation(START, new Vec3(12.5D, 64D, 0.5D), 0.2D, null);
		unsupported.advance(noFloor, p -> noFloor.supportHeight(p, p.x() + 0.5D, p.z() + 0.5D), () -> true);
		check(unsupported.destinationHasNoSupport, "known missing support preserves the stronger failure");
		check(ServerNavigationController.frontierMessage(new GridPosition(3, 64, 0)).equals("Destination not reached; seen path ends at 3,64,0; beyond unseen. Observe beyond the edge or choose another route before retrying"), "frontier message names the seen point without hidden geometry");
		world.visible = false;
		MinecraftNavigationWorld hiddenWater = view(world, new SeenTerrain.Memory<>(), 1L);
		check(ServerNavigationController.columnView(hiddenWater).at(3, 65, 0) == SwimPlanning.Cell.UNKNOWN, "unseen surface is unknown rather than known solid");
		check(SwimPlanning.nearestSurface((x, y, z) -> SwimPlanning.Cell.UNKNOWN, 0, 64, 0) == null, "unknown water columns cannot select a surface");
		world.visible = true;
		world.seenThrough = 3;
		SeenTerrain.Memory<BlockState> updatedMemory = new SeenTerrain.Memory<>();
		MinecraftNavigationWorld beforeChange = view(world, updatedMemory, 1L);
		GridPosition support = new GridPosition(2, 63, 0);
		check(beforeChange.cellAt(support) == WalkabilityView.Cell.SAFE_SUPPORT, "visible support is acquired");
		world.states.put(new BlockPos(2, 63, 0), Blocks.LAVA.defaultBlockState());
		MinecraftNavigationWorld afterChange = view(world, updatedMemory, 2L);
		check(afterChange.cellAt(support) == WalkabilityView.Cell.HAZARD, "visible mutation updates acquired geometry");
		check(!beforeChange.isCurrent(new SeenTerrain.Reader<>(updatedMemory, world, 2L, null)), "perceived mutation invalidates retained planning");
		check(!beforeChange.isCurrent(new SeenTerrain.Reader<>(updatedMemory, world, 2L, null)), "an invalid search cannot silently rebase its old cells");
		world.states.clear();
		world.states.put(new BlockPos(2, 64, 0), Blocks.MOVING_PISTON.defaultBlockState());
		check(view(world, new SeenTerrain.Memory<>(), 1L).cellAt(new GridPosition(2, 64, 0)) == WalkabilityView.Cell.UNLOADED,
				"a dynamic shape requiring unacquired block-entity geometry cannot prove clear space");
		world.states.clear();
		world.seenThrough = 12;
		world.states.put(new BlockPos(12, 64, 0), Blocks.OAK_LOG.defaultBlockState());
		MinecraftNavigationWorld solidGoal = view(world, new SeenTerrain.Memory<>(), 1L);
		ServerNavigationController.Preparation occupied = new ServerNavigationController.Preparation(START, new Vec3(12.5D, 64D, 0.5D), 0.2D, null);
		occupied.advance(solidGoal, p -> solidGoal.supportHeight(p, p.x() + 0.5D, p.z() + 0.5D), () -> true);
		check(occupied.destinationHasNoSupport && occupied.goals.isEmpty(), "known solid goal keeps a supported-arrival failure");
		check(solidGoal.stateAt(new BlockPos(12, 64, 0)).is(Blocks.OAK_LOG), "solid target feedback can name the acquired block");
		world.states.clear();
		world.seenThrough = 0;
		MinecraftNavigationWorld noPrefix = view(world, new SeenTerrain.Memory<>(), 1L);
		check(finish(search(), noPrefix).outcome() == PathOutcome.NO_PATH, "no seen continuation cannot fabricate a committed node");
		check(noPrefix.hasUnknown(), "a failed seen search retains the unknown reason");
		world.seenThrough = 12;
		world.headVisible = false;
		MinecraftNavigationWorld headroom = view(world, new SeenTerrain.Memory<>(), 1L);
		check(headroom.cellAt(GOAL) == WalkabilityView.Cell.CLEAR && headroom.cellAt(GOAL.below()) == WalkabilityView.Cell.SAFE_SUPPORT, "headroom fixture has acquired feet and support");
		ServerNavigationController.Preparation unknownHead = new ServerNavigationController.Preparation(START, new Vec3(12.5D, 64D, 0.5D), 0.2D, null);
		unknownHead.advance(headroom, p -> headroom.supportHeight(p, p.x() + 0.5D, p.z() + 0.5D), () -> true);
		check(unknownHead.unknownGoal && !unknownHead.destinationHasNoSupport, "unknown clearance is never a known support refusal");
		World runout = new World();
		runout.seenThrough = 3;
		SeenTerrain.Memory<BlockState> runoutMemory = new SeenTerrain.Memory<>();
		MinecraftNavigationWorld runoutView = view(runout, runoutMemory, 1L);
		ServerNavigationController.GapSprintGuard guard = new ServerNavigationController.GapSprintGuard();
		GridPosition landing = new GridPosition(2, 64, 0);
		check(!guard.dangerous(runoutView, START, landing), "known safe gap runout allows sprint");
		runout.states.put(new BlockPos(3, 63, 0), Blocks.LAVA.defaultBlockState());
		runoutView.nextFrame(new SeenTerrain.Reader<>(runoutMemory, runout, 2L, null));
		guard.forgetSample();
		check(guard.dangerous(runoutView, START, landing), "a new acquired frame refreshes gap safety in reused storage");
		World cached = new World();
		SeenTerrain.Memory<BlockState> cachedMemory = new SeenTerrain.Memory<>();
		MinecraftNavigationWorld cachedView = view(cached, cachedMemory, 1L);
		cachedView.cellAt(support);
		cached.states.put(new BlockPos(2, 63, 0), Blocks.LAVA.defaultBlockState());
		cachedView.nextFrame(new SeenTerrain.Reader<>(cachedMemory, cached, 2L, null));
		cachedView.exposureCost(new GridPosition(1, 64, 0));
		check(cachedView.cellAt(support) == WalkabilityView.Cell.HAZARD, "a cost read invalidates a changed cached cell before traversal reads it");
		GridPosition water = new GridPosition(1, 64, 0);
		cached.states.put(new BlockPos(1, 64, 0), Blocks.WATER.defaultBlockState());
		cachedView.nextFrame(new SeenTerrain.Reader<>(cachedMemory, cached, 3L, null));
		check(cachedView.isTraversable(water), "known water with acquired air headroom is swimmable");
		cached.states.put(new BlockPos(1, 65, 0), Blocks.STONE.defaultBlockState());
		cachedView.nextFrame(new SeenTerrain.Reader<>(cachedMemory, cached, 4L, null));
		check(!cachedView.isTraversable(water), "unchanged water rechecks changed acquired headroom");
		cached.seenThrough = 0;
		MinecraftNavigationWorld unknownCache = view(cached, new SeenTerrain.Memory<>(), 1L);
		GridPosition uncovered = new GridPosition(3, 64, 0);
		unknownCache.cellAt(uncovered);
		cached.seenThrough = 3;
		unknownCache.nextFrame(new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), cached, 2L, null));
		check(unknownCache.cellAt(uncovered) == WalkabilityView.Cell.CLEAR, "a cached unknown cell is acquired on a new frame");
		cached.visible = false;
		unknownCache.nextFrame(new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), cached, 205L, null));
		check(unknownCache.cellAt(uncovered) == WalkabilityView.Cell.UNLOADED, "cached clearance cannot outlive acquired knowledge");
		cached.visible = true;
		cached.states.put(new BlockPos(2, 64, 0), Blocks.MOVING_PISTON.defaultBlockState());
		MinecraftNavigationWorld dynamicCache = view(cached, new SeenTerrain.Memory<>(), 1L);
		dynamicCache.cellAt(new GridPosition(2, 64, 0));
		dynamicCache.nextFrame(new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), cached, 2L, null));
		check(dynamicCache.cellAt(new GridPosition(2, 64, 0)) == WalkabilityView.Cell.UNLOADED && dynamicCache.hasUnknown(), "retained dynamic shapes still report unacquired block-entity geometry");
		World obscured = new World();
		SeenTerrain.Memory<BlockState> obscuredMemory = new SeenTerrain.Memory<>();
		MinecraftNavigationWorld obscuredCache = view(obscured, obscuredMemory, 1L);
		PathPlan obscuredRoute = finish(search(), obscuredCache);
		int obscuredCost = obscuredCache.exposureCost(new GridPosition(3, 64, 0));
		obscured.states.put(new BlockPos(4, 64, 0), Blocks.STONE.defaultBlockState());
		obscured.states.put(new BlockPos(4, 63, 0), Blocks.LAVA.defaultBlockState());
		obscuredCache.nextFrame(new SeenTerrain.Reader<>(obscuredMemory, obscured, 2L, null));
		check(obscuredRoute.nodes().equals(finish(search(), obscuredCache).nodes())
				&& obscuredCost == obscuredCache.exposureCost(new GridPosition(3, 64, 0)), "hidden mutations leave a reused frame's route and cost identical");
		World resumed = new World();
		resumed.seenThrough = 12;
		SeenTerrain.Memory<BlockState> resumedMemory = new SeenTerrain.Memory<>();
		MinecraftNavigationWorld retained = view(resumed, resumedMemory, 1L);
		retained.cellAt(support);
		LocalPathfinder.Search paused = search();
		paused.advance(retained, new LocalPathfinder.SearchBudget(1, Long.MAX_VALUE, () -> 0L));
		check(!paused.finished(), "retained mutation fixture pauses an unfinished search");
		check(retained.isCurrent(new SeenTerrain.Reader<>(resumedMemory, resumed, 2L, null)), "unchanged resume keeps acquired snapshot");
		resumed.states.put(new BlockPos(2, 63, 0), Blocks.LAVA.defaultBlockState());
		check(!retained.isCurrent(new SeenTerrain.Reader<>(resumedMemory, resumed, 3L, null)), "visible lava invalidates after unchanged resume without another consumer");
		check(!retained.isCurrent(new SeenTerrain.Reader<>(resumedMemory, resumed, 3L, null)), "changed retained facts cannot rebase on a repeated check");
		MinecraftNavigationWorld refreshedPlan = view(resumed, resumedMemory, 3L);
		check(finish(search(), refreshedPlan).nodes().stream().noneMatch(node -> node.position().equals(new GridPosition(2, 64, 0))), "fresh plan excludes newly visible lava support");
		World concealed = new World();
		concealed.seenThrough = 12;
		SeenTerrain.Memory<BlockState> concealedMemory = new SeenTerrain.Memory<>();
		MinecraftNavigationWorld concealedSnapshot = view(concealed, concealedMemory, 1L);
		concealedSnapshot.cellAt(support);
		check(concealedSnapshot.isCurrent(new SeenTerrain.Reader<>(concealedMemory, concealed, 2L, null)), "concealed fixture certifies unchanged frame");
		concealed.visible = false;
		concealed.states.put(new BlockPos(2, 63, 0), Blocks.LAVA.defaultBlockState());
		check(concealedSnapshot.isCurrent(new SeenTerrain.Reader<>(concealedMemory, concealed, 3L, null)), "hidden lava after unchanged resume does not invalidate");
		check(concealedSnapshot.cellAt(support) == WalkabilityView.Cell.SAFE_SUPPORT, "retained hidden support keeps its acquired value");
		World pool = new World();
		for (int y = 64; y <= 68; y++) for (int x = 0; x <= 2; x++) pool.states.put(new BlockPos(x, y, 0), Blocks.WATER.defaultBlockState());
		SeenTerrain.Source<BlockState> poolSight = new SeenTerrain.Source<>() {
			@Override public BlockState live(int x, int y, int z) { return pool.live(x, y, z); }
			@Override public boolean sees(int x, int y, int z) { return x >= 0 && x <= 2 && z == 0 && y >= 63 && y <= 70; }
		};
		MinecraftNavigationWorld poolView = new MinecraftNavigationWorld(pool, new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), poolSight, 1L, null));
		LocalPathfinder.Search submerged = new LocalPathfinder().beginSearch(START, Set.of(GOAL), GOAL, 16, Set.of(), SwimPlanning.breathNodes(65));
		check(finish(submerged, poolView).outcome() == PathOutcome.NO_PATH && poolView.hasUnknown(), "near-reserve water fixture cannot route to unknown destination");
		SwimPlanning.Surface surface = SwimPlanning.nearestSurface(ServerNavigationController.columnView(poolView), 0, 65, 0);
		check(surface != null && surface.openY() == 69, "failed unknown route has an acquired open water surface");
		Vec3 feet = new Vec3(0.5D, 64D, 0.5D);
		check(poolView.knownSwimLine(feet, new Vec3(0.5D, 67.38D, 0.5D), new AABB(0.2D, 64D, 0.2D, 0.8D, 65.8D, 0.8D))
				&& SwimPlanning.surfacingFeasible(65, 3.38D), "known surface recovery fits clearance and available breath");
		// NAV-02 review: a slab-to-stair approach whose lower tread faces the slab is a 1.0 rise and a jump; a stair whose
		// tall half faces it (1.5 at the near face, lower tread behind) and a full block (1.5) are not.
		for (net.minecraft.core.Direction facing : new net.minecraft.core.Direction[] {net.minecraft.core.Direction.EAST, net.minecraft.core.Direction.WEST, null}) {
			boolean stair = facing == net.minecraft.core.Direction.EAST;
			World steps = new World();
			steps.states.put(new BlockPos(0, 63, 0), Blocks.STONE_SLAB.defaultBlockState());
			steps.states.put(new BlockPos(1, 64, 0), facing != null
					? Blocks.STONE_STAIRS.defaultBlockState().setValue(net.minecraft.world.level.block.StairBlock.FACING, facing)
					: Blocks.STONE.defaultBlockState());
			SeenTerrain.Source<BlockState> stepSight = new SeenTerrain.Source<>() {
				@Override public BlockState live(int x, int y, int z) { return steps.live(x, y, z); }
				@Override public boolean sees(int x, int y, int z) { return x >= -1 && x <= 2 && z >= -1 && z <= 1 && y >= 62 && y <= 67; }
			};
			MinecraftNavigationWorld stepView = new MinecraftNavigationWorld(steps, new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), stepSight, 1L, null));
			check(stepView.canJumpUp(new GridPosition(0, 64, 0), new GridPosition(1, 65, 0)) == stair,
					stair ? "a slab to a stair's lower tread is a jump" : facing != null
							? "a stair's tall half facing the slab blocks the jump to its far tread"
							: "a slab to a full block one level up is not an unboosted jump");
		}
		// NAV-02 review 3: on a diagonal the body reaches the low tread at the near corner and steps up (vanilla collision
		// probe), so an east-facing stair approached from the south-west is a jump; a west-facing one is not.
		for (net.minecraft.core.Direction facing : new net.minecraft.core.Direction[] {net.minecraft.core.Direction.EAST, net.minecraft.core.Direction.WEST}) {
			World diagonal = new World();
			diagonal.states.put(new BlockPos(0, 63, 0), Blocks.STONE_SLAB.defaultBlockState());
			diagonal.states.put(new BlockPos(1, 63, 1), Blocks.STONE.defaultBlockState());
			diagonal.states.put(new BlockPos(1, 64, 1), Blocks.OAK_STAIRS.defaultBlockState().setValue(net.minecraft.world.level.block.StairBlock.FACING, facing));
			SeenTerrain.Source<BlockState> diagonalSight = new SeenTerrain.Source<>() {
				@Override public BlockState live(int x, int y, int z) { return diagonal.live(x, y, z); }
				@Override public boolean sees(int x, int y, int z) { return x >= -1 && x <= 2 && z >= -1 && z <= 2 && y >= 62 && y <= 67; }
			};
			MinecraftNavigationWorld diagonalView = new MinecraftNavigationWorld(diagonal, new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), diagonalSight, 1L, null));
			boolean east = facing == net.minecraft.core.Direction.EAST;
			check(diagonalView.canJumpUp(new GridPosition(0, 64, 0), new GridPosition(1, 65, 1)) == east,
					east ? "a diagonal approach lands on the near-corner low tread and steps up" : "a tall half at the near corner blocks the diagonal jump");
		}
		// NAV-02 review 4: with full blocks at both side cells the body is stopped at the corner and never reaches the
		// near-corner tread; one bottom slab beside it leaves a way through.
		for (boolean bothBlocked : new boolean[] {true, false}) {
			World cornered = new World();
			cornered.states.put(new BlockPos(0, 63, 0), Blocks.STONE_SLAB.defaultBlockState());
			cornered.states.put(new BlockPos(1, 63, 1), Blocks.STONE.defaultBlockState());
			cornered.states.put(new BlockPos(1, 64, 1), Blocks.OAK_STAIRS.defaultBlockState().setValue(net.minecraft.world.level.block.StairBlock.FACING, net.minecraft.core.Direction.EAST));
			cornered.states.put(new BlockPos(1, 64, 0), Blocks.STONE.defaultBlockState());
			cornered.states.put(new BlockPos(0, 64, 1), bothBlocked ? Blocks.STONE.defaultBlockState() : Blocks.STONE_SLAB.defaultBlockState());
			SeenTerrain.Source<BlockState> corneredSight = new SeenTerrain.Source<>() {
				@Override public BlockState live(int x, int y, int z) { return cornered.live(x, y, z); }
				@Override public boolean sees(int x, int y, int z) { return x >= -1 && x <= 2 && z >= -1 && z <= 2 && y >= 62 && y <= 67; }
			};
			MinecraftNavigationWorld corneredView = new MinecraftNavigationWorld(cornered, new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), corneredSight, 1L, null));
			check(corneredView.canJumpUp(new GridPosition(0, 64, 0), new GridPosition(1, 65, 1)) != bothBlocked,
					bothBlocked ? "full blocks on both sides of the corner stop a diagonal jump" : "a bottom slab on one side leaves the diagonal jump open");
		}
		// NAV-02 review 5: air at foot level but stone at head height on both sides still stops the body at the corner.
		World overhang = new World();
		overhang.states.put(new BlockPos(0, 63, 0), Blocks.STONE_SLAB.defaultBlockState());
		overhang.states.put(new BlockPos(1, 63, 1), Blocks.STONE.defaultBlockState());
		overhang.states.put(new BlockPos(1, 64, 1), Blocks.OAK_STAIRS.defaultBlockState().setValue(net.minecraft.world.level.block.StairBlock.FACING, net.minecraft.core.Direction.EAST));
		overhang.states.put(new BlockPos(1, 65, 0), Blocks.STONE.defaultBlockState());
		overhang.states.put(new BlockPos(0, 65, 1), Blocks.STONE.defaultBlockState());
		SeenTerrain.Source<BlockState> overhangSight = new SeenTerrain.Source<>() {
			@Override public BlockState live(int x, int y, int z) { return overhang.live(x, y, z); }
			@Override public boolean sees(int x, int y, int z) { return x >= -1 && x <= 2 && z >= -1 && z <= 2 && y >= 62 && y <= 67; }
		};
		check(!new MinecraftNavigationWorld(overhang, new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), overhangSight, 1L, null))
				.canJumpUp(new GridPosition(0, 64, 0), new GridPosition(1, 65, 1)), "head-height stone at both corner sides stops a diagonal jump");
		// Swept-body jump: the body is moved through the jump against acquired collision shapes. One full block beside the
		// corner, a fence post at one side and a block at the other, or connected fence arms, stop a diagonal jump that a
		// side-column rule admitted (vanilla collision agrees); open sides and two unconnected posts still let it through.
		net.minecraft.world.level.block.state.BlockState eastStair = Blocks.OAK_STAIRS.defaultBlockState()
				.setValue(net.minecraft.world.level.block.StairBlock.FACING, net.minecraft.core.Direction.EAST);
		net.minecraft.world.level.block.state.BlockState fence = Blocks.OAK_FENCE.defaultBlockState();
		Object[][] sweptCases = {
				{null, Blocks.STONE.defaultBlockState(), false, "a full block at one side of the corner stops the diagonal jump"},
				{fence, Blocks.STONE.defaultBlockState(), false, "a fence post at one side and a full block at the other stop the diagonal jump"},
				{fence.setValue(net.minecraft.world.level.block.FenceBlock.SOUTH, true), fence.setValue(net.minecraft.world.level.block.FenceBlock.EAST, true),
						false, "fence arms reaching across the corner stop the diagonal jump"},
				{null, null, true, "an open corner keeps the diagonal jump onto the low tread"},
				{fence, fence, true, "two unconnected fence posts leave room to cut the corner"},
		};
		for (Object[] sweptCase : sweptCases) {
			World swept = new World();
			swept.states.put(new BlockPos(0, 63, 0), Blocks.STONE_SLAB.defaultBlockState());
			swept.states.put(new BlockPos(1, 64, 1), eastStair);
			if (sweptCase[0] != null) swept.states.put(new BlockPos(1, 64, 0), (BlockState) sweptCase[0]);
			if (sweptCase[1] != null) swept.states.put(new BlockPos(0, 64, 1), (BlockState) sweptCase[1]);
			SeenTerrain.Source<BlockState> sweptSight = new SeenTerrain.Source<>() {
				@Override public BlockState live(int x, int y, int z) { return swept.live(x, y, z); }
				@Override public boolean sees(int x, int y, int z) { return x >= -1 && x <= 2 && z >= -1 && z <= 2 && y >= 62 && y <= 67; }
			};
			MinecraftNavigationWorld sweptView = new MinecraftNavigationWorld(swept, new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), sweptSight, 1L, null));
			check(sweptView.canJumpUp(new GridPosition(0, 64, 0), new GridPosition(1, 65, 1)) == (Boolean) sweptCase[2], (String) sweptCase[3]);
		}
		// D1's retained motion: drop from y58 to y56, jump, hit basalt, then fall to lava at y50.
		// The route itself was not retained. Reproduce the unchecked gap edge with that six-block lava shaft.
		World trench = new World();
		trench.states.put(new BlockPos(1, 63, 0), Blocks.AIR.defaultBlockState());
		trench.states.put(new BlockPos(1, 57, 0), Blocks.LAVA.defaultBlockState());
		trench.states.put(new BlockPos(1, 66, 0), Blocks.BASALT.defaultBlockState());
		MinecraftNavigationWorld trenchView = sweptView(trench);
		GridPosition gapLanding = new GridPosition(2, 64, 0);
		check(trenchView.isGapClear(new GridPosition(1, 64, 0)) && trenchView.isStandable(gapLanding),
				"D1-shaped trench satisfies the old endpoint-only gap checks");
		check(trenchView.canJumpGap(START, gapLanding), "a low ceiling that still permits a short crossing remains legal");
		SeenTerrain.Source<BlockState> missingCeiling = new SeenTerrain.Source<>() {
			@Override public BlockState live(int x, int y, int z) { return trench.live(x, y, z); }
			@Override public boolean sees(int x, int y, int z) { return !(x == 1 && y == 66 && z == 0); }
		};
		MinecraftNavigationWorld uncertain = new MinecraftNavigationWorld(trench, new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), missingCeiling, 1L, null));
		check(!uncertain.canJumpGap(START, gapLanding), "unseen airborne clearance cannot authorize a jump over the lava shaft");
		trench.states.remove(new BlockPos(1, 66, 0));
		check(sweptView(trench).canJumpGap(START, gapLanding), "the same open gap remains jumpable");
		// PR #92 review: a ceiling hit stops the rise (vanilla zeroes vertical speed), so the body cannot float up again
		// past the overhang; a trapdoor just above the head at takeoff still leaves the jump open.
		World ceiling = new World();
		ceiling.states.put(new BlockPos(1, 64, 1), Blocks.STONE.defaultBlockState());
		ceiling.states.put(new BlockPos(1, 65, 0), Blocks.STONE.defaultBlockState());
		ceiling.states.put(new BlockPos(0, 66, 1), Blocks.OAK_TRAPDOOR.defaultBlockState()
				.setValue(net.minecraft.world.level.block.TrapDoorBlock.HALF, net.minecraft.world.level.block.state.properties.Half.TOP));
		check(!sweptView(ceiling).canJumpUp(new GridPosition(0, 64, 0), new GridPosition(1, 65, 1)),
				"an overhang the rising head hits ends the rise; the body does not float onto the block");
		World trapdoorHeadroom = new World();
		trapdoorHeadroom.states.put(new BlockPos(1, 64, 1), Blocks.STONE_SLAB.defaultBlockState());
		trapdoorHeadroom.states.put(new BlockPos(0, 65, 0), Blocks.OAK_TRAPDOOR.defaultBlockState()
				.setValue(net.minecraft.world.level.block.TrapDoorBlock.HALF, net.minecraft.world.level.block.state.properties.Half.TOP));
		check(sweptView(trapdoorHeadroom).canJumpUp(new GridPosition(0, 64, 0), new GridPosition(1, 65, 1)),
				"a trapdoor just above the head at takeoff still lets the diagonal hop onto a slab");
		// PR #92 review: scaffolding is solid only from above; beside the rising body it lets the body through.
		World scaffold = new World();
		scaffold.states.put(new BlockPos(0, 63, 0), Blocks.STONE_SLAB.defaultBlockState());
		scaffold.states.put(new BlockPos(1, 64, 1), eastStair);
		scaffold.states.put(new BlockPos(0, 64, 1), Blocks.SCAFFOLDING.defaultBlockState().setValue(net.minecraft.world.level.block.ScaffoldingBlock.DISTANCE, 0));
		scaffold.states.put(new BlockPos(0, 65, 1), Blocks.SCAFFOLDING.defaultBlockState().setValue(net.minecraft.world.level.block.ScaffoldingBlock.DISTANCE, 0));
		scaffold.states.put(new BlockPos(2, 64, 2), Blocks.STONE.defaultBlockState());
		check(sweptView(scaffold).canJumpUp(new GridPosition(0, 64, 0), new GridPosition(1, 65, 1)),
				"a scaffolding column beside the corner does not stop the diagonal jump");
		scaffold.states.put(new BlockPos(1, 64, 0), Blocks.STONE.defaultBlockState());
		scaffold.states.put(new BlockPos(0, 64, 1), Blocks.STONE.defaultBlockState());
		check(!sweptView(scaffold).canJumpUp(new GridPosition(0, 64, 0), new GridPosition(1, 65, 1)),
				"solid blocks at both corner sides still stop it");
		// Powder snow holds a body only by its boots and fall: that is not known here, so the earlier rules decide.
		World powder = new World();
		powder.states.put(new BlockPos(0, 63, 0), Blocks.STONE_SLAB.defaultBlockState());
		powder.states.put(new BlockPos(1, 64, 1), eastStair);
		powder.states.put(new BlockPos(1, 64, 0), Blocks.POWDER_SNOW.defaultBlockState());
		check(sweptView(powder).canJumpUp(new GridPosition(0, 64, 0), new GridPosition(1, 65, 1)),
				"powder snow at one side leaves the diagonal jump open to a body that sinks through it");
		// A slab onto a slab one level up rises 1 block; stone at head height over the takeoff leaves the body no room to rise.
		World overLanding = new World();
		overLanding.states.put(new BlockPos(0, 63, 0), Blocks.STONE_SLAB.defaultBlockState());
		overLanding.states.put(new BlockPos(1, 64, 0), Blocks.STONE_SLAB.defaultBlockState());
		SeenTerrain.Source<BlockState> overLandingSight = new SeenTerrain.Source<>() {
			@Override public BlockState live(int x, int y, int z) { return overLanding.live(x, y, z); }
			@Override public boolean sees(int x, int y, int z) { return x >= -1 && x <= 2 && z >= -1 && z <= 2 && y >= 62 && y <= 67; }
		};
		MinecraftNavigationWorld overLandingView = new MinecraftNavigationWorld(overLanding, new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), overLandingSight, 1L, null));
		check(overLandingView.canJumpUp(new GridPosition(0, 64, 0), new GridPosition(1, 65, 0)),
				"a slab onto a slab one level up is a jump with headroom over the landing");
		overLanding.states.put(new BlockPos(0, 66, 0), Blocks.STONE.defaultBlockState());
		MinecraftNavigationWorld lowCeiling = new MinecraftNavigationWorld(overLanding, new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), overLandingSight, 1L, null));
		check(!lowCeiling.canJumpUp(new GridPosition(0, 64, 0), new GridPosition(1, 65, 0)),
				"stone over the takeoff at head height leaves no room to rise onto the slab");
		World shore = new World();
		for (int x = -1; x <= 0; x++) shore.states.put(new BlockPos(x, 63, 0), Blocks.STONE.defaultBlockState());
		shore.states.put(new BlockPos(0, 64, 0), Blocks.WATER.defaultBlockState());
		shore.states.put(new BlockPos(0, 65, 0), Blocks.WATER.defaultBlockState());
		shore.states.put(new BlockPos(0, 66, 0), Blocks.STONE.defaultBlockState());
		SeenTerrain.Source<BlockState> shoreSight = new SeenTerrain.Source<>() {
			@Override public BlockState live(int x, int y, int z) { return shore.live(x, y, z); }
			@Override public boolean sees(int x, int y, int z) { return x >= -3 && x <= 3 && z >= -3 && z <= 3 && y >= 60 && y <= 70; }
		};
		MinecraftNavigationWorld shoreView = new MinecraftNavigationWorld(shore, new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), shoreSight, 1L, null));
		Vec3 shoreEye = new Vec3(0.5D, 65.62D, 0.5D);
		SwimPlanning.Surface dryShore = SwimPlanning.nearestSurface(ServerNavigationController.columnView(shoreView), 0, 65, 0);
		check(dryShore != null, "a covered pool beside a dry shore has a breathable column");
		Vec3 shoreFeet = new Vec3(0.5D, 64D, 0.5D);
		AABB shoreBox = new AABB(0.2D, 64D, 0.2D, 0.8D, 65.8D, 0.8D);
		Vec3 target = new Vec3(dryShore.x() + 0.5D, SwimPlanning.surfacingEyeY(dryShore.openY(), shoreEye.y), dryShore.z() + 0.5D);
		check(shoreView.knownSwimLine(shoreFeet, shoreFeet.add(target.subtract(shoreEye)), shoreBox),
				"the surfacing line toward the dry shore keeps the feet above its floor: " + dryShore);
		World shaft = new World();
		for (int y = 64; y <= 67; y++) for (int x = -1; x <= 1; x++) for (int z = -1; z <= 1; z++) {
			shaft.states.put(new BlockPos(x, y, z), x == 0 && z == 0
					? (y <= 65 ? Blocks.WATER.defaultBlockState() : Blocks.AIR.defaultBlockState()) : Blocks.STONE.defaultBlockState());
		}
		SeenTerrain.Source<BlockState> shaftSight = new SeenTerrain.Source<>() {
			@Override public BlockState live(int x, int y, int z) { return shaft.live(x, y, z); }
			@Override public boolean sees(int x, int y, int z) { return x >= -2 && x <= 2 && z >= -2 && z <= 2 && y >= 62 && y <= 69; }
		};
		MinecraftNavigationWorld shaftView = new MinecraftNavigationWorld(shaft, new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), shaftSight, 1L, null));
		Vec3 wallFeet = new Vec3(0.3D, 64D, 0.7D);
		AABB wallBody = new AABB(0.0D, 64D, 0.4D, 0.6D, 65.8D, 1.0D);
		check(shaftView.knownSwimLine(wallFeet, new Vec3(0.5D, 64.63D, 0.5D), wallBody),
				"a body pressed against a one-wide flooded shaft wall can still swim up its own column");
		check(!shaftView.knownSwimLine(wallFeet, new Vec3(1.5D, 64.63D, 0.5D), wallBody),
				"a surfacing line through the shaft wall stays blocked");
		World stairs = new World();
		for (int y = 63; y <= 68; y++) for (int z = -2; z <= 2; z++) for (int x = -1; x <= 1; x++) stairs.states.put(new BlockPos(x, y, z), Blocks.STONE.defaultBlockState());
		for (int y = 64; y <= 66; y++) stairs.states.put(new BlockPos(0, y, 1), Blocks.WATER.defaultBlockState());
		for (int y = 65; y <= 67; y++) stairs.states.put(new BlockPos(0, y, 0), Blocks.WATER.defaultBlockState());
		SeenTerrain.Source<BlockState> stairsSight = new SeenTerrain.Source<>() {
			@Override public BlockState live(int x, int y, int z) { return stairs.live(x, y, z); }
			@Override public boolean sees(int x, int y, int z) { return x >= -2 && x <= 2 && z >= -3 && z <= 3 && y >= 62 && y <= 69; }
		};
		MinecraftNavigationWorld stairsView = new MinecraftNavigationWorld(stairs, new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), stairsSight, 1L, null));
		Vec3 stepFeet = new Vec3(0.52D, 66.4D, 0.93D);
		AABB swimmer = new AABB(0.22D, 66.4D, 0.63D, 0.82D, 67.0D, 1.23D);
		check(stairsView.knownSwimLine(stepFeet, new Vec3(0.5D, 66.85D, 0.5D), swimmer),
				"a swimmer straddling a flooded stair step can rise into the next step past the corner it would clip");
		check(!stairsView.knownSwimLine(stepFeet, new Vec3(0.5D, 66.85D, -0.5D), swimmer),
				"a rise into the solid wall beyond the step stays blocked");
		stairs.states.put(new BlockPos(0, 68, 0), Blocks.AIR.defaultBlockState());
		MinecraftNavigationWorld stepView = new MinecraftNavigationWorld(stairs, new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), stairsSight, 1L, null));
		Vec3 lowFeet = new Vec3(0.44D, 64.64D, 1.58D), lowEye = lowFeet.add(0, 1.62D, 0);
		AABB standing = new AABB(0.14D, 64.64D, 1.28D, 0.74D, 66.44D, 1.88D);
		SwimPlanning.Surface stepAir = SwimPlanning.nearestSurface(ServerNavigationController.columnView(stepView), 0, 66, 1);
		check(stepAir != null && stepAir.path().get(1).equals(new BlockPos(0, 66, 0)), "the breath path steps across onto the raised flooded stair: " + stepAir);
		for (double eyeHeight : new double[] {0, 1.62D}) {
			Vec3 eyeTarget = new NavigationBreathing("BREATH_NOT_COVERED", 150, 10, false, 0)
					.tick(true, 150, lowEye, eyeHeight, new dev.agaminggod.arenaagents.server.perception.WaterAirFacts.SurfaceLookup(stepAir, false), 50, .2).eyeTarget();
			boolean clear = stepView.knownSwimLine(lowFeet, lowFeet.add(eyeTarget.subtract(lowEye)), standing);
			check(clear == (eyeHeight > 0), "a standing swimmer's step onto a raised stair " + (eyeHeight > 0 ? "lifts its feet over the step" : "without its eye height runs into the step"));
		}
		check(SwimPlanning.navigationBreathNodes(40, true) == 4, "a model-chosen breathable target can use the remaining reserve");
		check(SwimPlanning.navigationBreathNodes(40, false) == 0, "an ordinary dive still reports its breath limit");
		World frontierWorld = new World();
		SeenTerrain.Memory<BlockState> frontierMemory = new SeenTerrain.Memory<>();
		MinecraftNavigationWorld frontierView = view(frontierWorld, frontierMemory, 1L);
		LocalPathfinder.Search approach = search();
		GridPosition boundary = finish(approach, frontierView).nodes().getLast().position();
		check(approach.endedAtUnknown(), "frontier recheck fixture starts with an unknown continuation");
		LocalPathfinder.Search held = new LocalPathfinder().beginSearch(boundary, Set.of(GOAL), GOAL, 16, Set.of(boundary));
		held.allowStartFrontier();
		PathPlan unchangedBoundary = finish(held, view(frontierWorld, frontierMemory, 2L));
		check(unchangedBoundary.nodes().size() == 1 && unchangedBoundary.nodes().getLast().position().equals(boundary), "unchanged recheck retains the reached boundary instead of walking to a worse frontier");
		check(held.endedAtUnknown(), "unchanged frontier recheck remains honest about unseen continuation");
		frontierWorld.seenThrough = 5;
		LocalPathfinder.Search continued = new LocalPathfinder().beginSearch(boundary, Set.of(GOAL), GOAL, 16, Set.of(boundary));
		continued.allowStartFrontier();
		check(finish(continued, view(frontierWorld, frontierMemory, 3L)).nodes().getLast().position().equals(new GridPosition(5, 64, 0)), "newly acquired partial continuation advances the selected route");
		frontierWorld.seenThrough = 12;
		LocalPathfinder.Search revealed = new LocalPathfinder().beginSearch(boundary, Set.of(GOAL), GOAL, 16, Set.of(boundary));
		revealed.allowStartFrontier();
		check(finish(revealed, view(frontierWorld, frontierMemory, 4L)).nodes().getLast().position().equals(GOAL), "newly acquired full continuation reaches the selected goal");
		check(!revealed.endedAtUnknown(), "reached goal overrides the old frontier verdict");
		verifyContinuingSight();
		return assertions + NavigationContinuationVerification.verify() + SnowNavigationVerification.verify();
	}

	private static void verifyContinuingSight() {
		World world = new World();
		SeenTerrain.Memory<BlockState> memory = new SeenTerrain.Memory<>();
		java.util.LinkedHashSet<GridPosition> visited = new java.util.LinkedHashSet<>();
		GridPosition body = START;
		for (int through : new int[] {3, 6, 9, 12}) {
			world.seenThrough = through;
			LocalPathfinder.Search next = new LocalPathfinder().beginSearch(body, Set.of(GOAL), GOAL, 16, visited);
			PathPlan leg = finish(next, view(world, memory, through));
			check(leg.outcome() == PathOutcome.FOUND && leg.nodes().getLast().position().x() == through,
					"one target advances through each newly observed leg without a model call");
			for (var node : leg.nodes()) visited.add(node.position());
			body = leg.nodes().getLast().position();
			check(next.endedAtUnknown() == (through < 12), "only the final leg proves arrival");
			if (through == 3) {
				LocalPathfinder.Search empty = new LocalPathfinder().beginSearch(body, Set.of(GOAL), GOAL, 16, visited);
				check(finish(empty, view(world, memory, 4L)).outcome() == PathOutcome.NO_PATH,
						"unchanged sight cannot count the old approach as a new continuation");
			}
		}
		// The best available observed continuation can initially lead away from the target.
		World detour = new World();
		detour.seenThrough = 3;
		Set<GridPosition> approach = Set.of(START, new GridPosition(1, 64, 0), new GridPosition(2, 64, 0), new GridPosition(3, 64, 0));
		SeenTerrain.Source<BlockState> around = new SeenTerrain.Source<>() {
			@Override public BlockState live(int x, int y, int z) { return detour.live(x, y, z); }
			@Override public boolean sees(int x, int y, int z) { return x >= 0 && x <= 3 && z >= 0 && z <= 3 && y >= 63 && y <= 66; }
		};
		MinecraftNavigationWorld detourView = new MinecraftNavigationWorld(detour, new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), around, 1L, null));
		GridPosition edge = new GridPosition(3, 64, 0);
		LocalPathfinder.Search alternative = new LocalPathfinder().beginSearch(edge, Set.of(GOAL), GOAL, 16, approach);
		PathPlan away = finish(alternative, detourView);
		check(away.outcome() == PathOutcome.FOUND && !approach.contains(away.nodes().getLast().position()), "an untried observed frontier is selected");
		check(away.nodes().getLast().position().z() > edge.z(), "a temporary detour away from the target remains executable");
		Vec3 here = new Vec3(3.5D, 64D, 0.5D);
		Vec3 near = new Vec3(6D, 64D, 0.5D);
		check(!NavigationContinuation.nearUnseenTarget(view(detour, new SeenTerrain.Memory<>(), 2L), here, near, 1D), "unseen target cannot justify a near stop");
		SeenTerrain.Source<BlockState> nearSight = new SeenTerrain.Source<>() {
			@Override public BlockState live(int x, int y, int z) { return detour.live(x, y, z); }
			@Override public boolean sees(int x, int y, int z) { return (x <= detour.seenThrough || x == 6) && x >= 0 && z == 0 && y >= 63 && y <= 66; }
		};
		java.util.function.Supplier<MinecraftNavigationWorld> nearView = () -> new MinecraftNavigationWorld(detour, new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), nearSight, 2L, null));
		check(NavigationContinuation.nearUnseenTarget(nearView.get(), here, near, 1D), "seen standable target across unseen approach admits a factual non-success near stop");
		check(!NavigationContinuation.nearUnseenTarget(nearView.get(), here, near.add(0.1D, 0D, 0D), 1D), "farther unseen destination still needs continuation");
		check(NavigationContinuation.nearUnseenTarget(nearView.get(), here, near.add(0.4D, 0D, 0D), 3D), "requested tolerance above the tiny-distance cap remains honored");
		check(!NavigationContinuation.nearUnseenTarget(nearView.get(), here, near, 0.01D), "precise tolerance gets only bounded near slack");
		check(!NavigationContinuation.nearUnseenTarget(nearView.get(), here, near.add(0D, 1D, 0D), 1D), "a destination above a ledge is not reached near");
		for (BlockState obstacle : new BlockState[] {Blocks.STONE.defaultBlockState(), Blocks.LAVA.defaultBlockState(), Blocks.WATER.defaultBlockState()}) {
			detour.seenThrough = 4;
			detour.states.put(new BlockPos(4, 64, 0), obstacle);
			check(!NavigationContinuation.nearUnseenTarget(nearView.get(), here, near, 1D), "known obstruction or fluid cannot be called an unseen-only near stop");
		}
		detour.states.clear();
		detour.states.put(new BlockPos(4, 63, 0), Blocks.AIR.defaultBlockState());
		check(!NavigationContinuation.nearUnseenTarget(nearView.get(), here, near, 1D), "known drop does not satisfy unseen-only near arrival");
		detour.states.clear();
		detour.seenThrough = 12;
		check(!NavigationContinuation.nearUnseenTarget(nearView.get(), here, near, 1D), "fully observed target uses ordinary verified arrival");
	}

	public static void main(String[] args) { System.out.println("PASS: " + verify() + " seen navigation assertions"); }

	private static void check(boolean condition, String message) {
		assertions++;
		if (!condition) throw new AssertionError(message);
	}
}
