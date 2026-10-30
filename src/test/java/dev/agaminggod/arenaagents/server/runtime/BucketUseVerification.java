package dev.agaminggod.arenaagents.server.runtime;

import dev.agaminggod.arenaagents.agent.AgentDomainException;
import dev.agaminggod.arenaagents.server.perception.LavaSpread;
import java.util.HashMap;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

/** use_item with a bucket aims where the bucket's own vanilla ray meets the requested source, as a player does. */
public final class BucketUseVerification {
	private static int assertions;
	private BucketUseVerification() { }

	public static int verify() {
		assertions = 0;
		Item empty = Items.BUCKET, water = Items.WATER_BUCKET;
		BlockPos source = new BlockPos(78, 40, 112), obsidian = new BlockPos(79, 40, 112);
		// Game d2c-iron-c: lava cast at 79,40,112 beside the coolant at 78,40,112; the pickup aimed at the coolant's center
		// from the far side of the fresh obsidian and was released with no accepted interaction, twice.
		World cast = new World();
		cast.states.put(source, Blocks.WATER.defaultBlockState());
		cast.states.put(obsidian, Blocks.OBSIDIAN.defaultBlockState());
		for (int x = 76; x <= 82; x++) for (int z = 110; z <= 114; z++) cast.states.put(new BlockPos(x, 39, z), Blocks.STONE.defaultBlockState());
		Vec3 eye = new Vec3(80.43D, 41.62D, 112.51D), center = new Vec3(78.5D, 40.5D, 112.5D);
		BlockHitResult blocked = VanillaFluidRayFixture.hit(cast, eye, center, 4.5D, ClipContext.Fluid.SOURCE_ONLY);
		check(blocked.getType() == HitResult.Type.BLOCK && blocked.getBlockPos().equals(obsidian),
				"the bucket ray toward the hidden center meets the obsidian first: " + blocked.getBlockPos());
		Vec3 aim = BucketUse.aim(VanillaFluidRayFixture.player(cast, eye, 4.5D), empty, center);
		BlockHitResult filled = VanillaFluidRayFixture.hit(cast, eye, aim, 4.5D, ClipContext.Fluid.SOURCE_ONLY);
		check(!aim.equals(center) && filled.getType() == HitResult.Type.BLOCK && filled.getBlockPos().equals(source),
				"an empty bucket aims at the visible surface of the requested source: " + aim + " meets " + filled.getBlockPos());
		check(BucketUse.describe(cast, eye, blocked, 4.5D).startsWith("minecraft:obsidian at 79,40,112 face "),
				"the ray report names the block it met: " + BucketUse.describe(cast, eye, blocked, 4.5D));
		check(BucketUse.describe(cast, eye, filled, 4.5D).startsWith("minecraft:water source at 78,40,112 face up"),
				"the ray report names the source it met: " + BucketUse.describe(cast, eye, filled, 4.5D));

		// A clear line keeps the model's exact aim.
		Vec3 above = new Vec3(79.45D, 42.62D, 112.5D);
		check(BucketUse.aim(VanillaFluidRayFixture.player(cast, above, 4.5D), empty, center).equals(center),
				"a requested point the bucket ray already meets is kept");
		// Filled buckets empty against the outline they meet, and flowing water is passed through: both aims are kept.
		check(BucketUse.aim(VanillaFluidRayFixture.player(cast, eye, 4.5D), water, center).equals(center),
				"a filled bucket keeps the requested aim");
		World flowing = new World();
		flowing.states.put(source, Blocks.WATER.defaultBlockState().setValue(LiquidBlock.LEVEL, 2));
		check(BucketUse.aim(VanillaFluidRayFixture.player(flowing, eye, 4.5D), empty, center).equals(center),
				"an aim into flowing water is kept as given");

		World sealed = new World();
		sealed.states.put(source, Blocks.WATER.defaultBlockState());
		for (var face : net.minecraft.core.Direction.values()) sealed.states.put(source.relative(face), Blocks.OBSIDIAN.defaultBlockState());
		try {
			BucketUse.aim(VanillaFluidRayFixture.player(sealed, eye, 4.5D), empty, center);
			check(false, "a sealed source has no bucket aim");
		} catch (AgentDomainException e) {
			check(e.code().equals("TARGET_OBSTRUCTED") && e.getMessage().contains("minecraft:water source at 78,40,112")
					&& e.getMessage().contains("minecraft:obsidian at 79,40,112"), "a sealed source reports what the ray meets: " + e.getMessage());
		}
		World open = new World();
		open.states.put(source, Blocks.WATER.defaultBlockState());
		Vec3 far = new Vec3(84.0D, 41.62D, 112.5D);
		try {
			BucketUse.aim(VanillaFluidRayFixture.player(open, far, 4.5D), empty, center);
			check(false, "a source beyond reach has no bucket aim");
		} catch (AgentDomainException e) {
			check(e.code().equals("TARGET_TOO_FAR") && e.getMessage().contains("a bucket reaches 4.5 m"), "out of reach is named: " + e.getMessage());
		}
		check(BucketUse.describe(open, far, VanillaFluidRayFixture.hit(open, far, center, 4.5D, ClipContext.Fluid.SOURCE_ONLY), 4.5D)
				.equals("nothing within 4.5 m"), "a miss names the reach");
		verifyLavaPourAtBody();
		return assertions;
	}

	/**
	 * A lava pour whose uncast flow reaches the body is refused (LAVA_POUR_AT_BODY): the two lava deaths of the d41 cycle-1
	 * portal games, by vanilla spread over known cells, against pours the flow cannot reach and pours water casts.
	 */
	private static void verifyLavaPourAtBody() {
		Map<BlockPos, BlockState> known = new HashMap<>();
		LavaSpread.Read read = (x, y, z) -> known.get(new BlockPos(x, y, z));
		// c1-1 (13.0 min): crouching at 224.2966,-52,-206.5778; lava landed at 223,-52,-207 (south side of the deepslate it
		// aimed at). The hitbox reached 0.003 into x 223, so the source was in its own cell: 20 -> 0 health in 2 s.
		AABB crouched = body(224.29661766615394D, -52.0D, -206.57784349514188D, 1.5D);
		check(BucketUse.lavaReachSeconds(read, crouched, new BlockPos(223, -52, -207), 30) == 0.0D, "c1-1's pour into its own cell is refused at 0 s");
		// base-3 (28.4 min, action :183 at tick 34916): standing at 231.1556,-54,-110.5010; the ray met cobblestone
		// 231,-54,-112 face up, so the lava landed at 231,-53,-112, beside the head cell 231,-53,-111.
		AABB standing = body(231.15558132141015D, -54.0D, -110.50100313291557D, 1.8D);
		for (int x = 226; x <= 238; x++) for (int z = -116; z <= -106; z++) {
			known.put(new BlockPos(x, -55, z), Blocks.DEEPSLATE.defaultBlockState());
			for (int y = -54; y <= -51; y++) known.put(new BlockPos(x, y, z), Blocks.AIR.defaultBlockState());
		}
		known.put(new BlockPos(231, -54, -112), Blocks.COBBLESTONE.defaultBlockState());
		double head = BucketUse.lavaReachSeconds(read, standing, new BlockPos(231, -53, -112), 30);
		check(head == 1.5D, "base-3's last pour (beside the head) reaches the body in one 1.5 s step: " + head);
		double diagonal = BucketUse.lavaReachSeconds(read, standing, new BlockPos(232, -54, -112), 30);
		check(diagonal == 3.0D, "a diagonal source reaches the body in two steps: " + diagonal);
		// Open floor: lava reaches 3 cells (drop-off 2 of 8), so 2 and 3 cells away still reach the body; 4 do not.
		check(BucketUse.lavaReachSeconds(read, standing, new BlockPos(233, -54, -111), 30) == 3.0D, "2 cells away on open floor reaches in 3 s");
		check(BucketUse.lavaReachSeconds(read, standing, new BlockPos(234, -54, -111), 30) == 4.5D, "3 cells away on open floor reaches in 4.5 s");
		check(BucketUse.lavaReachSeconds(read, standing, new BlockPos(235, -54, -111), 30) < 0.0D, "4 cells away on open floor does not reach");
		check(BucketUse.lavaReachSeconds(read, standing, new BlockPos(234, -54, -111), 10) == 1.5D, "the Nether's fast lava reaches 3 cells in 1.5 s");
		check(BucketUse.lavaReachSeconds(read, standing, new BlockPos(232, -51, -111), 30) == 6.0D,
				"a source above the head beside the body falls and spreads onto it");
		check(BucketUse.lavaReachSeconds(read, standing, new BlockPos(232, -55, -111), 30) < 0.0D, "a source below the feet does not rise into the body");
		// A walled mould: the same 2-cell pour behind a known wall cannot reach the body and is left to the player.
		for (int z = -116; z <= -106; z++) for (int y = -54; y <= -52; y++) known.put(new BlockPos(232, y, z), Blocks.STONE.defaultBlockState());
		check(BucketUse.lavaReachSeconds(read, standing, new BlockPos(233, -54, -111), 30) < 0.0D, "a pour behind a known wall is not refused");
		// Unknown cells at the body's level count open: the same pour with the wall unknown is refused.
		for (int z = -116; z <= -106; z++) for (int y = -54; y <= -52; y++) known.remove(new BlockPos(232, y, z));
		check(BucketUse.lavaReachSeconds(read, standing, new BlockPos(233, -54, -111), 30) == 3.0D, "unknown cells beside the body do not hide the flow");
		// Vanilla's slope search (d41 batch-2 review): settled lava spreads only toward the nearest drop within 2 cells (4 in
		// the Nether), and a drop that fills with lava stays a drop. The same 2-cell pour with a deep drain on its far side
		// flows into the drain and never reaches the body, so a careful player's pour there is not refused.
		for (int z = -116; z <= -106; z++) for (int y = -54; y <= -52; y++) known.put(new BlockPos(232, y, z), Blocks.AIR.defaultBlockState());
		for (int y = -57; y <= -55; y++) known.put(new BlockPos(234, y, -111), Blocks.AIR.defaultBlockState());
		check(BucketUse.lavaReachSeconds(read, standing, new BlockPos(233, -54, -111), 30) < 0.0D, "a pour beside a drain on the far side of the body is not refused");
		check(BucketUse.lavaReachSeconds(read, standing, new BlockPos(233, -54, -111), 10) < 0.0D, "nor in the Nether (slope search 4)");
		// A drain on the body's side does not divert it: the flow still heads toward the body and is refused.
		for (int y = -57; y <= -55; y++) known.put(new BlockPos(234, y, -111), Blocks.DEEPSLATE.defaultBlockState());
		for (int y = -57; y <= -55; y++) known.put(new BlockPos(230, y, -111), Blocks.AIR.defaultBlockState());
		check(BucketUse.lavaReachSeconds(read, standing, new BlockPos(233, -54, -111), 30) == 3.0D, "a drain behind the body does not make the pour safe");
		for (int y = -57; y <= -55; y++) known.put(new BlockPos(230, y, -111), Blocks.DEEPSLATE.defaultBlockState());
		// A source over a one-deep hole beside the body falls into it first; once the hole holds lava, vanilla's next tick
		// spreads the source to its sides (lava cannot replace lava), so it still reaches the body, one delay later (r2 review).
		known.put(new BlockPos(232, -55, -111), Blocks.AIR.defaultBlockState());
		check(BucketUse.lavaReachSeconds(read, standing, new BlockPos(232, -54, -111), 30) == 3.0D, "a pour over a hole beside the body reaches it after the hole fills");
		known.put(new BlockPos(232, -55, -111), Blocks.DEEPSLATE.defaultBlockState());
		// Unknown support under the body: a known drain on the far side alone would take the whole flow, but a drop the player
		// has not seen under the body ties with it, so the flow may come both ways; the pour is refused (r2 review).
		for (int y = -57; y <= -55; y++) known.put(new BlockPos(233, y, -111), Blocks.AIR.defaultBlockState());
		known.remove(new BlockPos(231, -55, -111));
		known.remove(new BlockPos(230, -55, -111));
		check(BucketUse.lavaReachSeconds(read, standing, new BlockPos(232, -54, -111), 30) == 1.5D, "an unseen drop under the body draws the flow toward it");
		known.put(new BlockPos(231, -55, -111), Blocks.DEEPSLATE.defaultBlockState());
		known.put(new BlockPos(230, -55, -111), Blocks.DEEPSLATE.defaultBlockState());
		check(BucketUse.lavaReachSeconds(read, standing, new BlockPos(232, -54, -111), 30) < 0.0D, "with the support seen, the far drain takes the flow");
		for (int y = -57; y <= -55; y++) known.put(new BlockPos(233, y, -111), Blocks.DEEPSLATE.defaultBlockState());
		BlockPos water = BucketUse.waterCell(read, standing, new BlockPos(231, -53, -112));
		check(new BlockPos(231, -52, -112).equals(water), "the refusal names the open cell above the landing cell for water: " + water);
		String text = BucketUse.refusal(new BlockPos(231, -53, -112), "", head, water, false);
		check(text.contains("231,-53,-112") && text.contains("1.5 s") && text.contains("water at 231,-52,-112") && text.contains("back into a lava source") && !text.contains("2+ cells"),
				"the refusal names the landing cell, the time and where water casts it: " + text);
		String nether = BucketUse.refusal(new BlockPos(231, -53, -112), "", head, null, true);
		check(!nether.contains("let water touch") && nether.contains("evaporates") && nether.contains("flow misses your body") && nether.contains("acceptLavaRisk"),
				"a Nether refusal offers a landing cell whose flow misses the body, not water: " + nether);

		// Cooling is vanilla's: water above or beside the landing cell casts it (base-3's 28.05 cast at 232,-54,-111 had
		// water flowing beside it); water only below, or only in the cell (the lava replaces it), does not.
		BlockPos cell = new BlockPos(232, -54, -111);
		World pool = new World();
		pool.states.put(cell.east(), Blocks.WATER.defaultBlockState().setValue(LiquidBlock.LEVEL, 3));
		check(BucketUse.cooled(pool, cell), "flowing water beside the landing cell casts it");
		pool.states.clear();
		pool.states.put(cell.above(), Blocks.WATER.defaultBlockState());
		check(BucketUse.cooled(pool, cell), "a water source above the landing cell casts it");
		pool.states.clear();
		pool.states.put(cell.below(), Blocks.WATER.defaultBlockState());
		check(!BucketUse.cooled(pool, cell), "water below the landing cell does not cast it");
		pool.states.clear();
		pool.states.put(cell, Blocks.WATER.defaultBlockState());
		check(!BucketUse.cooled(pool, cell), "a lone water source in the landing cell is replaced, not a coolant");
		// A pour back into the pool replaces a lava source with a lava source: nothing changes, so it is never refused.
		pool.states.clear();
		pool.states.put(cell, Blocks.LAVA.defaultBlockState());
		check(BucketUse.lavaSourceIn(pool, cell), "a lava source in the landing cell is a pour back into the pool");
		pool.states.put(cell, Blocks.LAVA.defaultBlockState().setValue(LiquidBlock.LEVEL, 4));
		check(!BucketUse.lavaSourceIn(pool, cell), "flowing lava in the landing cell becomes a new source and is checked");
	}

	private static AABB body(double x, double y, double z, double height) {
		return new AABB(x - 0.3D, y, z - 0.3D, x + 0.3D, y + height, z + 0.3D);
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}

	private static final class World implements BlockGetter {
		final Map<BlockPos, BlockState> states = new HashMap<>();
		public BlockState getBlockState(BlockPos position) { return states.getOrDefault(position, Blocks.AIR.defaultBlockState()); }
		public FluidState getFluidState(BlockPos position) { return getBlockState(position).getFluidState(); }
		public net.minecraft.world.level.block.entity.BlockEntity getBlockEntity(BlockPos position) { return null; }
		public int getHeight() { return 384; }
		public int getMinY() { return -64; }
	}
}
