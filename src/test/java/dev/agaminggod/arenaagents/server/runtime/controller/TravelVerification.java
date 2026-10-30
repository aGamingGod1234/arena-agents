package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.client.navigation.PathNode;
import dev.agaminggod.arenaagents.client.navigation.TraversalType;
import dev.agaminggod.arenaagents.client.navigation.WalkabilityView;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

/** travel_to's pure choices: seen checkpoints, build moves, and navigation's line-up before a step into a notch. */
public final class TravelVerification {
	private static int assertions;

	private TravelVerification() {
	}

	public static int verify() {
		assertions = 0;
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		verifyCheckpoints();
		verifyNarrowRidge();
		verifyBuildMoves();
		verifyJumpLineUp();
		verifyFeetCell();
		verifyColumnStanding();
		verifyBuildingBlocks();
		verifyCarriedSupplies();
		return assertions;
	}

	private static void verifyCheckpoints() {
		GridPosition start = new GridPosition(0, 64, 0);
		int marched = 0;
		for (int z = 4; z <= 12; z += 4) {
			GridPosition end = new GridPosition(0, 64, z);
			marched += ServerTravelController.marchedCells(start, end);
			start = end;
		}
		check(marched == 12 && marched >= ServerTravelController.BUILD_RUN,
				"three four-cell tunnel strides must reach the ten-cell replanning budget, not count as three moves");
		check(ServerTravelController.marchedCells(start, start) == 0,
				"mining or clearing fire without moving does not consume or subtract travelled cells");
		check(ServerTravelController.marchedCells(start, start.offset(-4, 0, 0)) == 4
				&& ServerTravelController.marchedCells(start, start.above(2)) == 2,
				"westward strides and pillars use the same physical-cell budget");
		Grid uphill = new Grid();
		uphill.seenUpTo = 64;
		for (int z = 0; z <= 40; z++) uphill.floor(-1, 1, z, z, 63 + z);
		var uphillLeg = TravelCheckpoints.walkingPick(uphill, 0.5, 64, 0.5, 0.5, Double.NaN, 40.5, 48,
				cell -> false, java.util.List.of());
		check(uphillLeg != null && uphillLeg.feet().y() > 64,
				"long travel legs retain a nearby acquired uphill checkpoint inside the height scan: " + uphillLeg);
		Grid flat = new Grid();
		flat.floor(-40, 40, -40, 40, 63);
		flat.seenUpTo = 30;
		TravelCheckpoints.Checkpoint east = TravelCheckpoints.pick(flat, 0.5, 64, 0.5, 200.5, Double.NaN, 0.5, 26, cell -> false);
		check(east != null && east.feet().y() == 64 && east.feet().x() >= 24 && Math.abs(east.feet().z()) <= 1,
				"open seen ground: the checkpoint is a full leg straight toward the target: " + east);
		TravelCheckpoints.Checkpoint near = TravelCheckpoints.pick(flat, 0.5, 64, 0.5, 10.5, Double.NaN, 3.5, 26, cell -> false);
		check(near != null && near.finalApproach() && near.feet().x() == 10 && near.feet().z() == 3, "a target within a leg is stood on directly: " + near);
		var shortFinal = TravelCheckpoints.walkingPick(flat, 0.5, 64, 2.1, 0.5, 64, 0.5, 48,
				cell -> false, java.util.List.of());
		check(shortFinal != null && shortFinal.finalApproach() && shortFinal.feet().equals(new GridPosition(0, 64, 0)),
				"a connected 1.6-block final retrace leg is allowed below the intermediate minimum gain: " + shortFinal);
		TravelCheckpoints.Checkpoint refused = TravelCheckpoints.pick(flat, 0.5, 64, 0.5, 200.5, Double.NaN, 0.5, 26,
				cell -> cell.x() >= 20 && Math.abs(cell.z()) <= 8);
		check(refused != null && !(refused.feet().x() >= 20 && Math.abs(refused.feet().z()) <= 8), "a refused leg is not picked again: " + refused);
		Grid wall = new Grid();
		wall.floor(-40, 40, -40, 40, 63);
		wall.seenUpTo = 30;
		for (int z = -40; z <= 40; z++) for (int y = 64; y <= 80; y++) for (int x = 3; x <= 40; x++) wall.solid.add(new GridPosition(x, y, z));
		check(TravelCheckpoints.pick(wall, 0.5, 64, 0.5, 200.5, Double.NaN, 0.5, 26, cell -> false) == null,
				"no seen spot gets closer behind a wall: no checkpoint, so the body builds");
		GridPosition side = TravelCheckpoints.detour(wall, 0.5, 64, 0.5, 200.5, 0.5, cell -> false);
		check(side != null && side.x() < 3 && Math.abs(side.z()) >= 4, "a blocked bearing tries a seen sideways leg before NO_ROUTE");
		check(TravelCheckpoints.detour(wall, 0.5, 64, 0.5, 200.5, 0.5, cell -> true) == null,
				"refused detours are never retried");
		Grid islands = new Grid();
		islands.floor(-2, 17, -2, 2, 63);
		islands.floor(24, 31, -2, 2, 63);
		islands.seenUpTo = 64;
		TravelCheckpoints.Checkpoint connected = TravelCheckpoints.walkingPick(islands, 0.5, 64, 0.5,
				200.5, Double.NaN, 0.5, 48, cell -> false, java.util.List.of());
		check(connected != null && connected.feet().x() <= 17 && connected.feet().x() >= 10,
				"prefer a connected walking leg over the farther disconnected island: " + connected);
		Grid disconnected = new Grid();
		disconnected.floor(-2, 2, -2, 2, 63);
		disconnected.floor(24, 31, -2, 2, 63);
		disconnected.seenUpTo = 64;
		var frontier = TravelCheckpoints.walkingPick(disconnected, 0.5, 64, 0.5, 200.5, Double.NaN, 0.5,
				48, cell -> false, java.util.List.of());
		check(frontier == null || frontier.feet().x() <= 2, "an unreachable island is never substituted for the acquired near frontier");
		Grid bowl = new Grid();
		bowl.floor(-10, 31, -11, 11, 63);
		bowl.seenUpTo = 64;
		for (int by = 64; by <= 65; by++) {
			for (int bz = -8; bz <= 8; bz++) bowl.solid.add(new GridPosition(1, by, bz));
			for (int bx = -6; bx <= 1; bx++) for (int bz : new int[] {-8, 8}) bowl.solid.add(new GridPosition(bx, by, bz));
		}
		TravelCheckpoints.Checkpoint escape = TravelCheckpoints.walkingPick(bowl, 0.5, 64, 0.5,
				200.5, Double.NaN, 0.5, 48, cell -> false, java.util.List.of());
		check(escape != null && escape.backtrack() > ServerTravelController.BACKTRACK,
				"a connected route out of a bowl retains its necessary temporary retreat: " + escape);
		Grid longDetour = new Grid();
		longDetour.floor(-52, 52, -52, 52, 63);
		longDetour.seenUpTo = 64;
		for (int y = 64; y <= 65; y++) for (int z = -30; z <= 30; z++) longDetour.solid.add(new GridPosition(1, y, z));
		var pending = TravelCheckpoints.beginWalkingPick(longDetour, 0.5, 64, 0.5, 200.5, Double.NaN, 0.5, 48,
				cell -> false, java.util.List.of());
		check(pending != null, "the detour has acquired candidate endpoints");
		var firstSlice = pending.advance(longDetour);
		check(firstSlice == null && !pending.finished(), "one search slice cannot yet establish the long detour");
		TravelCheckpoints.Checkpoint detourRoute = null;
		int slices = 1;
		while (!pending.finished() && slices++ < 100) detourRoute = pending.advance(longDetour);
		check(pending.finished() && detourRoute != null, "retaining the search finds the connected route after " + slices + " slices");
		Grid unseen = new Grid();
		unseen.floor(-40, 40, -40, 40, 63);
		unseen.seenUpTo = 2;
		check(TravelCheckpoints.pick(unseen, 0.5, 64, 0.5, 200.5, Double.NaN, 0.5, 26, cell -> false) == null,
				"unseen ground is never a checkpoint");
		check(TravelCheckpoints.detour(unseen, 0.5, 64, 0.5, 200.5, 0.5, cell -> false) == null,
				"a detour never uses unseen standing ground");
		Grid ridge = new Grid();
		ridge.floor(-40, 40, -40, 40, 63);
		ridge.seenUpTo = 30;
		for (int x = 10; x <= 40; x++) for (int z = -40; z <= 40; z++) if (Math.abs(z) < 12) ridge.solid.add(new GridPosition(x, 64, z));
		TravelCheckpoints.Checkpoint around = TravelCheckpoints.pick(ridge, 0.5, 64, 0.5, 200.5, Double.NaN, 0.5, 26, cell -> false);
		check(around != null && around.feet().y() == 64 + 1 || around != null && Math.abs(around.feet().z()) >= 12,
				"a raised block field ahead is climbed onto or passed beside: " + around);
		// Lava seen down a cave almost straight below the body: no floor at the target, a seen cave floor 8 down beside it.
		Grid cave = new Grid();
		cave.floor(-1, 1, -1, 1, 63);
		cave.floor(2, 14, -3, 3, 55);
		TravelCheckpoints.Checkpoint down = TravelCheckpoints.pick(cave, 0.5, 64, 0.5, 0.5, 45.0, 0.5, 26, cell -> false);
		check(down != null && down.feet().y() == 56, "a target below the body counts the descent: the seen cave floor below is the checkpoint: " + down);
	}

	private static void verifyNarrowRidge() {
		// A one-wide ridge at z = 3, running east, over open air: the sparse columns miss it, sight lines along it do not.
		Grid ridge = new Grid();
		ridge.seenUpTo = 40;
		for (int x = -2; x <= 40; x++) ridge.solid.add(new GridPosition(x, 63, 3));
		java.util.List<GridPosition> sighted = new java.util.ArrayList<>();
		for (int x = 4; x <= 30; x += 2) sighted.add(new GridPosition(x, 64, 3));
		TravelCheckpoints.Checkpoint along = TravelCheckpoints.pick(ridge, 0.5, 64, 3.5, 200.5, Double.NaN, 40.5, 26, cell -> false, sighted);
		check(along != null && along.feet().z() == 3 && along.feet().x() >= 20, "a sighted spot along a one-wide ridge is the checkpoint: " + along);
		java.util.List<GridPosition> far = java.util.List.of(new GridPosition(36, 64, 3));
		TravelCheckpoints.Checkpoint tooFar = TravelCheckpoints.pick(ridge, 0.5, 64, 3.5, 200.5, Double.NaN, 40.5, 26, cell -> false, far);
		check(tooFar == null || tooFar.feet().x() <= 26, "a sighted spot beyond a leg's reach is never the checkpoint: " + tooFar);
	}

	private static void verifyBuildMoves() {
		var retreatTrail = java.util.stream.IntStream.range(0, 14).mapToObj(i -> new GridPosition(i, i < 4 ? 34 : 32, 62)).toList();
		GridPosition oldBank = ServerTravelController.retreatAlong(retreatTrail, retreatTrail.getLast(), cell -> cell.y() == 34);
		check(oldBank != null && oldBank.y() == 34, "a lava-exposed recent trail retreats farther to the older dry bank");
		check(ServerTravelController.retreatAlong(retreatTrail, retreatTrail.getLast(), cell -> true).equals(retreatTrail.get(5)),
				"an already dry trail keeps the normal eight-cell retreat");

		GridPosition belowLip = new GridPosition(10, 33, 60);
		check(!ServerTravelController.stepArrived(new Vec3(10.7, 33.875, 60.5), new GridPosition(11, 34, 60), belowLip, true),
				"overhanging the old support is not a completed descent onto the next column");
		check(ServerTravelController.stepArrived(new Vec3(10.5, 32.875, 60.5), belowLip, belowLip, true),
				"a descent landed on partial-height support is complete");

		Vec3 eye = new Vec3(0.5D, 65.27D, 0.5D);
		Vec3 footAim = TravelBuilder.miningAim(eye, new net.minecraft.core.BlockPos(0, 64, 1));
		Vec3 headAim = TravelBuilder.miningAim(eye, new net.minecraft.core.BlockPos(0, 65, 1));
		check(footAim.y > 64.9D && footAim.y < 65.0D, "feet mining aims inside the upper face, not at the block centre");
		check(headAim.y == eye.y, "head mining keeps eye height inside the head block");
		check(Math.abs(TravelBuilder.lookAt(eye, footAim)[1]) < 17.0D, "a crouched tunnel miner needs less than 17 degrees pitch to mine the feet cell");

		Map<GridPosition, BlockState> states = new HashMap<>();
		Grid ground = new Grid();
		ground.floor(-5, 0, -5, 5, 63);
		ground.seenUpTo = 30;
		GridPosition feet = new GridPosition(0, 64, 0);
		check(TravelBuilder.decide(ground, states::get, feet, Direction.EAST, true, 0).kind() == TravelBuilder.Kind.BRIDGE,
				"open air below the next cell is bridged");
		Grid hole = new Grid();
		hole.floor(-5, 5, -5, 5, 62);
		hole.floor(-5, 0, -5, 5, 63);
		hole.floor(2, 5, -5, 5, 63);
		hole.seenUpTo = 30;
		check(TravelBuilder.decide(hole, states::get, feet, Direction.EAST, true, 0).count() == -1,
				"a plain one-deep dip is walked down into");
		hole.exposed.add(new GridPosition(1, 63, 0));
		check(TravelBuilder.decide(hole, states::get, feet, Direction.EAST, true, 0).kind() == TravelBuilder.Kind.FILL,
				"a one-deep hole with lava beside it is filled from behind it, never stepped into");
		states.put(feet.below(), Blocks.SOUL_SAND.defaultBlockState());
		check(TravelBuilder.decide(ground, states::get, feet, Direction.EAST, true, 0).kind() == TravelBuilder.Kind.PILLAR,
				"no sneak-bridge off soul sand (the new block would overlap the body): pillar one full block first");
		states.put(feet.below(), Blocks.AIR.defaultBlockState());
		TravelBuilder.Plan lip = TravelBuilder.decide(ground, states::get, feet, Direction.EAST, true, 0);
		check(!lip.possible() && "no-footing".equals(lip.refusalCode()),
				"open air under the feet cell (the body's middle over a bridge's gap) is no partial block to pillar from: " + lip.refusalCode());
		states.clear();
		TravelBuilder.Plan noBlocks = TravelBuilder.decide(ground, states::get, feet, Direction.EAST, false, 0);
		check(!noBlocks.possible() && "out-of-blocks".equals(noBlocks.refusalCode()), "a needed bridge without blocks is OUT_OF_BLOCKS");
		check(TravelBuilder.decide(ground, states::get, feet, Direction.WEST, true, 0).kind() == TravelBuilder.Kind.STEP, "seen ground ahead is a step");
		Grid lavaSea = new Grid();
		lavaSea.floor(-5, 0, -5, 5, 63);
		lavaSea.seenUpTo = 30;
		GridPosition lava = new GridPosition(1, 64, 0);
		lavaSea.hazard.add(lava);
		states.put(lava, Blocks.LAVA.defaultBlockState());
		TravelBuilder.Plan overLava = TravelBuilder.decide(lavaSea, states::get, feet, Direction.EAST, true, 0);
		check(overLava.kind() == TravelBuilder.Kind.PILLAR && overLava.count() == 1, "lava level with the feet: climb one and bridge over it");
		lavaSea.solid.add(feet.above(2));
		check(TravelBuilder.decide(lavaSea, states::get, feet, Direction.EAST, true, 0).kind() == TravelBuilder.Kind.CLEAR_UP,
				"under a low ceiling the block over the head is mined before climbing over the lava");
		states.clear();
		Grid magma = new Grid();
		magma.floor(-5, 0, -5, 5, 63);
		magma.floor(2, 5, -5, 5, 63);
		magma.seenUpTo = 30;
		GridPosition hot = new GridPosition(1, 63, 0);
		magma.hazard.add(hot);
		states.put(hot, Blocks.MAGMA_BLOCK.defaultBlockState());
		check(TravelBuilder.decide(magma, states::get, feet, Direction.EAST, true, 0).kind() == TravelBuilder.Kind.CROSS,
				"a magma floor is crossed crouched, never bridged");
		states.clear();
		Grid fire = new Grid();
		fire.floor(-5, 5, -5, 5, 63);
		fire.seenUpTo = 30;
		GridPosition flame = new GridPosition(1, 64, 0);
		fire.hazard.add(flame);
		states.put(flame, Blocks.FIRE.defaultBlockState());
		check(TravelBuilder.decide(fire, states::get, feet, Direction.EAST, true, 0).kind() == TravelBuilder.Kind.EXTINGUISH, "fire ahead is put out, never walked through");
		states.clear();
		Grid ledge = new Grid();
		ledge.floor(-5, 5, -5, 5, 63);
		ledge.seenUpTo = 30;
		for (int y = 64; y <= 65; y++) ledge.solid.add(new GridPosition(1, y, 0));
		TravelBuilder.Plan climb = TravelBuilder.decide(ledge, states::get, feet, Direction.EAST, true, 2);
		check(climb.kind() == TravelBuilder.Kind.PILLAR && climb.count() == 1, "a two-block ledge is pillared once, then stepped onto");
		Grid wall = new Grid();
		wall.floor(-5, 5, -5, 5, 63);
		wall.seenUpTo = 30;
		for (int y = 64; y <= 70; y++) wall.solid.add(new GridPosition(1, y, 0));
		check(TravelBuilder.decide(wall, states::get, feet, Direction.EAST, true, 0).kind() == TravelBuilder.Kind.TUNNEL, "a tall wall is tunnelled");
		Grid longDetour = new Grid();
		longDetour.floor(-52, 52, -52, 52, 63);
		longDetour.seenUpTo = 64;
		for (int y = 64; y <= 65; y++) for (int z = -30; z <= 30; z++) longDetour.solid.add(new GridPosition(1, y, z));
		var pending = TravelCheckpoints.beginWalkingPick(longDetour, 0.5, 64, 0.5, 200.5, Double.NaN, 0.5, 48,
				cell -> false, java.util.List.of());
		check(pending != null, "the detour has acquired candidate endpoints");
		var firstSlice = pending.advance(longDetour);
		check(firstSlice == null && !pending.finished(), "one search slice cannot yet establish the long detour");
		TravelCheckpoints.Checkpoint detourRoute = null;
		int slices = 1;
		while (!pending.finished() && slices++ < 100) detourRoute = pending.advance(longDetour);
		check(pending.finished() && detourRoute != null, "retaining the search finds the connected route after " + slices + " slices");
		Grid unseen = new Grid();
		unseen.floor(-5, 5, -5, 5, 63);
		unseen.seenUpTo = 0;
		check("unseen".equals(TravelBuilder.decide(unseen, states::get, feet, Direction.EAST, true, 0).refusalCode()), "an unseen cell ahead is looked at, never built into");
		Grid slope = new Grid();
		slope.floor(-5, 0, -5, 5, 63);
		slope.floor(1, 5, -5, 5, 62);
		slope.seenUpTo = 30;
		check(TravelBuilder.decide(slope, states::get, feet, Direction.EAST, true, 0).kind() == TravelBuilder.Kind.STEP
				&& TravelBuilder.decide(slope, states::get, feet, Direction.EAST, true, 0).count() == -1, "a step down onto plain ground is walked");
		slope.exposed.add(new GridPosition(1, 63, 0));
		check(TravelBuilder.decide(slope, states::get, feet, Direction.EAST, true, 0).kind() != TravelBuilder.Kind.STEP,
				"never step down to a cell with lava beside it: the line stays on its level and bridges");
	}

	private static void verifyJumpLineUp() {
		Grid notch = new Grid();
		notch.floor(-5, 5, -5, 5, 63);
		notch.seenUpTo = 30;
		// A one-wide notch at (1,65,0) in a wall one block up: solid at z=-1 and z=1 beside it.
		for (int z = -5; z <= 5; z++) notch.solid.add(new GridPosition(1, 64, z));
		notch.solid.add(new GridPosition(1, 65, -1));
		notch.solid.add(new GridPosition(1, 65, 1));
		List<PathNode> nodes = List.of(new PathNode(new GridPosition(0, 64, 0), TraversalType.WALK), new PathNode(new GridPosition(1, 65, 0), TraversalType.JUMP_UP));
		Vec3 off = ServerNavigationController.jumpLineUp(notch, new Vec3(0.6, 64, 0.85), Vec3.ZERO, nodes, 1);
		check(off != null && Math.abs(off.z - 0.5) < 1.0E-9 && Math.abs(off.x - 0.5) < 1.0E-9, "off the notch's centreline: line up on the takeoff cell first");
		check(ServerNavigationController.jumpLineUp(notch, new Vec3(0.6, 64, 0.55), Vec3.ZERO, nodes, 1) == null, "lined up: jump at once");
		check(ServerNavigationController.jumpLineUp(notch, new Vec3(0.6, 64, 0.55), new Vec3(0.05, 0, -0.14), nodes, 1) != null,
				"centred but still moving along the wall: line up (stop the drift) before jumping");
		// The notch runs +x (yaw -90): facing it, the jump is pressed; still turning from +z (yaw 0), it waits.
		check(!ServerNavigationController.turningIntoNotch(notch, nodes, 1, -85.0F), "facing the notch: jump");
		check(ServerNavigationController.turningIntoNotch(notch, nodes, 1, -40.0F), "mid-turn into a notch: hold the jump");
		Grid open = new Grid();
		open.floor(-5, 5, -5, 5, 63);
		open.seenUpTo = 30;
		for (int z = -5; z <= 5; z++) open.solid.add(new GridPosition(1, 64, z));
		check(ServerNavigationController.jumpLineUp(open, new Vec3(0.6, 64, 0.95), Vec3.ZERO, nodes, 1) == null, "an open step is jumped from wherever the body is");
		check(!ServerNavigationController.turningIntoNotch(open, nodes, 1, 0.0F), "an open step is jumped at any facing");
		// Braking short of fire presses against the motion in vanilla's input frame: facing +z (yaw 0) and moving +z is back;
		// facing +z and moving +x (the body's left) is a right strafe.
		float[] back = ServerNavigationController.brakeInput(new Vec3(0, 0, 0.2), 0.0F);
		check(Math.abs(back[0] + 1.0F) < 1.0E-5F && Math.abs(back[1]) < 1.0E-5F, "brake: moving forward presses back");
		float[] right = ServerNavigationController.brakeInput(new Vec3(0.2, 0, 0), 0.0F);
		check(Math.abs(right[0]) < 1.0E-5F && Math.abs(right[1] + 1.0F) < 1.0E-5F, "brake: drifting left presses right");
		float[] turned = ServerNavigationController.brakeInput(new Vec3(0.2, 0, 0), -90.0F);
		check(Math.abs(turned[0] + 1.0F) < 1.0E-5F, "brake: facing +x (yaw -90) and moving +x presses back");
		// Seen lava beside the route brakes a body whose motion would carry its box into it, as fire does; lava under the
		// floor (the box never meets its fluid) does not.
		Map<net.minecraft.core.BlockPos, BlockState> lava = new HashMap<>();
		lava.put(new net.minecraft.core.BlockPos(1, 64, 0), Blocks.LAVA.defaultBlockState());
		net.minecraft.world.phys.AABB box = new net.minecraft.world.phys.AABB(0.2, 64, 0.2, 0.8, 65.8, 0.8);
		check(ServerNavigationController.fireAhead(lava::get, box, new Vec3(0.15, 0, 0)), "lava beside the line: brake before the box meets it");
		check(!ServerNavigationController.fireAhead(lava::get, box, new Vec3(-0.15, 0, 0)), "moving away from lava: no brake");
		Map<net.minecraft.core.BlockPos, BlockState> corner = new HashMap<>();
		corner.put(new net.minecraft.core.BlockPos(7, 35, 70), Blocks.FIRE.defaultBlockState());
		var cornerBox = new net.minecraft.world.phys.AABB(7.948, 35, 69.332, 8.548, 36.8, 69.932);
		Vec3 reversed = new Vec3(-0.004984, -0.0784, -0.017406);
		check(!ServerNavigationController.fireAhead(corner::get, cornerBox, reversed), "reverse momentum alone misses the fire-corner regression");
		check(ServerNavigationController.fireAhead(corner::get, cornerBox,
				ServerNavigationController.inputMotion(reversed, 0.98F, 0.22F, -3.7F, true)),
				"forward acceleration after braking must not resume into the fire corner");
		Map<net.minecraft.core.BlockPos, BlockState> arriving = new HashMap<>();
		arriving.put(new net.minecraft.core.BlockPos(-14, 41, 174), Blocks.LAVA.defaultBlockState());
		var lip = new net.minecraft.world.phys.AABB(-13.8, 41, 173.4, -13.2, 42.8, 174);
		check(!ServerNavigationController.fireAhead(arriving::get, lip, Vec3.ZERO), "touching a lava cell boundary is not fluid contact");
		check(!ServerNavigationController.fireAhead(arriving::get, lip, new Vec3(0, 0, -0.13)), "retreat from arriving lava must not brake at the shared boundary");
		check(ServerNavigationController.fireAhead(arriving::get, lip, new Vec3(0, 0, 0.13)), "forward across that same boundary still brakes");
		Map<net.minecraft.core.BlockPos, BlockState> under = new HashMap<>();
		under.put(new net.minecraft.core.BlockPos(1, 63, 0), Blocks.LAVA.defaultBlockState());
		check(!ServerNavigationController.fireAhead(under::get, box, new Vec3(0.15, 0, 0)), "lava below the floor: no brake on the ground");
	}

	private static void verifyColumnStanding() {
		Grid ground = new Grid();
		ground.floor(-5, 5, -5, 5, 63);
		ground.seenUpTo = 30;
		Vec3 onTop = ServerNavigationController.standingInColumn(ground, new Vec3(2, 63, -3));
		check(onTop != null && onTop.y == 64 && onTop.x == 2.5 && onTop.z == -2.5, "a solid block named by block coordinates is stood on: " + onTop);
		Vec3 above = ServerNavigationController.standingInColumn(ground, new Vec3(2.5, 65, -2.5));
		check(above != null && above.y == 64 && above.x == 2.5, "an open cell over seen ground is that ground: " + above);
		check(ServerNavigationController.standingInColumn(ground, new Vec3(2.5, 64, -2.5)) == null, "a standable request is kept");
		check(ServerNavigationController.standingInColumn(ground, new Vec3(2.5, 67, -2.5)) == null, "a request far above ground is kept (the planner reports it)");
		ground.seenUpTo = 1;
		check(ServerNavigationController.standingInColumn(ground, new Vec3(2, 63, -3)) == null, "unseen cells never move a request");
	}

	private static void verifyBuildingBlocks() {
		var wart = Blocks.NETHER_WART_BLOCK.defaultBlockState();
		var rack = Blocks.NETHERRACK.defaultBlockState();
		check(TravelBuilder.mineTicks(net.minecraft.world.item.ItemStack.EMPTY, wart, 1.0F) <= TravelBuilder.maximumTunnelMineTicks(wart),
				"wart can be cleared by hand rather than falsely ending an otherwise viable trip");
		check(TravelBuilder.mineTicks(net.minecraft.world.item.ItemStack.EMPTY, rack, 0.4F) > TravelBuilder.maximumTunnelMineTicks(rack),
				"losing every pick still hands tool-dependent netherrack tunnelling back to the model");
		check(TravelBuilder.mineTicks(net.minecraft.world.item.ItemStack.EMPTY, Blocks.OAK_LOG.defaultBlockState(), 2.0F) > TravelBuilder.maximumTunnelMineTicks(Blocks.OAK_LOG.defaultBlockState()),
				"slow hand mining still stops rather than consuming a trip on hard tool-free blocks");
		check(TravelBuilder.buildingBlock(Blocks.COBBLESTONE), "cobblestone builds a bridge");
		check(TravelBuilder.buildingBlock(Blocks.NETHERRACK), "netherrack builds a bridge");
		check(!TravelBuilder.buildingBlock(Blocks.OAK_PLANKS), "planks never: lava sets them alight");
		check(!TravelBuilder.buildingBlock(Blocks.WOOL.white()), "wool never: lava sets it alight");
		check(!TravelBuilder.buildingBlock(Blocks.GRAVEL), "gravel never: it falls");
		check(!TravelBuilder.buildingBlock(Blocks.OBSIDIAN), "obsidian is kept for portals");
	}

	private static void verifyFeetCell() {
		check(ServerTravelController.standingCellY(64.0D) == 64, "on a full block the feet cell is the one the feet are in");
		check(ServerTravelController.standingCellY(63.875D) == 64, "on soul sand (top 0.875) the feet cell is the open one above the sand");
		check(ServerTravelController.standingCellY(63.5D) == 64, "on a bottom slab the feet cell is the open one above the slab");
	}

	private static void verifyCarriedSupplies() {
		var bindings = new java.util.LinkedHashMap<net.minecraft.core.Holder.Reference<net.minecraft.world.item.Item>, net.minecraft.core.component.DataComponentMap>();
		try {
			var access = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
			access.setAccessible(true);
			var unsafe = (sun.misc.Unsafe) access.get(null);
			var player = (net.minecraft.server.level.ServerPlayer) unsafe.allocateInstance(net.minecraft.server.level.ServerPlayer.class);
			player.setId(1016); // 26.3 assigns entity IDs in the constructor, which Unsafe allocation skips.
			var inventory = new net.minecraft.world.entity.player.Inventory(player, new net.minecraft.world.entity.EntityEquipment());
			var field = net.minecraft.world.entity.player.Player.class.getDeclaredField("inventory");
			field.setAccessible(true);
			field.set(player, inventory);
			inventory.setItem(0, carriedStack(net.minecraft.world.item.Items.STONE_PICKAXE, 4.0F, bindings));
			inventory.setItem(17, carriedStack(net.minecraft.world.item.Items.IRON_PICKAXE, 6.0F, bindings));
			check(TravelBuilder.toolSlot(player, Blocks.NETHER_QUARTZ_ORE.defaultBlockState()) == 17,
					"the carried iron pickaxe outranks a hotbar stone pickaxe for quartz");
			inventory.setItem(35, carriedStack(net.minecraft.world.item.Items.DIAMOND_PICKAXE, 8.0F, bindings));
			check(TravelBuilder.toolSlot(player, Blocks.NETHER_QUARTZ_ORE.defaultBlockState()) == 35,
					"the last carried slot participates in fastest tool selection");
			inventory.setItem(23, carriedStack(net.minecraft.world.item.Items.NETHERRACK, 1.0F, bindings).copyWithCount(64));
			check(TravelBuilder.blockSlot(player) == 23 && TravelBuilder.blocksOnHotbar(player) == 0,
					"a main-inventory stack is available for building with an empty block hotbar");
			check(TravelBuilder.blocksOffHotbar(player) == 64, "carried block count includes the main inventory");
		} catch (ReflectiveOperationException failure) {
			throw new AssertionError("travel carried-supply fixture failed", failure);
		} finally {
			for (var entry : bindings.entrySet()) {
				try {
					var field = net.minecraft.core.Holder.Reference.class.getDeclaredField("components");
					field.setAccessible(true);
					field.set(entry.getKey(), entry.getValue());
				} catch (ReflectiveOperationException failure) { throw new AssertionError("restore travel item fixture", failure); }
			}
		}
	}

	/** Bind just this fixture's mining properties; verifyCore does not load a world's item datapack. */
	private static net.minecraft.world.item.ItemStack carriedStack(net.minecraft.world.item.Item item, float speed,
			java.util.Map<net.minecraft.core.Holder.Reference<net.minecraft.world.item.Item>, net.minecraft.core.component.DataComponentMap> bindings) {
		var holder = item.builtInRegistryHolder();
		bindings.put(holder, holder.areComponentsBound() ? holder.components() : null);
		var components = net.minecraft.core.component.DataComponentMap.builder()
				.set(net.minecraft.core.component.DataComponents.MAX_STACK_SIZE, speed > 1 ? 1 : 64);
		if (speed > 1) components.set(net.minecraft.core.component.DataComponents.MAX_DAMAGE, 250)
				.set(net.minecraft.core.component.DataComponents.DAMAGE, 0)
				.set(net.minecraft.core.component.DataComponents.TOOL, new net.minecraft.world.item.component.Tool(
						List.of(net.minecraft.world.item.component.Tool.Rule.minesAndDrops(net.minecraft.core.HolderSet.direct(Blocks.NETHER_QUARTZ_ORE.builtInRegistryHolder()), speed)), 1.0F, 1, true));
		holder.bindComponents(components.build());
		return new net.minecraft.world.item.ItemStack(item);
	}

	private static void check(boolean passed, String label) {
		assertions++;
		if (!passed) throw new AssertionError(label);
	}

	/** Air everywhere but the floors and blocks set; cells farther than {@code seenUpTo} from the origin are unseen. */
	private static final class Grid implements WalkabilityView {
		final java.util.Set<GridPosition> solid = new java.util.HashSet<>();
		final java.util.Set<GridPosition> hazard = new java.util.HashSet<>();
		final java.util.Set<GridPosition> exposed = new java.util.HashSet<>();
		int seenUpTo = 30;

		void floor(int x0, int x1, int z0, int z1, int y) {
			for (int x = x0; x <= x1; x++) for (int z = z0; z <= z1; z++) solid.add(new GridPosition(x, y, z));
		}

		@Override
		public Cell cellAt(GridPosition p) {
			if (Math.max(Math.abs(p.x()), Math.abs(p.z())) > seenUpTo) return Cell.UNLOADED;
			if (hazard.contains(p)) return Cell.HAZARD;
			return solid.contains(p) ? Cell.SAFE_SUPPORT : Cell.CLEAR;
		}

		@Override
		public int exposureCost(GridPosition p) {
			return exposed.contains(p) ? 12 : 0;
		}

		@Override
		public boolean lavaFillsNext(GridPosition p) {
			return false;
		}
	}
}
