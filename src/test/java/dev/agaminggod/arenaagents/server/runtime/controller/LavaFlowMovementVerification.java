package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.client.navigation.PathNode;
import dev.agaminggod.arenaagents.client.navigation.TraversalType;
import dev.agaminggod.arenaagents.client.navigation.WalkabilityView;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

/**
 * d22-nether: flee_from ran the body beside a lava fall (lava level with its head one cell over) and it burned. Every
 * movement chooser shares the step probe, the short-path search and the route recheck; each must keep out of a seen
 * lava flow's way, and still let a body already in it walk out.
 */
public final class LavaFlowMovementVerification {
	private static int assertions;

	private LavaFlowMovementVerification() {
	}

	public static int verify() {
		assertions = 0;
		verifyProbe();
		verifyFleeHeading();
		verifyShortPaths();
		verifyRouteRecheck();
		verifySeenLavaOnly();
		return assertions;
	}

	/** Flat floor at y 63 over x/z -8..8; lava cells are hazards and flow into the cells beside them, as navigation reads it. */
	private static final class Floor implements WalkabilityView {
		final Set<GridPosition> lava = new HashSet<>();

		@Override
		public Cell cellAt(GridPosition p) {
			if (Math.abs(p.x()) > 8 || Math.abs(p.z()) > 8 || p.y() < 60 || p.y() > 70) return Cell.UNLOADED;
			if (lava.contains(p)) return Cell.HAZARD;
			if (p.y() == 63) return Cell.SAFE_SUPPORT;
			return p.y() >= 64 ? Cell.CLEAR : Cell.BLOCKED;
		}

		@Override
		public boolean lavaFlowsInto(GridPosition p) {
			if (lava.contains(p) || lava.contains(p.above()) || lava.contains(p.above(2))) return true;
			for (int[] d : new int[][] {{1, 0}, {-1, 0}, {0, 1}, {0, -1}}) {
				GridPosition side = p.offset(d[0], 0, d[1]);
				if (lava.contains(side) || lava.contains(side.above())) return true;
			}
			return false;
		}
	}

	// Yaw: 0 faces +z (south), -90 faces +x (east), 90 faces -x (west).
	private static void verifyProbe() {
		Floor world = new Floor();
		GridPosition feet = new GridPosition(0, 64, 0);
		check(CombatPlanning.canStep(world, feet, 0.0F), "open floor ahead is a step");
		// A lava fall one column beside the second cell ahead, level with the head (d22-nether: 1,35,97 beside 2,34,97).
		world.lava.add(new GridPosition(1, 65, 2));
		check(!CombatPlanning.canStep(world, feet, 0.0F), "a heading whose next cells a seen lava flow reaches is refused");
		CombatPlanning.Refusal why = CombatPlanning.refusal(world, feet, 0.0F);
		check(why != null && why.kind() == CombatPlanning.RefusalKind.HAZARD && why.at().equals(new GridPosition(0, 64, 2)),
				"the refusal names the cell the flow reaches as a hazard: " + why);
		check(CombatPlanning.canStep(world, feet, 180.0F), "the heading away from the flow stays open");
		check(CombatPlanning.canStep(world, feet, 90.0F), "a heading across, clear of the flow, stays open");
		// Already in the flow's way (lava beside the feet): crossing such cells to get out is allowed.
		world.lava.clear();
		world.lava.add(new GridPosition(-1, 64, 0));
		world.lava.add(new GridPosition(-1, 64, 1));
		check(world.lavaFlowsInto(feet), "fixture: lava beside the feet");
		check(CombatPlanning.canStep(world, feet, 0.0F), "a body already beside lava may walk along it to get out");
	}

	private static void verifyFleeHeading() {
		Floor world = new Floor();
		GridPosition feet = new GridPosition(0, 64, 0);
		// Straight away is south (+z); a lava fall at head height beside the way.
		world.lava.add(new GridPosition(1, 65, 2));
		CombatPlanning.Heading chosen = CombatPlanning.fleeHeading(world, feet, 0.0F, null);
		check(chosen.clear() && Math.abs(chosen.yaw()) >= 30.0F, "the flee turns off the heading lava flows across: " + chosen);
		// The sticky heading is not kept once a flow reaches it.
		CombatPlanning.Heading sticky = CombatPlanning.fleeHeading(world, feet, 10.0F, 0.0F);
		check(sticky.clear() && Math.abs(sticky.yaw()) >= 30.0F, "a heading already run is dropped once lava flows beside it: " + sticky);
		// Standing beside lava: the heading that leaves the flow's way wins over a straighter one along it.
		world.lava.clear();
		for (int z = -8; z <= 8; z++) world.lava.add(new GridPosition(-1, 64, z));
		CombatPlanning.Heading out = CombatPlanning.fleeHeading(world, feet, 0.0F, null);
		check(out.clear() && out.yaw() <= -30.0F, "beside a lava wall the flee steps away from it (east) before running on: " + out);
		// The flee's look-ahead view (unknown ground assumed level) still knows the flow.
		world.lava.clear();
		world.lava.add(new GridPosition(1, 65, 2));
		WalkabilityView look = ServerFleeController.assumingLevelGround(world, 64);
		check(look.lavaFlowsInto(new GridPosition(0, 64, 2)), "the flee's look view keeps known lava flows");
	}

	private static void verifyShortPaths() {
		Floor world = new Floor();
		GridPosition feet = new GridPosition(0, 64, 0);
		world.lava.add(new GridPosition(2, 65, 0));
		Map<GridPosition, GridPosition> reach = SafeStep.reachable(world, feet, 4, 400);
		check(!reach.containsKey(new GridPosition(1, 64, 0)) && !reach.containsKey(new GridPosition(3, 64, 0)),
				"take_cover, move_to_cell and sprint_away's way back never path into a seen lava flow");
		check(reach.containsKey(new GridPosition(0, 64, 2)), "cells clear of the flow stay reachable");
		List<GridPosition> away = SafeStep.awayPath(world, feet, -3.5D, 0.5D, 6, 400, 1.0D, cell -> false);
		check(away != null && away.stream().noneMatch(world::lavaFlowsInto), "the way back from a threat keeps out of the flow: " + away);
		// From inside a flow's way, the search still finds the way out.
		Floor in = new Floor();
		in.lava.add(new GridPosition(-1, 64, 0));
		Map<GridPosition, GridPosition> out = SafeStep.reachable(in, feet, 3, 400);
		check(out.containsKey(new GridPosition(2, 64, 0)), "a body beside lava can still reach cells away from it");
		// Standing in a single lava cell (leave_lava's start): the cells around it are in its way, and still the way out.
		Floor pool = new Floor();
		pool.lava.add(feet);
		Map<GridPosition, GridPosition> leave = SafeStep.reachable(pool, feet, 3, 400);
		check(leave.containsKey(new GridPosition(2, 64, 0)) && leave.containsKey(new GridPosition(0, 64, -2)),
				"a body in lava can path out across the cells beside it");
	}

	private static void verifyRouteRecheck() {
		Floor world = new Floor();
		List<PathNode> route = new ArrayList<>();
		for (int z = 0; z <= 8; z++) route.add(new PathNode(new GridPosition(0, 64, z), TraversalType.WALK));
		Set<GridPosition> accepted = ServerNavigationController.lavaContacts(world, route);
		check(accepted.isEmpty(), "no flow beside the route when it was chosen");
		check(!ServerNavigationController.lavaReachesRouteAhead(world, route, 1, accepted), "nothing to replan yet");
		world.lava.add(new GridPosition(1, 65, 4));
		check(ServerNavigationController.lavaReachesRouteAhead(world, route, 1, accepted),
				"fight_target's approach route is dropped once lava flows beside a cell ahead (as move_to replans)");
		check(!ServerNavigationController.lavaReachesRouteAhead(world, route, 1, ServerNavigationController.lavaContacts(world, route)),
				"a flow the route already paid for does not replan again");
		// Fire lit on a route cell ahead after the route was chosen (a hazard cell, as the floor reports seen fire).
		Floor fire = new Floor();
		Set<GridPosition> clear = ServerNavigationController.hazardCells(fire, route);
		check(!ServerNavigationController.hazardReachesRouteAhead(fire, route, 1, clear), "no fire on the route yet");
		fire.lava.add(new GridPosition(0, 64, 5));
		check(ServerNavigationController.hazardReachesRouteAhead(fire, route, 1, clear), "fire seen on a cell ahead replans the route");
		check(!ServerNavigationController.hazardReachesRouteAhead(fire, route, 1, ServerNavigationController.hazardCells(fire, route)),
				"fire the route was chosen through does not replan again");
		check(!ServerNavigationController.hazardReachesRouteAhead(fire, route, 6, clear), "fire behind the body is not news");
		List<GridPosition> path = route.stream().map(PathNode::position).toList();
		check(dev.agaminggod.arenaagents.server.runtime.reflex.ReflexTestAccess.newFlow(path, Set.of(), Set.of(new GridPosition(0, 64, 4)))
				.equals(new GridPosition(0, 64, 4)), "a reflex path walk names the cell a flow newly reaches");
		check(dev.agaminggod.arenaagents.server.runtime.reflex.ReflexTestAccess.newFlow(path, Set.of(new GridPosition(0, 64, 4)),
				Set.of(new GridPosition(0, 64, 4))) == null, "a flow the walk started beside is not news");
	}

	/** The terrain the player knows: lava it has seen flows; lava it has not seen is not planned around. */
	private static void verifySeenLavaOnly() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		BlockState air = Blocks.AIR.defaultBlockState(), stone = Blocks.STONE.defaultBlockState(), lava = Blocks.LAVA.defaultBlockState();
		Set<GridPosition> unseen = new HashSet<>();
		GridPosition flowAt = new GridPosition(1, 65, 0);
		ObservedTerrain.Known known = new ObservedTerrain.Known() {
			@Override
			public WalkabilityView.Cell cellAt(GridPosition p) {
				BlockState state = state(p);
				return state == null ? null : state == lava ? WalkabilityView.Cell.HAZARD
						: p.y() == 63 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
			}

			@Override
			public BlockState state(GridPosition p) {
				if (unseen.contains(p)) return null;
				if (p.equals(flowAt)) return lava;
				return p.y() <= 63 ? stone : air;
			}
		};
		GridPosition cell = new GridPosition(0, 64, 0);
		ObservedTerrain seen = new ObservedTerrain(known, null);
		check(seen.lavaFlowsInto(cell), "seen lava beside the head flows into the cell");
		check(seen.exposureCost(cell) == MinecraftNavigationWorld.LAVA_FLOW_COST, "fight and flee route searches cost it as navigation does");
		unseen.add(flowAt);
		ObservedTerrain hidden = new ObservedTerrain(known, null);
		check(!hidden.lavaFlowsInto(cell) && hidden.exposureCost(cell) == 0, "lava the player has not seen shapes no choice");
	}

	private static void check(boolean passed, String label) {
		assertions++;
		if (!passed) throw new AssertionError(label);
	}
}
