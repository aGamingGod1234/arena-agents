package dev.agaminggod.arenaagents.server.runtime;

import dev.agaminggod.arenaagents.server.perception.ObservationVisibility;
import dev.agaminggod.arenaagents.server.perception.SeenTerrain;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.lang.reflect.Method;
import java.util.HashMap;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;

/** Review reproductions use vanilla visual rays, real terrain memory, and the production blocker helper. */
public final class BlockerVisibilityVerification {
	private static final BlockPos TARGET = new BlockPos(3, 0, 0);
	private static int assertions;

	public static int verify() {
		assertions = 0;
		lowerStrip();
		changedOccluder();
		return assertions;
	}

	private static void lowerStrip() {
		World world = new World();
		world.put(TARGET, Blocks.STONE.defaultBlockState());
		world.put(new BlockPos(1, 1, 0), Blocks.STONE.defaultBlockState());
		Vec3 eye = new Vec3(-.4D, 1.62D, .5D);
		Vec3 view = new Vec3(3D, .01D, .5D).subtract(eye).normalize();
		for (var shape : new ClipContext.Block[] { ClipContext.Block.OUTLINE, ClipContext.Block.VISUAL }) {
			var hit = world.clip(new ClipContext(eye, eye.add(view.scale(4.5D)), shape, ClipContext.Fluid.NONE, CollisionContext.empty()));
			check(hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(TARGET), "vanilla ray sees the exposed lower strip: " + shape);
		}
		var crosshair = world.clip(new ClipContext(eye, eye.add(view.scale(4.5D)), ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, CollisionContext.empty()));
		check(BreakSightline.visibleBlocker(world, CollisionContext.empty(), eye, new BlockPos(4, 0, 0), crosshair) == null,
				"the old centre-ray fallback cannot supply this blocker");
		check(visible(world, eye, view, TARGET), "the shared cell visibility includes the lower strip");
		var reader = new SeenTerrain.Reader<>(new SeenTerrain.Memory<BlockState>(), source(world, eye, view), 1L, null);
		check("minecraft:stone at 3,0,0 is in the way".equals(ServerActionExecutor.seenBlocker(reader, TARGET)),
				"a visible lower strip supplies the blocker even without old memory");
		Vec3 offCentre = new Vec3(3D, .3D, .5D).subtract(eye).normalize();
		check(visible(world, eye, offCentre, TARGET), "lower-face sight is not limited to the crosshair sample");
		check(!visible(world, eye, view.scale(-1D), TARGET), "the visible strip still requires the current view cone");
		world.put(new BlockPos(1, 0, 0), Blocks.STONE.defaultBlockState());
		check(ServerActionExecutor.seenBlocker(reader, TARGET) == null, "a newly covered strip is omitted even in the same reader");
	}

	private static void changedOccluder() {
		World world = new World();
		world.put(TARGET, Blocks.STONE.defaultBlockState());
		BlockPos occluder = new BlockPos(1, 0, 0);
		world.put(new BlockPos(1, 0, 1), Blocks.COBBLESTONE.defaultBlockState());
		Vec3 eye = new Vec3(.5D, .5D, .5D), view = new Vec3(1D, 0D, 1D).normalize();
		var memory = new SeenTerrain.Memory<BlockState>();
		var source = source(world, eye, view);
		check(new SeenTerrain.Reader<>(memory, source, 1L, null).known(3, 0, 0).is(Blocks.STONE), "stone is acquired before it is hidden");
		world.put(occluder, Blocks.STONE.defaultBlockState());
		var hidden = new LongOpenHashSet();
		check(ServerActionExecutor.seenBlocker(new SeenTerrain.Reader<>(memory, source, 2L, hidden), TARGET) == null,
				"the occluder currently hides stone");
		check(hidden.contains(TARGET.asLong()), "the negative cache contains the hidden target");
		world.put(occluder, Blocks.AIR.defaultBlockState());
		check(visible(world, eye, view, TARGET), "unchanged pose sees stone when the occluder is removed");
		var crosshair = world.clip(new ClipContext(eye, eye.add(view.scale(4.5D)), ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, CollisionContext.empty()));
		check(BreakSightline.visibleBlocker(world, CollisionContext.empty(), eye, new BlockPos(4, 0, 0), crosshair) == null,
				"the crosshair on a different block cannot repair the stale cache");
		var reader = new SeenTerrain.Reader<>(memory, source, 3L, hidden);
		check("minecraft:stone at 3,0,0 is in the way".equals(ServerActionExecutor.seenBlocker(reader, TARGET)),
				"the retained negative cannot hide a currently visible blocker");
		check(!hidden.contains(TARGET.asLong()), "current sight invalidates the stale negative");
		world.put(occluder, Blocks.STONE.defaultBlockState());
		check(ServerActionExecutor.seenBlocker(reader, TARGET) == null, "same-tick positive evidence is invalidated when the occluder returns");
		world.put(occluder, Blocks.AIR.defaultBlockState());
		check(ServerActionExecutor.seenBlocker(reader, TARGET) != null, "same-tick negative evidence is invalidated when it clears again");
	}

	private static SeenTerrain.Source<BlockState> source(World world, Vec3 eye, Vec3 view) {
		return new SeenTerrain.Source<>() {
			public BlockState live(int x, int y, int z) { return world.getBlockState(new BlockPos(x, y, z)); }
			public boolean sees(int x, int y, int z) { return visible(world, eye, view, new BlockPos(x, y, z)); }
		};
	}

	private static boolean visible(World world, Vec3 eye, Vec3 view, BlockPos cell) {
		try {
			Method method = ObservationVisibility.class.getDeclaredMethod("seesCell", BlockGetter.class, CollisionContext.class, Vec3.class, Vec3.class, BlockPos.class);
			method.setAccessible(true);
			return (boolean) method.invoke(null, world, CollisionContext.empty(), eye, view, cell);
		} catch (ReflectiveOperationException exception) {
			throw new AssertionError(exception);
		}
	}

	private static final class World extends BreakSightline.SeenWorld {
		private final Map<BlockPos, BlockState> blocks = new HashMap<>();
		World() { super(-64, 384); }
		void put(BlockPos position, BlockState state) { blocks.put(position, state); }
		BlockState knownState(BlockPos position) { return blocks.getOrDefault(position, Blocks.AIR.defaultBlockState()); }
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
