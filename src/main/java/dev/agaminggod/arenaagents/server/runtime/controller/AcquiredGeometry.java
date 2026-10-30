package dev.agaminggod.arenaagents.server.runtime.controller;

import java.util.function.Function;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.shapes.VoxelShape;

/** Neighbour-dependent vanilla shapes can only use acquired block states. */
public final class AcquiredGeometry implements BlockGetter {
	private final Function<BlockPos, BlockState> known;
	private final int height;
	private final int minY;
	private boolean unknown;

	public AcquiredGeometry(BlockGetter bounds, Function<BlockPos, BlockState> known) {
		this.known = known;
		height = bounds.getHeight();
		minY = bounds.getMinY();
	}

	VoxelShape shape(BlockState state, BlockPos position) {
		unknown = false;
		VoxelShape shape = state.getCollisionShape(this, position);
		return unknown ? null : shape;
	}

	public VoxelShape outlineShape(BlockState state, BlockPos position) {
		unknown = false;
		VoxelShape shape = state.getShape(this, position);
		return unknown ? null : shape;
	}

	public Float fluidHeight(FluidState state, BlockPos position) {
		unknown = false;
		float result = state.getHeight(this, position);
		return unknown ? null : result;
	}

	boolean unknownLine() { return unknown; }

	/** Unknown ray cells or shape dependencies cannot certify a clear melee line. */
	boolean clearLine(net.minecraft.world.phys.Vec3 eye, net.minecraft.world.phys.Vec3 hit) {
		unknown = false;
		boolean clear = dev.agaminggod.arenaagents.server.perception.EntityHitboxSight.clear(this,
				net.minecraft.world.phys.shapes.CollisionContext.empty(), eye, hit,
				net.minecraft.world.level.ClipContext.Block.COLLIDER);
		return clear && !unknown;
	}

	@Override public BlockState getBlockState(BlockPos position) {
		BlockState state = known.apply(position);
		if (state == null) unknown = true;
		return state == null ? Blocks.BARRIER.defaultBlockState() : state;
	}
	@Override public BlockEntity getBlockEntity(BlockPos position) { unknown = true; return null; }
	@Override public FluidState getFluidState(BlockPos position) { return getBlockState(position).getFluidState(); }
	@Override public int getHeight() { return height; }
	@Override public int getMinY() { return minY; }
}
