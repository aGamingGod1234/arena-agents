package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonObject;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.HitResult;
import java.util.concurrent.atomic.AtomicBoolean;
import net.minecraft.core.Direction;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

public final class ServerObservationRayTargetVerification {
	private ServerObservationRayTargetVerification() {
	}

	public static int verify() {
		AtomicBoolean blockLookupCalled = new AtomicBoolean();
		BlockHitResult miss = BlockHitResult.miss(Vec3.ZERO, Direction.NORTH, BlockPos.ZERO);

		JsonObject rayTarget = ServerObservationCollector.rayTarget(miss, position -> {
			blockLookupCalled.set(true);
			return "minecraft:stone";
		});

		assertEquals("{\"type\":\"miss\"}", rayTarget.toString(), "miss ray target contains only its type");
		assertFalse(blockLookupCalled.get(), "miss ray target does not resolve a block");
		try {
			return 2 + LandmarkCoverageFixture.verify();
		} catch (ReflectiveOperationException exception) {
			throw new AssertionError("could not execute sparse landmark fixture", exception);
		} catch (Exception exception) {
			throw new AssertionError(exception);
		}
	}

	private static void assertEquals(Object expected, Object actual, String label) {
		if (!expected.equals(actual)) {
			throw new AssertionError(label + ": expected <" + expected + "> but was <" + actual + ">");
		}
	}

	private static void assertFalse(boolean condition, String label) {
		if (condition) throw new AssertionError(label);
	}

	// Constructor-free world/player fixtures execute vanilla clipping and the real collector.
	private static final class LandmarkCoverageFixture {
		static sun.misc.Unsafe unsafe;
		static Method rawMethod, sampleMethod;
		static int assertions;
		static int verify() throws Exception {
			assertions = 0;
			net.minecraft.SharedConstants.tryDetectVersion();
			net.minecraft.server.Bootstrap.bootStrap();
			Field f = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
			f.setAccessible(true); unsafe = (sun.misc.Unsafe) f.get(null);
			verifyAirRaySkipEquivalence();
			verifyEdgeExposure();
			rawMethod = ServerObservationCollector.class.getDeclaredMethod("rawSpatialObservation", ServerLevel.class, ServerPlayer.class, BlockPos.class);
			sampleMethod = ServerObservationCollector.class.getDeclaredMethod("visibleSurfaceCandidates", ServerLevel.class, ServerPlayer.class, BlockPos.class);
			rawMethod.setAccessible(true); sampleMethod.setAccessible(true);
			checkCase("vertical_gap", new BlockPos(2,60,0), false, true, false);
			checkCase("within_cube_control", new BlockPos(2,61,0), true, false, true);
			checkCase("outside_sphere_control", new BlockPos(6,60,0), false, true, false);
			checkCase("above_local_scan", new BlockPos(2,68,0), false, true, true);
			checkCase("local_corner_preserved", new BlockPos(6,64,6), true, true, false);
			return assertions;
		}

		/** Position and the matching standing box (body contact reads the box). */
		static void place(FixturePlayer player, Vec3 p) throws Exception {
			set(player, "position", p);
			set(player, "bb", new net.minecraft.world.phys.AABB(p.x - 0.3, p.y, p.z - 0.3, p.x + 0.3, p.y + 1.8, p.z + 0.3));
		}

		static void verifyEdgeExposure() throws Exception {
			SparseWorld world = new SparseWorld();
			// The neighbouring floor is five blocks below feet; all other floor (out past a hit's push) remains supported.
			for (int x = -5; x <= 5; x++) for (int z = -5; z <= 5; z++) {
				world.states.put(new BlockPos(x, x == 1 && z == 0 ? 58 : 63, z), Blocks.STONE.defaultBlockState());
			}
			FixtureLevel level = (FixtureLevel) unsafe.allocateInstance(FixtureLevel.class);
			level.world = world;
			level.loaded = true;
			FixturePlayer player = (FixturePlayer) unsafe.allocateInstance(FixturePlayer.class);
			player.setId(1027); // 26.3 assigns entity IDs in the constructor, which Unsafe allocation skips.
			player.fixtureLevel = level;
			set(player, "onGround", true);
			place(player, new Vec3(0.5D, 64, 0.5D));
			set(player, "blockPosition", new BlockPos(0, 64, 0));
			set(player, "eyeHeight", 1.62F);
			// Facing the opening (east) and looking down at it.
			set(player, "yRot", -90F);
			set(player, "xRot", 60F);
			var collector = (ServerObservationCollector) unsafe.allocateInstance(ServerObservationCollector.class);
			JsonObject quiet = new JsonObject();
			quiet.addProperty("attention", false);
			quiet.add("threats", new JsonObject());
			int before = level.clips;
			collector.addDangerFooting(new dev.agaminggod.arenaagents.agent.AgentId(java.util.UUID.randomUUID()), quiet);
			ok(level.clips == before, "quiet heartbeat with threats never enters the edge probe");

			// The near edge hides the bottom from the view: a glance over the edge reads the landing below it.
			JsonObject opening = EdgeExposure.facts(player);
			ok(opening != null && opening.get("drop").getAsInt() == 5 && !opening.has("atLeast"),
					"an opening whose bottom the view hides reports the depth a glance over the edge shows: " + opening);
			// Closer to the edge the eye sees down to the floor: its exact depth.
			SeenTerrain.forget(player);
			place(player, new Vec3(0.75D, 64, 0.5D));
			JsonObject facts = EdgeExposure.facts(player);
			ok(facts != null && facts.get("drop").getAsInt() == 5 && !facts.has("atLeast"), "a seen floor gives its exact depth");
			for (int depth = 1; depth <= 3; depth++) {
				SeenTerrain.forget(player);
				BlockPos shallow = new BlockPos(1, 63 - depth, 0);
				world.states.put(shallow, Blocks.STONE.defaultBlockState());
				ok(EdgeExposure.facts(player) == null, "a known shallow step is not an uncertain cliff: " + depth);
				world.states.remove(shallow);
			}
			SeenTerrain.forget(player);
			world.states.remove(new BlockPos(1, 58, 0));
			facts = EdgeExposure.facts(player);
			// Nothing below to the world's bottom: the void a player sees over the edge (End islands), not a 4+ drop.
			ok(facts.has("into") && facts.get("into").getAsString().equals("void") && !facts.has("atLeast") && facts.get("drop").getAsInt() > 4,
					"an empty column below the edge reports the void: " + facts);
			SeenTerrain.forget(player);
			world.states.put(new BlockPos(1, 64, 0), Blocks.STONE.defaultBlockState());
			ok(EdgeExposure.facts(player) == null, "occluded opening gives no edge fact");
			SeenTerrain.forget(player);
			world.states.remove(new BlockPos(1, 64, 0));
			world.states.put(new BlockPos(1, 54, 0), Blocks.STONE.defaultBlockState());
			facts = EdgeExposure.facts(player);
			ok(facts.get("drop").getAsInt() == 9 && !facts.has("atLeast"),
					"a deep floor hidden from the view is the drop a glance over the edge shows, not an understated 4+: " + facts);
			// Facing away, an opening the player never looked at is not measured (a clear ray behind the eye is not sight).
			SeenTerrain.forget(player);
			place(player, new Vec3(0.5D, 64, 0.5D));
			set(player, "yRot", 90F);
			set(player, "xRot", 0F);
			ok(EdgeExposure.facts(player) == null, "a pit behind the eye that was never seen gives no edge fact");
			set(player, "yRot", -90F);
			set(player, "xRot", 60F);
			world.states.clear();
			for (var block : new net.minecraft.world.level.block.Block[] {Blocks.OAK_SLAB, Blocks.OAK_STAIRS, Blocks.FARMLAND, Blocks.SOUL_SAND}) {
				SeenTerrain.forget(player);
				for (int x = -5; x <= 5; x++) for (int z = -5; z <= 5; z++) world.states.put(new BlockPos(x, 63, z), block.defaultBlockState());
				double top = block == Blocks.OAK_SLAB || block == Blocks.OAK_STAIRS ? 63.5D : 63.875D;
				place(player, new Vec3(0.5D, top, 0.5D));
				set(player, "blockPosition", new BlockPos(0, 63, 0));
				ok(EdgeExposure.facts(player) == null, "partial support bridge has no false cliff: " + block);
			}
			world.states.clear();
			for (int x = -1; x <= 1; x++) for (int z = -1; z <= 1; z++) world.states.put(new BlockPos(x, 63, z), Blocks.STONE.defaultBlockState());
			world.states.remove(new BlockPos(1, 63, 0));
			place(player, new Vec3(0.95D, 64, 0.5D));
			set(player, "blockPosition", new BlockPos(0, 64, 0));
			for (var block : new net.minecraft.world.level.block.Block[] {Blocks.LAVA, Blocks.WATER}) {
				SeenTerrain.forget(player);
				set(player, "yRot", -90F);
				world.states.put(new BlockPos(1, 58, 0), block.defaultBlockState());
				facts = EdgeExposure.facts(player);
				ok(facts != null && facts.get("drop").getAsInt() == 6 && !facts.has("atLeast"), "visible fluid stops depth scan");
				ok(facts.get("into").getAsString().equals(block == Blocks.LAVA ? "lava" : "water"), "visible fluid reports landing material");
				set(player, "yRot", 90F);
				ok(facts.equals(EdgeExposure.facts(player)), "a pit seen moments ago is remembered after turning away");
			}
			// A drop two cells off across open floor is within a hit's push (runs d9-nether-d, d10-nether-b): reported
			// with its distance; a wall between stops the push, so no fact.
			world.states.clear();
			for (int x = -6; x <= 2; x++) for (int z = -4; z <= 4; z++) world.states.put(new BlockPos(x, 63, z), Blocks.STONE.defaultBlockState());
			for (int x = 3; x <= 5; x++) for (int z = -4; z <= 4; z++) world.states.put(new BlockPos(x, 50, z), Blocks.STONE.defaultBlockState());
			SeenTerrain.forget(player);
			place(player, new Vec3(0.5D, 64, 0.5D));
			set(player, "blockPosition", new BlockPos(0, 64, 0));
			set(player, "yRot", -90F);
			set(player, "xRot", 35F);
			facts = EdgeExposure.facts(player);
			ok(facts != null && facts.get("drop").getAsInt() == 13 && facts.get("distance").getAsDouble() == 2.2D
					&& facts.get("yaw").getAsInt() == -90, "an open drop within knockback reach reports its distance: " + facts);
			place(player, new Vec3(-1.5D, 64, 0.5D));
			set(player, "blockPosition", new BlockPos(-2, 64, 0));
			SeenTerrain.forget(player);
			ok(EdgeExposure.facts(player) == null, "a drop beyond knockback reach gives no fact: " + EdgeExposure.facts(player));
			place(player, new Vec3(0.5D, 64, 0.5D));
			set(player, "blockPosition", new BlockPos(0, 64, 0));
			for (int z = -4; z <= 4; z++) world.states.put(new BlockPos(2, 64, z), Blocks.STONE.defaultBlockState());
			SeenTerrain.forget(player);
			ok(EdgeExposure.facts(player) == null, "a wall between the body and the drop stops the push: " + EdgeExposure.facts(player));

		}

		static void verifyAirRaySkipEquivalence() throws Exception {
			SparseWorld world = new SparseWorld();
			FixtureLevel contextLevel = (FixtureLevel) unsafe.allocateInstance(FixtureLevel.class);
			contextLevel.world = world;
			contextLevel.loaded = true;
			FixturePlayer contextPlayer = (FixturePlayer) unsafe.allocateInstance(FixturePlayer.class);
			contextPlayer.setId(1028); // 26.3 assigns entity IDs in the constructor, which Unsafe allocation skips.
			contextPlayer.fixtureLevel = contextLevel;
			set(contextPlayer, "position", new Vec3(0.5D, 64.0D, 0.5D));
			set(contextPlayer, "blockPosition", new BlockPos(0, 64, 0));
			set(contextPlayer, "eyeHeight", 1.62F);
			BlockState[] shapes = {
					Blocks.STONE.defaultBlockState(), Blocks.WATER.defaultBlockState(), Blocks.LAVA.defaultBlockState(),
					Blocks.OAK_SLAB.defaultBlockState(), Blocks.OAK_FENCE.defaultBlockState(),
					Blocks.END_PORTAL.defaultBlockState(), Blocks.END_GATEWAY.defaultBlockState(),
					Blocks.TORCH.defaultBlockState(), Blocks.GLASS.defaultBlockState()
			};
			for (int index = 0; index < shapes.length; index++) {
				world.states.put(new BlockPos(0, 64, index - 4), shapes[index]);
			}
			Random random = new Random(0xA17C1A1L);
			for (int index = 0; index < 350; index++) {
				BlockPos position = new BlockPos(random.nextInt(49) - 24, random.nextInt(21) + 56,
						random.nextInt(49) - 24);
				world.states.put(position, shapes[random.nextInt(shapes.length)]);
			}
			int raysWithNonAir = 0;
			int raysWithoutNonAir = 0;
			for (int index = 0; index < 5_000; index++) {
				Vec3 start = new Vec3(random.nextDouble() * 48.0D - 24.0D,
						random.nextDouble() * 22.0D + 55.5D, random.nextDouble() * 48.0D - 24.0D);
				Vec3 end = new Vec3(random.nextDouble() * 48.0D - 24.0D,
						random.nextDouble() * 22.0D + 55.5D, random.nextDouble() * 48.0D - 24.0D);
				ClipContext context = new ClipContext(start, end, ClipContext.Block.VISUAL, ClipContext.Fluid.ANY, contextPlayer);
				BlockHitResult vanilla = world.clip(context);
				boolean candidate = ServerObservationCollector.rayContainsNonAir(start, end, context,
						position -> !world.getBlockState(position).isAir());
				if (candidate) {
					raysWithNonAir++;
					assertSameBlockHit(vanilla, world.clip(context), "ray (" + index + ") with a non-air cell");
				} else {
					raysWithoutNonAir++;
					if (vanilla.getType() != HitResult.Type.MISS) {
						throw new AssertionError("air-only ray skipped a vanilla block hit at sample " + index);
					}
				}
			}
			if (raysWithNonAir < 500 || raysWithoutNonAir < 500) {
				throw new AssertionError("random rays did not cover both skip and clip paths: nonAir="
						+ raysWithNonAir + ", air=" + raysWithoutNonAir);
			}
		}

		static void assertSameBlockHit(BlockHitResult expected, BlockHitResult actual, String label) {
			assertEquals(expected.getType(), actual.getType(), label + " hit type");
			if (expected.getType() != HitResult.Type.BLOCK) return;
			assertEquals(expected.getBlockPos(), actual.getBlockPos(), label + " hit position");
			assertEquals(expected.getDirection(), actual.getDirection(), label + " hit face");
			assertEquals(expected.getLocation(), actual.getLocation(), label + " hit location");
		}
		static void checkCase(String name, BlockPos target, boolean expectRaw, boolean expectSample, boolean expectReach) throws Exception {
			SparseWorld world = new SparseWorld();
			world.states.put(new BlockPos(0,63,0), Blocks.STONE.defaultBlockState());
			world.states.put(target, Blocks.DIAMOND_ORE.defaultBlockState());
			FixtureLevel level = (FixtureLevel) unsafe.allocateInstance(FixtureLevel.class);
			level.world = world; level.loaded = true;
			FixturePlayer player = (FixturePlayer) unsafe.allocateInstance(FixturePlayer.class);
			player.setId(1029); // 26.3 assigns entity IDs in the constructor, which Unsafe allocation skips.
			player.fixtureLevel = level;
			set(player, "position", new Vec3(.5,64,.5)); set(player, "blockPosition", new BlockPos(0,64,0));
			set(player, "eyeHeight", 1.62F); set(player,"xo",.5D); set(player,"yo",64D); set(player,"zo",.5D);
			Vec3 delta = Vec3.atCenterOf(target).subtract(player.getEyePosition());
			float pitch = (float) Math.toDegrees(Math.atan2(-delta.y, Math.hypot(delta.x,delta.z)));
			float yaw = (float) Math.toDegrees(Math.atan2(-delta.x,delta.z));
			set(player, "xRot",pitch); set(player,"yRot",yaw); player.xRotO=pitch; player.yRotO=yaw; player.yHeadRot=yaw; player.yHeadRotO=yaw;
			Vec3 dir = Vec3.directionFromRotation(pitch,yaw);
			BlockHitResult fullHit = world.clip(new ClipContext(player.getEyePosition(),player.getEyePosition().add(dir.scale(256)),ClipContext.Block.VISUAL,ClipContext.Fluid.ANY,player));
			ok(fullHit.getType()==HitResult.Type.BLOCK && fullHit.getBlockPos().equals(target), name+" center ray hits target before support");
			ok(ObservationVisibility.canSeeBlock(level,player,target),name+" real view and line-of-sight admit target");
			RawSpatialObservation raw = (RawSpatialObservation)rawMethod.invoke(null,level,player,player.blockPosition());
			boolean rawPresent = raw.blocks().stream().anyMatch(c->player.blockPosition().offset(c.x(),c.y(),c.z()).equals(target));
			List<?> samples=(List<?>)sampleMethod.invoke(null,level,player,player.blockPosition());
			boolean samplePresent=contains(samples,target,player.blockPosition());
			ok(rawPresent==expectRaw,name+" local scan presence");
			ok(samplePresent==expectSample,name+" landmark presence");
			boolean inReach=player.isWithinBlockInteractionRange(target,0);
			ok(inReach==expectReach,name+" vanilla interaction AABB range");
			HitResult pick=player.pick(player.blockInteractionRange(),0.0F,false);
			boolean pickTarget=pick.getType()==HitResult.Type.BLOCK && ((BlockHitResult)pick).getBlockPos().equals(target);
			ok(pickTarget==expectReach,name+" vanilla interaction pick");
			var collector=(ServerObservationCollector)unsafe.allocateInstance(ServerObservationCollector.class);
			JsonObject query;
			Method emit=ServerObservationCollector.class.getDeclaredMethod("landmarks",ServerLevel.class,ServerPlayer.class,ObservationVisibility.Frame.class,List.class,int.class);
			emit.setAccessible(true);
			var entries=(com.google.gson.JsonArray)emit.invoke(null,level,player,ObservationVisibility.frame(level,player),samples,Integer.MAX_VALUE);
			boolean focusedPresent=entries.asList().stream().map(v->v.getAsJsonObject()).anyMatch(v->v.get("x").getAsInt()==target.getX() && v.get("y").getAsInt()==target.getY() && v.get("z").getAsInt()==target.getZ());
			ok(focusedPresent==expectSample,name+" production landmark emitter used by focused inspection");
			if (!expectReach) {
		query=new JsonObject();query.addProperty("section","block");query.addProperty("x",target.getX());query.addProperty("y",target.getY());query.addProperty("z",target.getZ());
		try { collector.collectInspection(player,query); throw new AssertionError(name+" focused block should reject range"); }
		catch(dev.agaminggod.arenaagents.agent.AgentDomainException e) {ok(e.code().equals("TARGET_OUT_OF_RANGE"),name+" focus block cannot recover");}
			}
			int before=level.clips; level.loaded=false;
			ok(((List<?>)sampleMethod.invoke(null,level,player,player.blockPosition())).isEmpty(),name+" unloaded control returns no samples");
			ok(level.clips==before,name+" unloaded control does not clip");
		}
		static boolean contains(List<?> samples,BlockPos target,BlockPos center)throws Exception {
			for(Object sample:samples){Class<?> type=sample.getClass(); Method x=type.getDeclaredMethod("x"),y=type.getDeclaredMethod("y"),z=type.getDeclaredMethod("z");x.setAccessible(true);y.setAccessible(true);z.setAccessible(true);if(center.offset((int)x.invoke(sample),(int)y.invoke(sample),(int)z.invoke(sample)).equals(target))return true;}return false;
		}
		static void set(Object target,String name,Object value)throws Exception {Field f=Entity.class.getDeclaredField(name);f.setAccessible(true);f.set(target,value);}
		static void ok(boolean value,String label){assertions++;if(!value)throw new AssertionError(label);}
		static final class FixturePlayer extends ServerPlayer {
			FixtureLevel fixtureLevel;
			FixturePlayer(){super(null,null,null,null);}
			@Override public ServerLevel level(){return fixtureLevel;}
			@Override public boolean isDescending(){return false;}
			@Override public ItemStack getMainHandItem(){return ItemStack.EMPTY;}
			@Override public double blockInteractionRange(){return 4.5;}
		}
		static final class FixtureLevel extends ServerLevel {
			// 26.3 entities take their ID from the level, and ServerLevel asks its (absent) chunk source.
			private int fixtureEntityIds = 100_000;
			@Override public int getNextEntityId() { return ++fixtureEntityIds; }
			SparseWorld world; boolean loaded; int clips;
			FixtureLevel(){super(null,null,null,null,null,null,false,0L,List.of(),false);}
			@Override public long getGameTime(){return 0L;}
			@Override public boolean hasChunk(int x,int z){return loaded;}
			@Override public int getMinY(){return -64;}
			@Override public int getHeight(){return 384;}
			@Override public boolean hasChunkAt(BlockPos p){return loaded;}
			@Override public BlockState getBlockState(BlockPos p){return world.getBlockState(p);}
			@Override public FluidState getFluidState(BlockPos p){return world.getFluidState(p);}
			@Override public BlockHitResult clip(ClipContext context){clips++; return world.clip(context);}
		}
		static final class SparseWorld implements BlockGetter {
			final Map<BlockPos,BlockState> states=new HashMap<>();
			@Override public BlockEntity getBlockEntity(BlockPos p){return null;}
			@Override public BlockState getBlockState(BlockPos p){return states.getOrDefault(p,Blocks.AIR.defaultBlockState());}
			@Override public FluidState getFluidState(BlockPos p){return getBlockState(p).getFluidState();}
			@Override public int getHeight(){return 384;}
			@Override public int getMinY(){return -64;}
		}
}







}
