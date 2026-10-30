package dev.agaminggod.arenaagents.server.runtime;

import dev.agaminggod.arenaagents.agent.AgentDomainException;
import dev.agaminggod.arenaagents.server.perception.EntityHitboxSight;
import dev.agaminggod.arenaagents.server.perception.SeenTerrain;
import java.lang.reflect.Field;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.Holder;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.effect.MobEffect;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityEquipment;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.EntityTypes;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Abilities;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.SnowLayerBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;

/** Shared aiming is judged by actual vanilla rays, not by the selected point's appearance. */
public final class TargetSightlineVerification {
	private static int assertions;
	private TargetSightlineVerification() { }

	public static int verify() {
		assertions = 0;
		verifyRequestedBlockFace();
		verifyPlacementClicks();
		verifySimulatorMiningParity();
		verifyEntityExposedRegions();
		verifyEntityCrosshairOutlines();
		verifyCurrentPlacementFacts();
		verifyRequestedFaceView();
		verifyRangedGeometryBound();
		return assertions;
	}

	private static void verifyRequestedBlockFace() {
		World world = new World();
		BlockPos target = new BlockPos(3, 0, 0);
		world.states.put(target, Blocks.STONE.defaultBlockState());
		world.states.put(new BlockPos(1, 1, 0), Blocks.STONE.defaultBlockState());
		Vec3 eye = new Vec3(-.4D, 1.62D, .5D);
		Vec3 point = TargetSightline.block(world, CollisionContext.empty(), eye, target, 4.5D, Direction.WEST);
		check(point != null, "requested west face exposes a narrow strip despite hidden center");
		var hit = ray(world, eye, point, 4.5D, ClipContext.Block.OUTLINE);
		check(hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(target) && hit.getDirection() == Direction.WEST,
				"actual rounded player ray hits the exact requested face");
		check(TargetSightline.block(world, CollisionContext.empty(), eye, target, 4.5D, Direction.EAST) == null,
				"an invisible requested face never substitutes another visible face");
		check(TargetSightline.block(world, CollisionContext.empty(), eye, target, 2D, Direction.WEST) == null,
				"no selected face extends vanilla reach");
		world.states.put(new BlockPos(1, 0, 0), Blocks.STONE.defaultBlockState());
		check(TargetSightline.block(world, CollisionContext.empty(), eye, target, 4.5D, Direction.WEST) == null,
				"fully covered target has no selectable part");
		world.states.put(target, Blocks.DIAMOND_ORE.defaultBlockState());
		check(TargetSightline.block(world, CollisionContext.empty(), eye, target, 4.5D, Direction.WEST) == null,
				"hidden target identity changes cannot make a covered face visible");
		World chest = new World();
		chest.states.put(target, Blocks.CHEST.defaultBlockState());
		Vec3 chestEye = new Vec3(0, .7D, .5D);
		point = TargetSightline.block(chest, CollisionContext.empty(), chestEye, target, 4.5D, Direction.WEST);
		check(point != null && point.x == 3.0625D, "inset chest interaction uses its actual exposed west outline");
		check(ray(chest, chestEye, point, 4.5D, ClipContext.Block.OUTLINE).getDirection() == Direction.WEST,
				"chest aim still reconstructs the requested face");
	}

	/** Production face selection uses actual vanilla outline rays and item replacement contexts. */
	private static void verifyPlacementClicks() {
		try {
			Field field = sun.misc.Unsafe.class.getDeclaredField("theUnsafe"); field.setAccessible(true);
			var unsafe = (sun.misc.Unsafe) field.get(null);
			var world = (EntityWorld) unsafe.allocateInstance(EntityWorld.class);
			world.states = new HashMap<>();
			BlockPos destination = new BlockPos(1, 0, 0);
			world.states.put(destination.west(), Blocks.OBSIDIAN.defaultBlockState());
			world.states.put(destination.below(), Blocks.STONE.defaultBlockState());
			Vec3 eye = new Vec3(-.5D, 3D, .5D);
			var holder = Blocks.OBSIDIAN.asItem().builtInRegistryHolder();
			var components = Holder.Reference.class.getDeclaredField("components"); components.setAccessible(true);
			Object original = components.get(holder);
			if (!holder.areComponentsBound()) holder.bindComponents(net.minecraft.core.component.DataComponentMap.builder()
					.set(net.minecraft.core.component.DataComponents.MAX_STACK_SIZE, 64).build());
			try {
				ItemStack stack = new ItemStack(Blocks.OBSIDIAN);
				java.util.function.Function<net.minecraft.world.phys.BlockHitResult, net.minecraft.world.item.context.BlockPlaceContext> context =
						hit -> new net.minecraft.world.item.context.BlockPlaceContext(world, null, net.minecraft.world.InteractionHand.MAIN_HAND, stack, hit);
				java.util.Map<Direction, net.minecraft.world.phys.BlockHitResult> hits = new java.util.EnumMap<>(Direction.class);
				java.util.function.Predicate<Direction> usable = face -> {
					var hit = BlockPlacementGeometry.candidate(world, CollisionContext.empty(), eye, 5D, destination, face,
							click -> context.apply(click).getClickedPos().equals(destination));
					if (hit != null) hits.put(face, hit);
					return hit != null;
				};
				check(!usable.test(Direction.EAST), "east face behind its support is hidden from the west-side eye");
				check(BlockPlacementAttemptPolicy.chooseFace(Direction.EAST, true, usable) == null, "strict face refuses hidden support");
				check(BlockPlacementAttemptPolicy.chooseFace(Direction.EAST, false, usable) == Direction.UP, "preferred face uses visible floor support");
				var alternate = hits.get(Direction.UP);
				check(alternate.getBlockPos().equals(destination.below()) && context.apply(alternate).getClickedPos().equals(destination),
						"alternate vanilla click still fills exactly the model's destination");
				check(BlockPlacementGeometry.candidate(world, CollisionContext.empty(), eye, .5D, destination, Direction.UP, hit -> true) == null,
						"alternate clicks cannot extend vanilla reach");
				var obsidian = Blocks.OBSIDIAN.defaultBlockState();
				check(BlockPlacementGeometry.equivalent(obsidian, Blocks.OBSIDIAN.getStateForPlacement(context.apply(alternate))),
						"vanilla obsidian prediction is equivalent on alternate support");
				for (var block : new net.minecraft.world.level.block.Block[] {Blocks.SHORT_GRASS, Blocks.LEAF_LITTER, Blocks.SNOW}) {
					world.states.put(destination, block.defaultBlockState());
					var hit = BlockPlacementGeometry.candidate(world, CollisionContext.empty(), new Vec3(1.5D, 2.5D, -1.5D), 5D,
							destination, Direction.UP, click -> context.apply(click).getClickedPos().equals(destination));
					check(hit != null, block + " admits an actual visible placement click without mining first");
					check(context.apply(hit).canPlace() && context.apply(hit).getClickedPos().equals(destination),
							block + " vanilla item context replaces the destination directly");
					check(ServerActionExecutor.placedByClick(true, block.defaultBlockState(), obsidian,
							new DesiredBlockState("minecraft:obsidian", Map.of())), "replacement has the same owned-placement receipt as air");
				}
				world.states.put(destination, Blocks.DANDELION.defaultBlockState());
				check(!Blocks.DANDELION.defaultBlockState().canBeReplaced(), "vanilla dandelion is occupied, unlike grass and leaf litter");
				var flowerHit = new net.minecraft.world.phys.BlockHitResult(new Vec3(1.5D, 0D, .5D), Direction.UP, destination.below(), false);
				check(!context.apply(flowerHit).canPlace(), "vanilla refuses an obsidian placement into a dandelion; parity must preserve that refusal");
				var log = Blocks.OAK_LOG.defaultBlockState();
				check(!BlockPlacementGeometry.equivalent(log, log.setValue(net.minecraft.world.level.block.state.properties.BlockStateProperties.AXIS, Direction.Axis.X)),
						"alternate log axes are not equivalent");
				var stairs = Blocks.OAK_STAIRS.defaultBlockState();
				check(!BlockPlacementGeometry.equivalent(stairs, stairs.setValue(net.minecraft.world.level.block.state.properties.BlockStateProperties.HALF,
						net.minecraft.world.level.block.state.properties.Half.TOP)), "alternate stair halves are not equivalent");
				var hopper = Blocks.HOPPER.defaultBlockState();
				check(!BlockPlacementGeometry.equivalent(hopper, hopper.setValue(net.minecraft.world.level.block.state.properties.BlockStateProperties.FACING_HOPPER, Direction.EAST)),
						"alternate hopper facings are not equivalent");
				check(!ServerActionExecutor.placementBodyObstruction(world, destination, obsidian, new AABB(1.2D, 0D, .2D, 1.8D, 1.8D, .8D)).isEmpty(),
						"real vanilla collision shape detects the player's body in the destination");
				check(ServerActionExecutor.placementBodyObstruction(world, destination, obsidian, new AABB(3D, 0D, 0D, 3.6D, 1.8D, .6D)).isEmpty(),
						"a body clear of the destination is not blamed");
			} finally { components.set(holder, original); }
		} catch (ReflectiveOperationException failure) { throw new AssertionError(failure); }
	}

	/** The coordinator simulator's break_block must judge these cases as the server does; both read the same file. */
	private static void verifySimulatorMiningParity() {
		com.google.gson.JsonObject fixture;
		try {
			fixture = com.google.gson.JsonParser.parseString(java.nio.file.Files.readString(
					java.nio.file.Path.of("coordinator", "test", "fixtures", "mining-sightline-parity.json"))).getAsJsonObject();
		} catch (java.io.IOException failure) { throw new AssertionError("mining parity fixture is unreadable", failure); }
		for (var element : fixture.getAsJsonArray("cases")) {
			var entry = element.getAsJsonObject();
			World world = new World();
			for (var block : entry.getAsJsonArray("blocks")) world.states.put(position(block.getAsJsonArray()), Blocks.STONE.defaultBlockState());
			BlockPos target = position(entry.getAsJsonArray("target"));
			world.states.put(target, Blocks.STONE.defaultBlockState());
			var feet = entry.getAsJsonArray("feet");
			Vec3 eye = new Vec3(feet.get(0).getAsDouble(), feet.get(1).getAsDouble() + 1.62D, feet.get(2).getAsDouble());
			double reach = "creative".equals(entry.get("gameMode").getAsString()) ? 5D : 4.5D;
			boolean visible = TargetSightline.block(world, CollisionContext.empty(), eye, target, reach, null) != null;
			check(visible == entry.get("visible").getAsBoolean(), "server mining sightline matches the shared parity case: " + entry.get("name").getAsString());
		}
	}

	private static BlockPos position(com.google.gson.JsonArray values) {
		return new BlockPos(values.get(0).getAsInt(), values.get(1).getAsInt(), values.get(2).getAsInt());
	}

	private static void verifyEntityExposedRegions() {
		World window = new World();
		window.states.put(new BlockPos(1, 0, 0), Blocks.SNOW.defaultBlockState().setValue(SnowLayerBlock.LAYERS, 8));
		window.states.put(new BlockPos(1, 1, 0), Blocks.STONE.defaultBlockState());
		Vec3 eye = new Vec3(-.4D, 1.05D, .5D);
		AABB target = new AABB(3, 0, 0, 4, 1, 1);
		check(EntityHitboxSight.point(eye, target, point -> clear(window, eye, target, point, 4.5D)) == null,
				"center, nearest point and every inset corner are obstructed in the window fixture");
		Vec3 point = TargetSightline.entity(window, CollisionContext.empty(), eye, target, 4.5D);
		check(point != null, "shared exposed-region geometry finds the entity strip missed by corner sampling");
		check(clear(window, eye, target, point, 4.5D), "selected entity aim is clear through actual collider geometry");
		Vec3 delta = point.subtract(eye);
		float yaw = (float) Math.toDegrees(Math.atan2(-delta.x, delta.z));
		float pitch = (float) -Math.toDegrees(Math.atan2(delta.y, Math.hypot(delta.x, delta.z)));
		check(EntityHitboxSight.clearRay(window, CollisionContext.empty(), eye, yaw, pitch, target, 4.5D),
				"entity strip survives actual player float-angle reconstruction");
		check(TargetSightline.entity(window, CollisionContext.empty(), eye, target, 2) == null, "entity solver retains held reach");
		window.states.put(new BlockPos(1, 0, 0), Blocks.STONE.defaultBlockState());
		check(TargetSightline.entity(window, CollisionContext.empty(), eye, target, 4.5D) == null, "hidden entity receives no fabricated aim");
		World clear = new World();
		for (AABB box : new AABB[]{target, new AABB(3, .25, .25, 3.1D, .35D, .35D), new AABB(-3, 1, -3, -2, 3, -2)}) {
			Vec3 aim = TargetSightline.entity(clear, CollisionContext.empty(), eye, box, 10);
			check(aim != null && clear(clear, eye, box, aim, 10), "clear short or ordinary boxes remain exactly targetable");
		}
	}

	private static void verifyEntityCrosshairOutlines() {
		try {
			Field field = sun.misc.Unsafe.class.getDeclaredField("theUnsafe"); field.setAccessible(true);
			var unsafe = (sun.misc.Unsafe) field.get(null);
			var world = (EntityWorld) unsafe.allocateInstance(EntityWorld.class);
			world.states = new HashMap<>();
			BlockPos grass = new BlockPos(0, 0, 2);
			world.states.put(grass, Blocks.SHORT_GRASS.defaultBlockState());
			AABB outline = world.getBlockState(grass).getShape(world, grass).bounds().move(grass);
			Vec3 eye = new Vec3(outline.getCenter().x, 1.62D, .5D);
			var player = (EntityPlayer) unsafe.allocateInstance(EntityPlayer.class);
			player.setId(1005); // 26.3 assigns entity IDs in the constructor, which Unsafe allocation skips.
			player.world = world;
			EntityEquipment equipment = new EntityEquipment();
			set(player, LivingEntity.class, "equipment", equipment);
			set(player, Player.class, "inventory", new Inventory(player, equipment));
			set(player, Player.class, "abilities", new Abilities());
			set(player, Entity.class, "type", EntityTypes.PLAYER);
			set(player, Entity.class, "position", eye.subtract(0D, 1.62D, 0D));
			set(player, Entity.class, "eyeHeight", 1.62F);
			set(player, Entity.class, "bb", new AABB(eye.x - .3D, 0D, .2D, eye.x + .3D, 1.8D, .8D));
			var target = (ServerPlayer) unsafe.allocateInstance(ServerPlayer.class);
			target.setId(1006); // 26.3 assigns entity IDs in the constructor, which Unsafe allocation skips.
			for (double[] dimensions : new double[][]{{.9D, .9D}, {.4D, .7D}, {1.4D, .9D}}) {
				double width = dimensions[0], height = dimensions[1], grassDistance = outline.maxZ - eye.z;
				double front = eye.z + Math.max(grassDistance + .05D,
						(eye.y - height) * grassDistance / (eye.y - outline.maxY) + .05D);
				AABB box = new AABB(eye.x - width / 2D, 0D, front, eye.x + width / 2D, height, front + width);
				set(target, Entity.class, "bb", box);
				Vec3 centreHit = EntityHitboxSight.intersection(eye, box.getCenter(), box);
				check(EntityHitboxSight.clear(world, CollisionContext.empty(), eye, centreHit, ClipContext.Block.COLLIDER),
						"short pig/chicken/spider center is projectile-clear through actual short grass");
				check(!EntityHitboxSight.clear(world, CollisionContext.empty(), eye, centreHit, ClipContext.Block.OUTLINE),
						"the same center ray is blocked by the actual vanilla grass outline");
				Vec3 top = new Vec3(eye.x, height - 1.0E-4D, front + 1.0E-4D);
				check(EntityHitboxSight.clear(world, CollisionContext.empty(), eye,
						EntityHitboxSight.intersection(eye, top, box), ClipContext.Block.OUTLINE),
						"the real short entity top remains crosshair-visible above the grass");
				Vec3 melee = TargetSightline.entity(player, target, 3D);
				check(melee != null && roundedClear(world, eye, box, melee, 3D, ClipContext.Block.OUTLINE),
						"melee/interact targeting selects a part the actual rounded outline crosshair can hit");
				Vec3 ranged = TargetSightline.rangedEntity(player, target);
				check(ranged.equals(box.getCenter()) && roundedClear(world, eye, box, ranged, 6D, ClipContext.Block.COLLIDER),
						"ranged targeting retains its projectile-clear center through noncolliding grass");
			}
		} catch (ReflectiveOperationException failure) { throw new AssertionError("entity outline fixture failed", failure); }
	}

	private static boolean roundedClear(BlockGetter world, Vec3 eye, AABB target, Vec3 aim, double reach, ClipContext.Block mode) {
		Vec3 delta = aim.subtract(eye);
		float yaw = (float) Math.toDegrees(Math.atan2(-delta.x, delta.z));
		float pitch = (float) -Math.toDegrees(Math.atan2(delta.y, Math.hypot(delta.x, delta.z)));
		Vec3 end = eye.add(Vec3.directionFromRotation(pitch, yaw).scale(reach));
		return EntityHitboxSight.clear(world, CollisionContext.empty(), eye, EntityHitboxSight.intersection(eye, end, target), mode);
	}
	private static void set(Object target, Class<?> owner, String name, Object value) throws ReflectiveOperationException {
		Field field = owner.getDeclaredField(name); field.setAccessible(true); field.set(target, value);
	}

	/** A hidden support face is explained the way a player would see it; nothing unseen is named. */
	private static void verifyRequestedFaceView() {
		World world = new World();
		BlockPos support = new BlockPos(15, 61, 87), destination = new BlockPos(14, 61, 87);
		BlockState bricks = Blocks.NETHER_BRICKS.defaultBlockState();
		world.states.put(support, bricks);
		// Fortress bridge: standing on the support, eye east of its west face.
		String away = BlockPlacementGeometry.requestedFaceView(world, CollisionContext.empty(), new Vec3(15.37D, 63.62D, 87.56D), 4.5D,
				destination, Direction.WEST, bricks.getShape(world, support));
		check(away.contains("the west face of 15,61,87 faces away from your eye")
				&& away.contains("your eye x=15.37 must be west of x=15.00"), "a face turned from the eye names the plane to pass: " + away);
		Vec3 edge = new Vec3(14.75D, 63.27D, 87.5D);
		check(TargetSightline.block(world, CollisionContext.empty(), edge, support, 4.5D, Direction.WEST) != null,
				"past the plane at the sneaking edge, the west face is visible as for a player");
		String toward = BlockPlacementGeometry.requestedFaceView(world, CollisionContext.empty(), edge, 4.5D, destination, Direction.WEST,
				bricks.getShape(world, support));
		check(toward.contains("is turned toward your eye and in reach"), "a visible face is not blamed: " + toward);
		String far = BlockPlacementGeometry.requestedFaceView(world, CollisionContext.empty(), new Vec3(8.5D, 62.62D, 87.5D), 4.5D,
				destination, Direction.WEST, null);
		check(far.contains("is out of reach: its nearest point is 6.53 from your eye") && far.contains("reach 4.50"), "reach is measured eye to face: " + far);
		// The eye inside the upper half of tall grass: vanilla's crosshair meets the grass first.
		BlockPos grass = new BlockPos(16, 63, 87);
		world.states.put(grass, Blocks.TALL_GRASS.defaultBlockState().setValue(
				net.minecraft.world.level.block.DoublePlantBlock.HALF, net.minecraft.world.level.block.state.properties.DoubleBlockHalf.UPPER));
		BlockPos ground = new BlockPos(17, 61, 87), cell = new BlockPos(17, 62, 87);
		world.states.put(ground, Blocks.GRASS_BLOCK.defaultBlockState());
		String blocked = BlockPlacementGeometry.requestedFaceView(world, CollisionContext.empty(), new Vec3(16.5D, 63.62D, 87.5D), 4.5D,
				cell, Direction.UP, Blocks.GRASS_BLOCK.defaultBlockState().getShape(world, ground));
		check(blocked.contains("first meets minecraft:tall_grass at 16,63,87 (your eye is inside it)"), "the blocker on the line is named: " + blocked);
		String unseen = BlockPlacementGeometry.requestedFaceView(world, CollisionContext.empty(), new Vec3(18.5D, 63.62D, 87.5D), 4.5D,
				cell, Direction.UP, null);
		check(unseen.contains("look at it to observe the support") && !unseen.contains("grass_block"), "an unseen support is not revealed: " + unseen);
	}

	private static void verifyCurrentPlacementFacts() {
		BlockPos target = new BlockPos(3, 64, 0);
		boolean[] visible = {true};
		BlockState[] actual = {Blocks.STONE.defaultBlockState()};
		var source = new SeenTerrain.Source<BlockState>() {
			public BlockState live(int x, int y, int z) { return actual[0]; }
			public boolean sees(int x, int y, int z) { return visible[0]; }
		};
		var memory = new SeenTerrain.Memory<BlockState>();
		var seen = new SeenTerrain.Reader<>(memory, source, 1L, null);
		check(ServerActionExecutor.perceivedPlacementState(seen, target).is(Blocks.STONE), "currently seen occupied destination is admitted as a fact");
		visible[0] = false;
		for (BlockState hidden : new BlockState[]{Blocks.AIR.defaultBlockState(), Blocks.LAVA.defaultBlockState(), Blocks.DIAMOND_BLOCK.defaultBlockState()}) {
			actual[0] = hidden;
			seen = new SeenTerrain.Reader<>(memory, source, 2L, null);
			try {
				ServerActionExecutor.perceivedPlacementState(seen, target);
				throw new AssertionError("hidden placement state must not be disclosed");
			} catch (AgentDomainException refused) {
				check(refused.code().equals("TARGET_NOT_VISIBLE"), "unknown occupancy or already-satisfied state produces the same truthful refusal");
			}
		}
		visible[0] = true;
		actual[0] = Blocks.AIR.defaultBlockState();
		check(ServerActionExecutor.perceivedPlacementState(new SeenTerrain.Reader<>(memory, source, 3L, null), target).isAir(),
				"a newly seen empty destination becomes usable without a retry policy");
	}

	private static void verifyRangedGeometryBound() {
		Vec3 below = new Vec3(.3D, -.5D, .3D);
		AABB tall = new AABB(0, 0, 0, .6D, 2.9D, .6D);
		check(TargetSightline.rangedReach(below, tall) >= below.distanceTo(new Vec3(0, 2.9D, 0)),
				"ranged aiming can reach the exposed top of a tall vanilla hitbox without a melee cap");
		Vec3 outside = new Vec3(-2, 0, 0);
		AABB longBox = new AABB(0, 0, 0, 10, .1D, .1D);
		check(TargetSightline.rangedReach(outside, longBox) >= outside.distanceTo(new Vec3(10, .1D, .1D)),
				"ranged aiming does not truncate the far exposed end of an elongated hitbox");
	}

	private static boolean clear(BlockGetter world, Vec3 eye, AABB target, Vec3 aim, double reach) {
		Vec3 hit = EntityHitboxSight.intersection(eye, aim, target);
		return hit != null && eye.distanceToSqr(hit) <= reach * reach
				&& EntityHitboxSight.clear(world, CollisionContext.empty(), eye, hit, ClipContext.Block.COLLIDER);
	}
	private static net.minecraft.world.phys.BlockHitResult ray(World world, Vec3 eye, Vec3 point, double reach, ClipContext.Block shape) {
		Vec3 delta = point.subtract(eye);
		float yaw = (float) Math.toDegrees(Math.atan2(-delta.x, delta.z));
		float pitch = (float) -Math.toDegrees(Math.atan2(delta.y, Math.hypot(delta.x, delta.z)));
		return world.clip(new ClipContext(eye, eye.add(Vec3.directionFromRotation(pitch, yaw).scale(reach)), shape, ClipContext.Fluid.NONE, CollisionContext.empty()));
	}
	private static void check(boolean condition, String label) {
		if (!condition) throw new AssertionError(label);
		assertions++;
	}
	private static final class EntityPlayer extends ServerPlayer {
		EntityWorld world;
		private EntityPlayer() { super(null, null, null, null); }
		@Override public ServerLevel level() { return world; }
		@Override public ItemStack getMainHandItem() { return ItemStack.EMPTY; }
		@Override public boolean hasEffect(Holder<MobEffect> effect) { return false; }
		@Override public boolean isInWater() { return false; }
		@Override public boolean isUnderWater() { return false; }
		@Override public boolean isInLava() { return false; }
		@Override public boolean isShiftKeyDown() { return false; }
	}
	private static final class EntityWorld extends ServerLevel {
		// 26.3 entities take their ID from the level, and ServerLevel asks its (absent) chunk source.
		private int fixtureEntityIds = 100_000;
		@Override public int getNextEntityId() { return ++fixtureEntityIds; }
		Map<BlockPos, BlockState> states;
		private EntityWorld() { super(null, null, null, null, null, null, false, 0, List.of(), false); }
		@Override public BlockState getBlockState(BlockPos position) { return states.getOrDefault(position, Blocks.AIR.defaultBlockState()); }
		@Override public FluidState getFluidState(BlockPos position) { return getBlockState(position).getFluidState(); }
		@Override public int getHeight() { return 384; }
		@Override public int getMinY() { return -64; }
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
