package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.client.navigation.WalkabilityView;
import dev.agaminggod.arenaagents.server.perception.SeenTerrain;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/** Uses vanilla block collision shapes and the production acquired-terrain, reach and stop-fact paths. */
public final class FightFactsVerification {
	private static int assertions;

	public static int verify() {
		assertions = 0;
		verifyBlazeAboveFence();
		verifyLedgeAndUnknownLines();
		verifyBailoutFacts();
		verifyFastFailRepeat();
		return assertions;
	}

	private static MeleeReach.ReachCells cells(World world, SeenTerrain.Reader<BlockState> seen, AABB box) {
		var view = new ObservedTerrain(ObservedTerrain.known(seen, world, false, 0, false), null);
		var geometry = new AcquiredGeometry(world, p -> view.stateAt(new GridPosition(p.getX(), p.getY(), p.getZ())));
		var cells = new MeleeReach.ReachCells(box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ, 3D,
				cell -> MeleeReach.knownHit(cell, box, 0D, 3D, geometry));
		check(cells.advance(view, () -> true), "reach cell computation completes");
		return cells;
	}

	private static void verifyBlazeAboveFence() {
		World world = new World();
		check(cells(world, world.reader(0), new AABB(3.4D, 64D, .2D, 4D, 65.8D, .8D)).cells().contains(new GridPosition(0, 64, 0)),
				"an observed cell 2.9m from the hitbox is included within vanilla 3m reach");
		for (int z = -3; z <= 3; z++) world.states.put(new BlockPos(2, 64, z), Blocks.NETHER_BRICK_FENCE.defaultBlockState()
				.setValue(net.minecraft.world.level.block.state.properties.BlockStateProperties.NORTH, true)
				.setValue(net.minecraft.world.level.block.state.properties.BlockStateProperties.SOUTH, true));
		// Blaze hovers just behind a 1.5-block fence; its exposed top can be hit from an offset cell.
		AABB blaze = new AABB(3.2D, 65D, .2D, 3.8D, 66.8D, .8D);
		var seen = world.reader(0);
		var result = cells(world, seen, blaze);
		check(!result.cells().isEmpty(), "blaze above a fence has observed melee cells");
		check(result.cells().stream().anyMatch(cell -> cell.x() == 1 && cell.y() == 64),
				"an exposed blaze top across the fence is hittable within vanilla reach");
		check(result.cells().stream().noneMatch(cell -> cell.x() == 2 && cell.y() == 64),
				"fence body cells are not standable melee positions");
		AABB low = new AABB(3.2D, 64D, .2D, 3.8D, 64.4D, .8D);
		check(!cells(world, world.reader(1), low).cells().contains(new GridPosition(1, 64, 0)),
				"being in distance range through a fence is not a clear melee line");
	}

	private static void verifyLedgeAndUnknownLines() {
		World world = new World();
		for (int x = 5; x <= 7; x++) for (int y = 64; y <= 78; y++) for (int z = -1; z <= 1; z++) {
			world.states.put(new BlockPos(x, y, z), Blocks.NETHER_BRICKS.defaultBlockState());
		}
		AABB target = new AABB(6.2D, 79D, -.3D, 6.8D, 80.8D, .3D);
		var goals = cells(world, world.reader(0), target).cells();
		check(!goals.isEmpty() && goals.stream().allMatch(cell -> cell.y() == 79), "ledge target exposes only the ledge's standable cells");
		var origin = new Vec3(.5D, 64D, .5D);
		var nearest = FightFacts.nearest(goals, origin, cell -> true);
		check(nearest != null && FightFacts.distance(origin, nearest) > 15D, "nearest ledge cell reports actual 3D distance");
		World hidden = new World();
		hidden.hiddenX = 2;
		AABB close = new AABB(3.2D, 64D, .2D, 3.8D, 65.8D, .8D);
		var unknown = cells(hidden, hidden.reader(0), close);
		check(!unknown.cells().contains(new GridPosition(1, 64, 0)) && unknown.undetermined() > 0,
				"unseen ray cells cannot certify a clear hit or prove no spot exists");
		var geometry = new AcquiredGeometry(hidden, p -> p.getX() == 2 ? null : hidden.getBlockState(p));
		check(!MeleeReach.clearHit(new GridPosition(3, 64, 0), close, 2.5D, 3D, (eye, hit) -> true),
				"a weapon minimum reach excludes too-close cells even with an open hit line");
		check(!geometry.clearLine(new Vec3(1.5D, 65.62D, .5D), new Vec3(3.2D, 65D, .5D)), "unknown collision stays unknown on the real ray path");
	}

	private static void verifyBailoutFacts() {
		String burning = FightFacts.body(true, 0D, true, 100, null);
		check(burning.contains("input idle") && burning.contains("stationary") && burning.contains("onFire=true (5.0s)")
				&& burning.contains("contact=none"), "low-health stop on dry ground honestly remains idle and burning");
		check(FightFacts.body(false, .1D, true, 20, HazardExits.Contact.LAVA).contains("input active, motion moving")
				&& FightFacts.body(true, 0D, true, 20, HazardExits.Contact.FIRE).contains("contact=fire"),
				"other input ownership, physical motion and fire/lava contact remain distinct");
		World world = new World();
		world.states.put(new BlockPos(0, 64, 0), Blocks.FIRE.defaultBlockState());
		world.states.put(new BlockPos(2, 64, 0), Blocks.WATER.defaultBlockState());
		var seen = world.reader(0);
		String options = FightFacts.options(seen, new ObservedTerrain(ObservedTerrain.known(seen, world, false, 0, false), null),
				new Vec3(.5D, 64D, .5D), new GridPosition(0, 64, 0));
		check(options.contains("water: (2.5,64,0.5) 2.0m"), "burning bailout reports the nearest observed extinguishing water");
		check(options.contains("non-burning ground:") && !options.contains("non-burning ground: (0.5,64,0.5)"), "burning feet are not safe ground");
		check(options.contains("ground does not extinguish") && options.contains("routes unverified"), "ground is not mislabeled as extinguishing or reachable");
		world.hiddenX = 2;
		var unknown = world.reader(1);
		check(FightFacts.options(unknown, new ObservedTerrain(ObservedTerrain.known(unknown, world, false, 0, false), null),
				new Vec3(.5D, 64D, .5D), new GridPosition(0, 64, 0)).contains("water: none known"), "hidden water does not leak into bailout facts");
	}

	private static void verifyFastFailRepeat() {
		var id = new UUID(0, 1);
		var body = new Vec3(.5D, 64D, .5D);
		var box = new AABB(3.2D, 67D, .2D, 3.8D, 68.8D, .8D);
		var state = retry(id, body, box, 3D);
		check(state.unchanged(state, 100, 101, true, true), "identical immediate repeat can fail before approach movement or timeout");
		check(state.unchanged(state, 100, 200, true, true), "repeat facts stay reusable for the short window");
		check(!state.unchanged(state, 100, 201, true, true) && !state.unchanged(state, 100, 99, true, true), "old or rewound game time requires a new check");
		check(!state.unchanged(retry(new UUID(0, 2), body, box, 3D), 100, 101, true, true), "a different target is never suppressed");
		check(!state.unchanged(retry(id, body.add(1, 0, 0), box, 3D), 100, 101, true, true), "repositioning retries the approach");
		check(!state.unchanged(retry(id, body, box.move(0, .1D, 0), 3D), 100, 101, true, true), "changed blaze hover height invalidates reach facts");
		check(!state.unchanged(retry(id, body, box, 4D), 100, 101, true, true), "changed vanilla weapon reach allows a fresh approach");
		var protectedBody = new ServerFightController.RetryState(id, body, box, 3D, CombatPlanning.TargetPolicy.NAMED, false, false, 0F, 0F, 300, true);
		check(!state.unchanged(protectedBody, 100, 101, true, true), "new magma protection can open a route and invalidates the retry cache");
		check(!state.unchanged(state, 100, 101, false, true) && !state.unchanged(state, 100, 101, true, false), "newly acquired terrain or equipment invalidates the prior facts");
	}

	private static ServerFightController.RetryState retry(UUID id, Vec3 body, AABB box, double range) {
		return new ServerFightController.RetryState(id, body, box, range, CombatPlanning.TargetPolicy.NAMED, false, false, 0F, 0F, 300, false);
	}

	private static final class World implements BlockGetter, SeenTerrain.Source<BlockState> {
		final Map<BlockPos, BlockState> states = new HashMap<>();
		int hiddenX = Integer.MIN_VALUE;
		SeenTerrain.Reader<BlockState> reader(long tick) { return new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), this, tick, null); }
		@Override public BlockState live(int x, int y, int z) { return getBlockState(new BlockPos(x, y, z)); }
		@Override public boolean sees(int x, int y, int z) { return x != hiddenX; }
		@Override public BlockState getBlockState(BlockPos p) { return states.getOrDefault(p, p.getY() <= 63 ? Blocks.NETHER_BRICKS.defaultBlockState() : Blocks.AIR.defaultBlockState()); }
		@Override public BlockEntity getBlockEntity(BlockPos p) { throw new AssertionError("hidden block entity read"); }
		@Override public FluidState getFluidState(BlockPos p) { return getBlockState(p).getFluidState(); }
		@Override public int getHeight() { return 256; }
		@Override public int getMinY() { return 0; }
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
