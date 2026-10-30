package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.client.navigation.*;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

public final class NetherCostsVerification {
	private static int assertions;
	private NetherCostsVerification() { }

	public static int verify() {
		assertions = 0;
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		BlockState air = Blocks.AIR.defaultBlockState();
		double sand = MinecraftNavigationWorld.movementSpeed(air, air, Blocks.SOUL_SAND.defaultBlockState(), 0, false);
		near((1.0D - 0.546D) / (1.0D - 0.546D * 0.4D), sand, "soul sand uses damped vanilla retained velocity");
		near(1.0D, MinecraftNavigationWorld.movementSpeed(air, air, Blocks.SOUL_SOIL.defaultBlockState(), 0, false), "soul soil has no vanilla slowdown");
		near(sand, MinecraftNavigationWorld.movementSpeed(air, air, Blocks.HONEY_BLOCK.defaultBlockState(), 0, false), "honey has vanilla 0.4 speed factor");
		for (int level = 1; level <= 3; level++) {
			double boost = 1.0D + (0.0405D + 0.0105D * (level - 1)) / 0.1D;
			near(boost, MinecraftNavigationWorld.movementSpeed(air, air, Blocks.SOUL_SAND.defaultBlockState(), level, false), "Soul Speed removes sand damping and adds vanilla attribute bonus");
			near(boost, MinecraftNavigationWorld.movementSpeed(air, air, Blocks.SOUL_SOIL.defaultBlockState(), level, false), "Soul Speed boosts soil too");
		}
		near(0.1135D, MinecraftNavigationWorld.movementSpeed(Blocks.COBWEB.defaultBlockState(), air, Blocks.STONE.defaultBlockState(), 0, false), "cobweb resets retained velocity");
		near(0.227D, MinecraftNavigationWorld.movementSpeed(air, Blocks.COBWEB.defaultBlockState(), Blocks.STONE.defaultBlockState(), 0, true), "head cobweb respects Weaving");
		check(MinecraftNavigationWorld.classifyCell(Blocks.POWDER_SNOW.defaultBlockState(), net.minecraft.world.phys.shapes.Shapes.empty(), false) == WalkabilityView.Cell.HAZARD, "powder snow already excluded for sinking and freezing");
		check(MinecraftNavigationWorld.classifyCell(Blocks.MAGMA_BLOCK.defaultBlockState(), net.minecraft.world.phys.shapes.Shapes.block(), false) == WalkabilityView.Cell.HAZARD, "magma is damaging when not sneaking");
		check(MinecraftNavigationWorld.classifyCell(Blocks.MAGMA_BLOCK.defaultBlockState(), net.minecraft.world.phys.shapes.Shapes.block(), false, true) == WalkabilityView.Cell.SAFE_SUPPORT, "Fire Resistance or Frost Walker makes magma support safe");
		check(!MinecraftNavigationWorld.canJump(air, air, Blocks.HONEY_BLOCK.defaultBlockState()), "honey jump factor cannot clear full steps or gaps");
		check(!MinecraftNavigationWorld.canJump(Blocks.COBWEB.defaultBlockState(), air, Blocks.STONE.defaultBlockState()), "cobwebs prevent full gap jumps");
		check(MinecraftNavigationWorld.canJump(air, air, Blocks.SOUL_SAND.defaultBlockState()), "soul sand retains vanilla jump height");
		near(1.0D, MinecraftNavigationWorld.movementSpeed(Blocks.WATER.defaultBlockState(), air, Blocks.SOUL_SAND.defaultBlockState(), 0, false), "water does not inherit ground damping");
		near(1.0D, MinecraftNavigationWorld.movementSpeed(air, air, Blocks.STONE.defaultBlockState(), 3, false), "boots do not speed ordinary ground");
		check(MovementCosts.stallTimeout(4_000, sand) == 6_887, "sand stall window scales with travel time");
		check(MovementCosts.stallTimeout(4_000, 1.615D) == 4_000, "fast boots do not shorten normal stall window");
		WaypointProgress progress = new WaypointProgress(2, 0, 4_000, 3);
		check(progress.observe(2, false, 4_000, sand).decision() == WaypointProgress.Decision.CONTINUE, "slow ground does not prematurely stall");
		check(progress.observe(2, false, 6_887, sand).decision() == WaypointProgress.Decision.REPLAN, "slow ground still detects a real stall");
		Fixture gap = new Fixture();
		gap.gap = new GridPosition(8, 64, 0);
		gap.below = WalkabilityView.Cell.HAZARD;
		check(gap.gapExposureCost(gap.gap) == 40, "lava or fire immediately below a jump adds exposure");
		gap.below = WalkabilityView.Cell.CLEAR;
		check(gap.gapExposureCost(gap.gap) == 40, "deep open gap adds exposure");
		gap.below = WalkabilityView.Cell.UNLOADED;
		check(gap.gapExposureCost(gap.gap) == 40, "unknown gap depth is not assumed safe");
		gap.below = WalkabilityView.Cell.SAFE_SUPPORT;
		check(gap.gapExposureCost(gap.gap) == 0, "shallow supported trench has no exposure penalty");
		gap.below = WalkabilityView.Cell.HAZARD;
		WalkabilityView crouchLanding = new WalkabilityView() {
			public Cell cellAt(GridPosition p) { return p.z() == 0 ? gap.cellAt(p) : Cell.UNLOADED; }
			public TraversalType traversalAt(GridPosition p) {
				TraversalType normal = WalkabilityView.super.traversalAt(p);
				return normal == TraversalType.WALK && p.x() == 9 ? TraversalType.CROUCH : normal;
			}
		};
		check(new LocalPathfinder().findPath(crouchLanding, new GridPosition(7, 64, 0), new GridPosition(9, 64, 0),
				128, 1_000_000_000, () -> 0).outcome() == PathOutcome.NO_PATH, "a regular jump cannot land on support that requires sneaking");
		check(crouchLanding.traversalAt(new GridPosition(9, 64, 0)) == TraversalType.CROUCH, "low ceilings retain real crouch traversal");
		// d14-iron-e: feet on soul sand at the lava sea's edge, a lava fall above the head and the sea one step down.
		BlockState lava = Blocks.LAVA.defaultBlockState(), rack = Blocks.NETHERRACK.defaultBlockState();
		java.util.Map<Long, BlockState> blocks = new java.util.HashMap<>();
		MinecraftNavigationWorld.StateRead read = (x, y, z) -> blocks.getOrDefault(net.minecraft.core.BlockPos.asLong(x, y, z), air);
		check(!MinecraftNavigationWorld.lavaExposure(read, 0, 64, 0), "no lava, no exposure");
		blocks.put(net.minecraft.core.BlockPos.asLong(0, 66, 0), lava);
		check(MinecraftNavigationWorld.lavaExposure(read, 0, 64, 0), "lava straight above the head pours into it and meets a jump");
		blocks.clear();
		blocks.put(net.minecraft.core.BlockPos.asLong(1, 62, 0), lava);
		check(MinecraftNavigationWorld.lavaExposure(read, 0, 64, 0), "lava one step down past an open support is a misstep away");
		blocks.put(net.minecraft.core.BlockPos.asLong(1, 63, 0), rack);
		check(!MinecraftNavigationWorld.lavaExposure(read, 0, 64, 0), "lava under a solid neighbouring block is not exposed");
		blocks.clear();
		blocks.put(net.minecraft.core.BlockPos.asLong(0, 65, 1), lava);
		check(MinecraftNavigationWorld.lavaExposure(read, 0, 64, 0), "lava beside the head is exposed");
		blocks.clear();
		blocks.put(net.minecraft.core.BlockPos.asLong(2, 64, 0), lava);
		check(!MinecraftNavigationWorld.lavaExposure(read, 0, 64, 0), "lava two cells away is not beside the body");
		// d22-lava: a flow coming down a slope beside the route's feet or head cell spreads into it; a pool one step down
		// past the support is a misstep, not a flow into the cell.
		check(!MinecraftNavigationWorld.lavaContact(read, 0, 64, 0), "lava two cells away does not flow into the cell yet");
		blocks.clear();
		blocks.put(net.minecraft.core.BlockPos.asLong(1, 64, 0), lava);
		check(MinecraftNavigationWorld.lavaContact(read, 0, 64, 0), "lava level with the feet beside the cell flows into it");
		blocks.clear();
		blocks.put(net.minecraft.core.BlockPos.asLong(0, 65, -1), lava);
		check(MinecraftNavigationWorld.lavaContact(read, 0, 64, 0), "lava beside the head flows down into the cell");
		blocks.clear();
		blocks.put(net.minecraft.core.BlockPos.asLong(0, 66, 0), lava);
		check(MinecraftNavigationWorld.lavaContact(read, 0, 64, 0), "lava over the head pours into the cell");
		blocks.clear();
		blocks.put(net.minecraft.core.BlockPos.asLong(1, 63, 0), lava);
		check(!MinecraftNavigationWorld.lavaContact(read, 0, 64, 0) && MinecraftNavigationWorld.lavaExposure(read, 0, 64, 0),
				"a lava pool level with the support is exposure beside the route, not a flow into it");
		check(MinecraftNavigationWorld.LAVA_FLOW_COST >= 10 * MinecraftNavigationWorld.LAVA_BESIDE_COST,
				"a cell lava flows into costs a long detour, far more than walking a lava shore");
		blocks.clear();
		WalkabilityView onlyJump = new WalkabilityView() {
			public Cell cellAt(GridPosition p) { return p.z() == 0 ? gap.cellAt(p) : Cell.UNLOADED; }
		};
		PathPlan jump = find(onlyJump);
		check(jump.outcome() == PathOutcome.FOUND, "dangerous gap jump remains legal if it is the only route");
		check(jump.nodes().stream().anyMatch(n -> n.traversal() == TraversalType.JUMP_GAP), "route crosses hazardous gap explicitly");
		for (String terrain : new String[]{"soul-sand-valley", "lava-ocean-shore", "basalt-deltas"}) {
			Fixture fixture = new Fixture();
			if (terrain.equals("soul-sand-valley")) fixture.slow = true;
			else fixture.lava = true;
			if (terrain.equals("basalt-deltas")) { fixture.gap = new GridPosition(8, 64, 0); fixture.below = WalkabilityView.Cell.HAZARD; }
			PathPlan before = find(new WalkabilityView() {
				public Cell cellAt(GridPosition p) { return fixture.cellAt(p); }
				public int gapExposureCost(GridPosition p) { return 0; }
			});
			PathPlan after = find(fixture);
			check(before.outcome() == PathOutcome.FOUND && after.outcome() == PathOutcome.FOUND, terrain + " both routes exist");
			check(after.nodes().stream().anyMatch(n -> n.position().z() > 0), terrain + " prefers safer or faster detour");
			check(after.estimatedTravelSeconds(fixture, false) > 0, terrain + " has a finite terrain ETA");
			check(!ServerNavigationController.clearWalkLine(fixture, new net.minecraft.world.phys.Vec3(0.5D, 64, 0.5D),
					new net.minecraft.world.phys.Vec3(16.5D, 64, 0.5D), 64), terrain + " steering cannot cut straight through the avoided terrain");
			check(ServerNavigationController.clearWalkLine(fixture, new net.minecraft.world.phys.Vec3(0.5D, 64, 1.5D),
					new net.minecraft.world.phys.Vec3(16.5D, 64, 1.5D), 64), terrain + " safe detour retains smooth steering");
			System.out.printf(java.util.Locale.ROOT, "NETHER_FIXTURE %s before length=%.1f eta=%.3f simulated=%.3f error=%.3f lavaCells=%d; after length=%.1f eta=%.3f simulated=%.3f error=%.3f lavaCells=%d%n",
					terrain, length(before), before.estimatedTravelSeconds(p -> fixture.cellAt(p), false), simulate(before, fixture),
					Math.abs(before.estimatedTravelSeconds(p -> fixture.cellAt(p), false) - simulate(before, fixture)), lavaCells(before, fixture),
					length(after), after.estimatedTravelSeconds(fixture, false), simulate(after, fixture),
					Math.abs(after.estimatedTravelSeconds(fixture, false) - simulate(after, fixture)), lavaCells(after, fixture));
		}
		// A jump over fire overlaps the fire's whole-cube inside shape below its top: no gap jump over fire or lava.
		check(!((WalkabilityView) p -> WalkabilityView.Cell.HAZARD).isGapClear(new GridPosition(0, 64, 0)), "a fire or lava gap is never jumped");
		java.util.Map<Long, BlockState> flames = new java.util.HashMap<>();
		MinecraftNavigationWorld.StateRead flameRead = (x, y, z) -> flames.getOrDefault(net.minecraft.core.BlockPos.asLong(x, y, z), Blocks.AIR.defaultBlockState());
		check(!MinecraftNavigationWorld.fireBeside(flameRead, 0, 64, 0), "no fire, no fire exposure");
		flames.put(net.minecraft.core.BlockPos.asLong(1, 64, 1), Blocks.FIRE.defaultBlockState());
		check(MinecraftNavigationWorld.fireBeside(flameRead, 0, 64, 0), "fire diagonally beside the feet is exposure");
		flames.clear();
		flames.put(net.minecraft.core.BlockPos.asLong(-1, 65, 0), Blocks.SOUL_FIRE.defaultBlockState());
		check(MinecraftNavigationWorld.fireBeside(flameRead, 0, 64, 0), "soul fire beside the head is exposure");
		flames.clear();
		flames.put(net.minecraft.core.BlockPos.asLong(2, 64, 0), Blocks.FIRE.defaultBlockState());
		check(!MinecraftNavigationWorld.fireBeside(flameRead, 0, 64, 0), "fire two cells away is not beside the body");
		check(((WalkabilityView) p -> WalkabilityView.Cell.WATER).isGapClear(new GridPosition(0, 64, 0)), "water gap remains jumpable");
		WalkabilityView open = p -> p.y() == 63 ? WalkabilityView.Cell.SAFE_SUPPORT : p.y() >= 64 ? WalkabilityView.Cell.CLEAR : WalkabilityView.Cell.BLOCKED;
		for (int[] destination : new int[][]{{30, 30, 60}, {60, 20, 80}}) {
			PathPlan route = new LocalPathfinder().findPath(open, new GridPosition(0, 64, 0), new GridPosition(destination[0], 64, destination[1]), 8192, 1_000_000_000, () -> 0);
			check(route.outcome() == PathOutcome.FOUND && route.expandedNodes() == destination[2], "open route matches main node expansion count " + destination[0] + "x" + destination[1] + ": " + route.expandedNodes());
		}
		for (boolean bridge : new boolean[]{false, true}) {
			WalkabilityView lavaRoute = new WalkabilityView() {
				public Cell cellAt(GridPosition p) { return bridge && p.z() != 0 ? Cell.HAZARD : open.cellAt(p); }
				public int exposureCost(GridPosition p) { return bridge || p.z() == 0 ? 12 : 0; }
			};
			PathPlan route = new LocalPathfinder().findPath(lavaRoute, new GridPosition(0, 64, 0), new GridPosition(40, 64, 0), 8192, 1_000_000_000, () -> 0);
			check(route.outcome() == PathOutcome.FOUND && route.expandedNodes() == (bridge ? 54 : 85), "lava " + (bridge ? "bridge" : "shore") + " retains bounded expansions: " + route.expandedNodes());
		}
		verifyDropMovement();
		return assertions;
	}

	private static void verifyDropMovement() {
		for (boolean departure : new boolean[]{true, false}) {
			WalkabilityView steps = new WalkabilityView() {
				public Cell cellAt(GridPosition p) {
					if (p.z() != 0 || p.x() < 0 || p.x() > 1) return Cell.UNLOADED;
					int floor = p.x() == 0 ? 64 : 63;
					return p.y() == floor ? Cell.SAFE_SUPPORT : p.y() > floor ? Cell.CLEAR : Cell.BLOCKED;
				}
			};
			GridPosition start = new GridPosition(0, 65, 0), end = new GridPosition(1, 64, 0);
			WalkabilityView unprotected = p -> p.equals((departure ? start : end).below()) ? WalkabilityView.Cell.HAZARD : steps.cellAt(p);
			PathPlan blocked = new LocalPathfinder().findPath(unprotected, start, end, 128, 1_000_000_000, () -> 0);
			check(blocked.outcome() != PathOutcome.FOUND, "unprotected magma cannot support drop departure or landing");
			WalkabilityView protectedGround = steps::cellAt;
			PathPlan allowed = new LocalPathfinder().findPath(protectedGround, start, end, 128, 1_000_000_000, () -> 0);
			check(allowed.outcome() == PathOutcome.FOUND, "protected magma admits normal drop movement");
			check(allowed.nodes().getLast().traversal() == TraversalType.DROP_DOWN, "protected drop uses ordinary drop traversal");
		}
	}

	private static PathPlan find(WalkabilityView view) {
		return new LocalPathfinder().findPath(view, new GridPosition(0, 64, 0), new GridPosition(16, 64, 0), 8192, 1_000_000_000, () -> 0);
	}
	private static double length(PathPlan plan) {
		double length = 0;
		for (int i = 1; i < plan.nodes().size(); i++) {
			GridPosition a = plan.nodes().get(i - 1).position(), b = plan.nodes().get(i).position();
			length += Math.hypot(b.x() - a.x(), b.z() - a.z());
		}
		return length;
	}
	private static long lavaCells(PathPlan plan, Fixture f) { return plan.nodes().stream().filter(n -> f.exposureCost(n.position()) > 0).count(); }
	/** Independent 20 Hz vanilla ground recurrence, including acceleration from rest and terrain transitions. */
	private static double simulate(PathPlan plan, Fixture f) {
		double travelled = 0, retained = 0, total = length(plan);
		int ticks = 0;
		while (travelled < total) {
			double cursor = 0;
			GridPosition cell = plan.nodes().getLast().position();
			for (int i = 1; i < plan.nodes().size(); i++) {
				GridPosition a = plan.nodes().get(i - 1).position(), b = plan.nodes().get(i).position();
				double edge = Math.hypot(b.x() - a.x(), b.z() - a.z());
				if (travelled < cursor + edge) { cell = travelled - cursor < edge / 2 ? a : b; break; }
				cursor += edge;
			}
			double movement = retained + 0.098D;
			travelled += movement;
			retained = movement * (f.isSlow(cell) ? 0.4D : 1.0D) * 0.546D;
			ticks++;
		}
		return ticks / 20.0D;
	}
	private static void near(double expected, double actual, String label) { check(Math.abs(expected - actual) < 0.00001D, label + ": " + actual); }
	private static void check(boolean passed, String label) { assertions++; if (!passed) throw new AssertionError(label); }

	private static final class Fixture implements WalkabilityView {
		boolean slow, lava;
		GridPosition gap;
		Cell below = Cell.CLEAR;
		boolean isSlow(GridPosition p) { return slow && p.z() == 0 && p.x() > 0 && p.x() < 16; }
		public double movementSpeedMultiplier(GridPosition p) { return isSlow(p) ? MovementCosts.groundSpeedMultiplier(0.4D, 0) : 1.0D; }
		public int exposureCost(GridPosition p) { return lava && p.z() == 0 && p.x() > 0 && p.x() < 16 ? 12 : 0; }
		public Cell cellAt(GridPosition p) {
			if (p.x() < 0 || p.x() > 16 || p.z() < 0 || p.z() > 3 || p.y() > 67) return Cell.UNLOADED;
			if (gap != null && p.x() == gap.x() && p.z() == gap.z() && p.y() < 64) return below;
			if (p.y() == 63) return Cell.SAFE_SUPPORT;
			return p.y() >= 64 ? Cell.CLEAR : Cell.BLOCKED;
		}
	}
}
