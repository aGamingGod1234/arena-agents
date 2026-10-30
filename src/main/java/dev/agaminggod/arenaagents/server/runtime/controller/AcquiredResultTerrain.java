package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.server.perception.SeenTerrain;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.AABB;

/** Terminal diagnostics use navigation's acquired states, including for shape neighbour queries. */
public final class AcquiredResultTerrain implements BlockGetter {
	private final SeenTerrain.Reader<BlockState> seen;
	private final int height;
	private final int minY;
	private final ObservedTerrain terrain;

	AcquiredResultTerrain(SeenTerrain.Reader<BlockState> seen, int height, int minY, boolean magmaProtected) {
		this.seen = seen;
		this.height = height;
		this.minY = minY;
		this.terrain = new ObservedTerrain(ObservedTerrain.known(seen, this, magmaProtected, 0, false), null);
	}

	public static AcquiredResultTerrain of(ServerPlayer player) {
		return new AcquiredResultTerrain(SeenTerrain.of(player), player.level().getHeight(), player.level().getMinY(),
				MinecraftNavigationWorld.magmaProtected(player));
	}

	public BlockState knownState(BlockPos position) {
		return seen.known(position.getX(), position.getY(), position.getZ());
	}

	public boolean intersects(BlockPos position, AABB body) {
		BlockState state = knownState(position);
		return state != null && state.getCollisionShape(this, position).toAabbs().stream()
				.anyMatch(box -> box.move(position).intersects(body));
	}

	public boolean isFullBlockStandable(BlockPos feet) {
		BlockPos floor = feet.below();
		BlockState support = knownState(floor);
		return support != null && terrain.isStandable(new GridPosition(feet.getX(), feet.getY(), feet.getZ()))
				&& Block.isShapeFullBlock(support.getCollisionShape(this, floor));
	}

	@Override
	public BlockState getBlockState(BlockPos position) {
		BlockState state = knownState(position);
		// Unknown neighbours cannot provide clearance through live geometry.
		return state == null ? Blocks.BARRIER.defaultBlockState() : state;
	}

	@Override public FluidState getFluidState(BlockPos position) { return getBlockState(position).getFluidState(); }
	@Override public BlockEntity getBlockEntity(BlockPos position) { return null; }
	@Override public int getHeight() { return height; }
	@Override public int getMinY() { return minY; }
}
