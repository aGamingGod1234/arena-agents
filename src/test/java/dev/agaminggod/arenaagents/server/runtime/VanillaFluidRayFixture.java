package dev.agaminggod.arenaagents.server.runtime;

import net.minecraft.commands.arguments.EntityAnchorArgument;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

/** Minimal world/player storage; lookAt, calculateViewVector, clip and Item's ray are vanilla bodies. */
final class VanillaFluidRayFixture {
	private static final sun.misc.Unsafe UNSAFE;
	static {
		try {
			var field = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
			field.setAccessible(true);
			UNSAFE = (sun.misc.Unsafe) field.get(null);
		} catch (ReflectiveOperationException e) { throw new ExceptionInInitializerError(e); }
	}

	static Player player(BlockGetter world, Vec3 eye, double reach) {
		try {
			World level = (World) UNSAFE.allocateInstance(World.class);
			level.blocks = world;
			Body player = (Body) UNSAFE.allocateInstance(Body.class);
			player.setId(1008); // 26.3 assigns entity IDs in the constructor, which Unsafe allocation skips.
			player.world = level;
			player.reach = reach;
			var position = Entity.class.getDeclaredField("position");
			position.setAccessible(true);
			position.set(player, eye);
			var eyeHeight = Entity.class.getDeclaredField("eyeHeight");
			eyeHeight.setAccessible(true);
			eyeHeight.setFloat(player, 0);
			return player;
		} catch (ReflectiveOperationException e) { throw new AssertionError(e); }
	}

	static BlockHitResult hit(BlockGetter world, Vec3 eye, Vec3 aim, double reach, ClipContext.Fluid fluids) {
		Player player = player(world, eye, reach);
		player.lookAt(EntityAnchorArgument.Anchor.EYES, aim);
		return Oracle.hit(player, fluids);
	}

	private static final class Oracle extends Item {
		private Oracle(Properties properties) { super(properties); }
		static BlockHitResult hit(Player player, ClipContext.Fluid fluids) {
			return getPlayerPOVHitResult(player.level(), player, fluids);
		}
	}

	private static final class World extends ServerLevel {
		// 26.3 entities take their ID from the level, and ServerLevel asks its (absent) chunk source.
		private int fixtureEntityIds = 100_000;
		@Override public int getNextEntityId() { return ++fixtureEntityIds; }
		BlockGetter blocks;
		private World() { super(null, null, null, null, null, null, false, 0, java.util.List.of(), false); }
		@Override public BlockState getBlockState(BlockPos pos) { return blocks.getBlockState(pos); }
		@Override public FluidState getFluidState(BlockPos pos) { return blocks.getFluidState(pos); }
		@Override public BlockHitResult clip(ClipContext context) { return blocks.clip(context); }
	}

	private static final class Body extends Player {
		World world;
		double reach;
		private Body() { super(null, null); }
		@Override public ServerLevel level() { return world; }
		@Override public double blockInteractionRange() { return reach; }
		@Override public GameType gameMode() { return GameType.SURVIVAL; }
		@Override public boolean isDescending() { return false; }
		@Override public ItemStack getMainHandItem() { return ItemStack.EMPTY; }
	}
}
