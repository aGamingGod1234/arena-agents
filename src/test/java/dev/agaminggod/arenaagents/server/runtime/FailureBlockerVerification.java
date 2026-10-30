package dev.agaminggod.arenaagents.server.runtime;

import com.google.gson.JsonObject;
import dev.agaminggod.arenaagents.protocol.ActionType;
import java.util.HashMap;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;

public final class FailureBlockerVerification {
	private FailureBlockerVerification() {
	}

	public static int verify() {
		assertEquals("target 5.8m from eye; reach 4.5m",
				FailureBlocker.append("Target menu is out of reach", FailureBlocker.reachFact(5.83D, 4.5D)), "a listed restatement is replaced by distance against reach");
		assertEquals("Lava at 3,60,1; target 5.8m from eye; reach 4.5m",
				FailureBlocker.append("Lava at 3,60,1", FailureBlocker.reachFact(5.83D, 4.5D)), "a producer fact is kept and the family fact added");
		// Review r1: sentences without numbers are facts too, and must survive in results, receipts and traces.
		String standing = "No part of it is visible within reach from this eye; no standing spot in seen terrain within reach of it sees it";
		assertEquals(standing + "; minecraft:stone at -3,1,0 is in the way",
				FailureBlocker.append(standing, FailureBlocker.sightFact("minecraft:stone", new BlockPos(-3, 1, 0))), "a producer sentence without digits is kept");
		assertEquals("The requested block is not the exact block under the crosshair; minecraft:dirt at 1,64,-2 is in the way",
				FailureBlocker.append("The requested block is not the exact block under the crosshair", FailureBlocker.sightFact("minecraft:dirt", new BlockPos(1, 64, -2))),
				"the failed crosshair condition is kept");
		assertEquals("Hidden; minecraft:dirt at 0,0,0 is in the way",
				FailureBlocker.append("Hidden; minecraft:dirt at 0,0,0 is in the way", FailureBlocker.sightFact("minecraft:dirt", BlockPos.ZERO)), "a fact the producer already stated is not repeated");
		assertEquals("Navigation timed out", FailureBlocker.append("Navigation timed out", ""), "a family without a fact leaves the message unchanged");
		assertEquals("destination 0.9m away", FailureBlocker.append("Navigation timed out", "destination 0.9m away"), "a timed-out walk says how far is left");
		assertEquals("destination 3.0m away", FailureBlocker.append(null, "destination 3.0m away"), "a missing message becomes the fact");
		JsonObject entityTarget = new JsonObject();
		entityTarget.addProperty("targetId", "uuid");
		assertEquals("Attack target is out of reach", FailureBlocker.withBlocker(null, ActionType.ATTACK, entityTarget, "TARGET_TOO_FAR", "Attack target is out of reach"),
				"without a player or block target nothing is read or invented");
		return 9 + perception();
	}

	/** Review r1 probes: the blocker is named only when the player's current crosshair is on it, not behind lava, in a loaded chunk. */
	private static int perception() {
		CollisionContext context = CollisionContext.empty();
		Vec3 eye = new Vec3(0.5D, 1.62D, 0.5D);

		Fixture rear = new Fixture();
		BlockPos behind = new BlockPos(-4, 1, 0);
		rear.put(behind, Blocks.STONE.defaultBlockState());
		rear.put(new BlockPos(-3, 1, 0), Blocks.DIAMOND_BLOCK.defaultBlockState());
		assertEquals(null, FailureBlocker.sightBlocker(rear, context, eye, behind, crosshair(rear, eye, new Vec3(1, 0, 0)), position -> true),
				"a block behind the player, off the crosshair, is never named");

		Fixture lava = new Fixture();
		BlockPos ahead = new BlockPos(3, 1, 0);
		lava.put(new BlockPos(1, 1, 0), Blocks.LAVA.defaultBlockState());
		lava.put(new BlockPos(2, 1, 0), Blocks.DIAMOND_BLOCK.defaultBlockState());
		lava.put(ahead, Blocks.STONE.defaultBlockState());
		HitResult throughLava = crosshair(lava, eye, new Vec3(1, 0, 0));
		check(throughLava.getType() == HitResult.Type.BLOCK, "the fluid-blind crosshair reaches the block behind the lava");
		assertEquals(null, FailureBlocker.sightBlocker(lava, context, eye, ahead, throughLava, position -> true), "a block seen only through lava is never named");

		Fixture clear = new Fixture();
		BlockPos wall = new BlockPos(2, 1, 0);
		clear.put(wall, Blocks.DIAMOND_BLOCK.defaultBlockState());
		clear.put(ahead, Blocks.STONE.defaultBlockState());
		HitResult onWall = crosshair(clear, eye, new Vec3(1, 0, 0));
		assertEquals(wall, FailureBlocker.sightBlocker(clear, context, eye, ahead, onWall, position -> true), "the block under the crosshair that is in the way is named");
		assertEquals(null, FailureBlocker.sightBlocker(clear, context, eye, ahead, onWall, position -> false), "an unloaded chunk is never read");
		return 5;
	}

	private static HitResult crosshair(Fixture world, Vec3 eye, Vec3 view) {
		return world.clip(new ClipContext(eye, eye.add(view.scale(4.5D)), ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, CollisionContext.empty()));
	}

	private static final class Fixture extends BreakSightline.SeenWorld {
		private final Map<BlockPos, BlockState> states = new HashMap<>();

		Fixture() {
			super(-64, 384);
		}

		void put(BlockPos position, BlockState state) {
			states.put(position.immutable(), state);
		}

		@Override
		BlockState knownState(BlockPos position) {
			return states.getOrDefault(position, Blocks.AIR.defaultBlockState());
		}
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
	}

	private static void assertEquals(Object expected, Object actual, String message) {
		if (!java.util.Objects.equals(expected, actual)) throw new AssertionError(message + ": expected " + expected + " but was " + actual);
	}
}
