package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.server.perception.SeenTerrain;
import java.util.HashMap;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;

public final class AcquiredResultTerrainVerification {
	private AcquiredResultTerrainVerification() {
	}

	public static int verify() {
		Map<BlockPos, BlockState> live = new HashMap<>();
		BlockPos target = new BlockPos(3, 64, 0);
		live.put(target, Blocks.OAK_LOG.defaultBlockState());
		boolean[] visible = {true};
		SeenTerrain.Source<BlockState> source = new SeenTerrain.Source<>() {
			@Override public BlockState live(int x, int y, int z) {
				return live.getOrDefault(new BlockPos(x, y, z), y < 64 ? Blocks.STONE.defaultBlockState() : Blocks.AIR.defaultBlockState());
			}
			@Override public boolean sees(int x, int y, int z) { return visible[0]; }
		};
		SeenTerrain.Memory<BlockState> memory = new SeenTerrain.Memory<>();
		AcquiredResultTerrain known = new AcquiredResultTerrain(new SeenTerrain.Reader<>(memory, source, 0, null), 384, -64, false);
		AABB body = new AABB(3.2, 64, 0.2, 3.8, 65.8, 0.8);
		check(known.knownState(target).is(Blocks.OAK_LOG), "seen obstruction retains its identity");
		check(known.intersects(target, body), "seen log occupies the requested body position");
		check(!known.isFullBlockStandable(target), "occupied cell is not suggested");
		BlockPos alternative = target.west();
		check(known.isFullBlockStandable(alternative), "known clear body over known full support is standable");
		visible[0] = false;
		live.put(target, Blocks.DIAMOND_BLOCK.defaultBlockState());
		live.put(alternative, Blocks.LAVA.defaultBlockState());
		AcquiredResultTerrain remembered = new AcquiredResultTerrain(new SeenTerrain.Reader<>(memory, source, 1, null), 384, -64, false);
		check(remembered.knownState(target).is(Blocks.OAK_LOG), "hidden replacement does not leak into obstruction text");
		check(remembered.isFullBlockStandable(alternative), "hidden change does not replace acquired standing facts");
		AcquiredResultTerrain unknown = new AcquiredResultTerrain(new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), source, 1, null), 384, -64, false);
		check(unknown.knownState(target) == null, "unseen destination does not gain a block identity");
		check(!unknown.intersects(target, body), "unseen geometry is not reported as an obstruction");
		check(!unknown.isFullBlockStandable(alternative), "unknown support and clearance cannot become a suggested cell");
		check(unknown.getBlockState(target).is(Blocks.BARRIER), "shape neighbour queries stay conservative without live geometry");
		return 10;
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
	}
}
