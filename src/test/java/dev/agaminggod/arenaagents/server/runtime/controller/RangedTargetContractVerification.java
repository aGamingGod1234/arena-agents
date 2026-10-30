package dev.agaminggod.arenaagents.server.runtime.controller;

import carpet.fakes.ServerPlayerInterface;
import carpet.helpers.EntityPlayerActionPack;
import java.io.IOException;
import java.lang.invoke.MethodHandles;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.ServerGamePacketListenerImpl;
import net.minecraft.network.protocol.Packet;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;
import dev.agaminggod.arenaagents.agent.AgentDomainException;
import dev.agaminggod.arenaagents.server.runtime.ElapsedTimeAccumulator;
import dev.agaminggod.arenaagents.server.runtime.ObservedEntityTarget;
import dev.agaminggod.arenaagents.server.runtime.TargetSightline;
import dev.agaminggod.arenaagents.server.runtime.transaction.ServerTransactionAdapter;
import java.lang.reflect.Field;
import java.util.Collection;
import java.util.List;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.effect.MobEffect;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityEquipment;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.EntityTypes;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.boss.enderdragon.EnderDragon;
import net.minecraft.world.entity.boss.enderdragon.EnderDragonPart;
import net.minecraft.world.entity.player.Abilities;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/** Runs tracked bow aiming and separately indexed multipart lookup against actual sight and Carpet rotation code. */
public final class RangedTargetContractVerification {
	private static int assertions;
	private RangedTargetContractVerification() { }

	public static int verify() {
		assertions = 0;
		try {
			Field field = sun.misc.Unsafe.class.getDeclaredField("theUnsafe"); field.setAccessible(true);
			var unsafe = (sun.misc.Unsafe) field.get(null);
			var level = (FixtureLevel) unsafe.allocateInstance(FixtureLevel.class);
			level.parts = List.of();
			Class<?> fakeType = managedFakeType();
			var player = (ServerPlayer) unsafe.allocateInstance(fakeType);
			player.setId(1999);
			set(player, fakeType, "world", level);
			set(player, fakeType, "abilities", new Abilities());
			set(player, fakeType, "using", true);
			set(player, ServerPlayer.class, "connection", unsafe.allocateInstance(FixtureConnection.class));
			EntityEquipment equipment = new EntityEquipment();
			set(player, Player.class, "inventory", new Inventory(player, equipment));
			set(player, LivingEntity.class, "equipment", equipment);
			set(player, Entity.class, "uuid", UUID.randomUUID());
			set(player, Entity.class, "type", EntityTypes.PLAYER);
			set(player, Entity.class, "eyeHeight", 1.62F);
			position(player, new Vec3(.5D, 64D, .5D), new AABB(.2D, 64D, .2D, .8D, 65.8D, .8D), level);
			set(player, fakeType, "pack", new EntityPlayerActionPack(player) { @Override public void setSlot(int slot) { } });
			var dragon = (FixtureDragon) unsafe.allocateInstance(FixtureDragon.class);
			dragon.setId(1017); // 26.3 assigns entity IDs in the constructor, which Unsafe allocation skips.
			dragon.alive = true;
			set(dragon, Entity.class, "uuid", UUID.randomUUID());
			set(dragon, Entity.class, "type", EntityTypes.ENDER_DRAGON);
			position(dragon, new Vec3(.5D, 64D, 8.5D), new AABB(.2D, 64D, 8.2D, .8D, 65.8D, 8.8D), level);
			verifyCurrentBodyAim(unsafe, player, dragon);
			verifyInterruptedAndBlockedDraw(unsafe, player, dragon, level, fakeType);
			verifyMultipartLookup(unsafe, player, dragon, level);
			verifyArrowPassReport();
			return assertions;
		} catch (ReflectiveOperationException | IOException failure) { throw new AssertionError("ranged target fixture failed", failure); }
	}

	private static void verifyCurrentBodyAim(sun.misc.Unsafe unsafe, ServerPlayer player, FixtureDragon target)
			throws ReflectiveOperationException {
		// A drawn bow at full power holds above the visible body by the arrow's drop over the range, with no lead.
		var body = ServerLookController.anglesTo(player.getEyePosition(),
				BowBallistics.aimPoint(player.getEyePosition(), TargetSightline.rangedEntity(player, target), BowBallistics.speed(20)));
		for (Vec3 velocity : new Vec3[]{Vec3.ZERO, new Vec3(20D, 8D, -11D), new Vec3(-20D, -8D, 11D)}) {
			set(target, Entity.class, "deltaMovement", velocity);
			player.setYRot(0F); player.setXRot(0F);
			var controller = aimingController(unsafe, player, target, true, false, Vec3.ZERO);
			var tick = aimTicks(controller);
			check(tick.state() == ServerTransactionAdapter.TickState.RUNNING,
					"real tracked bow tick remains in its bounded pending draw phase");
			check(player.getYRot() == body.yaw() && player.getXRot() == body.pitch(),
					"real tracked bow tick aims above the current visible body for drop; velocity fields alone add no lead (lead follows seen displacement)");
		}
		Vec3 authored = new Vec3(1.5D, 66D, 8.5D);
		var exact = ServerLookController.anglesTo(player.getEyePosition(), authored);
		player.setYRot(0F); player.setXRot(0F);
		var controller = aimingController(unsafe, player, target, false, true, authored);
		check(aimTicks(controller).state() == ServerTransactionAdapter.TickState.RUNNING,
				"real fixed-aim bow tick remains in its bounded pending draw phase");
		check(player.getYRot() == exact.yaw() && player.getXRot() == exact.pitch(),
				"untracked explicit coordinates remain the exact authored aiming point");
	}

	private static ServerTransactionAdapter.TickResult aimTicks(ServerRangedUseController controller) {
		ServerTransactionAdapter.TickResult result = null;
		for (int tick = 0; tick < 8; tick++) {
			result = controller.tick(1000L + tick * 50L);
			if (result.state() != ServerTransactionAdapter.TickState.RUNNING) return result;
		}
		return result;
	}

	private static ServerRangedUseController aimingController(sun.misc.Unsafe unsafe, ServerPlayer player, Entity target,
			boolean track, boolean explicit, Vec3 aim) throws ReflectiveOperationException {
		var controller = (ServerRangedUseController) unsafe.allocateInstance(ServerRangedUseController.class);
		set(controller, ServerRangedUseController.class, "player", player);
		set(controller, ServerRangedUseController.class, "target", target);
		set(controller, ServerRangedUseController.class, "hand", InteractionHand.MAIN_HAND);
		set(controller, ServerRangedUseController.class, "bow", ItemStack.EMPTY);
		set(controller, ServerRangedUseController.class, "elapsedTime", new ElapsedTimeAccumulator(1000L));
		set(controller, ServerRangedUseController.class, "drawDurationMs", 1000L);
		set(controller, ServerRangedUseController.class, "drawTicks", 20);
		set(controller, ServerRangedUseController.class, "timeoutMs", 10000L);
		set(controller, ServerRangedUseController.class, "aimPoint", aim);
		set(controller, ServerRangedUseController.class, "trackTarget", track);
		set(controller, ServerRangedUseController.class, "explicitAim", explicit);
		set(controller, ServerRangedUseController.class, "terminal", new ServerTransactionAdapter.TerminalGate());
		set(controller, ServerRangedUseController.class, "useTimer", new ServerTransactionAdapter.ConfirmedUseTimer());
		// The already-started use phase isolates aiming; the unconfirmed timer cannot release or invent a projectile.
		set(controller, ServerRangedUseController.class, "started", true);
		return controller;
	}

	private static void verifyInterruptedAndBlockedDraw(sun.misc.Unsafe unsafe, ServerPlayer player, Entity target,
			FixtureLevel level, Class<?> fakeType) throws ReflectiveOperationException {
		var interrupted = aimingController(unsafe, player, target, true, false, Vec3.ZERO);
		set(player, fakeType, "using", false);
		var stopped = interrupted.tick(1000L);
		check(stopped.reasonCode().equals("RANGED_DRAW_INTERRUPTED"), "an ended vanilla draw returns on its first tick instead of waiting for the ranged timeout");
		check(interrupted.tick(1050L) == stopped, "with no bow left in hand the interrupted draw remains terminal and cannot restart itself");
		set(player, fakeType, "using", true);
		var obstructed = aimingController(unsafe, player, target, true, false, Vec3.ZERO);
		check(obstructed.tick(1000L).state() == ServerTransactionAdapter.TickState.RUNNING, "the draw begins with a clear target");
		level.obstructed = true;
		check(obstructed.tick(1050L).state() == ServerTransactionAdapter.TickState.RUNNING,
				"an obstruction appearing during the draw holds the drawn bow instead of ending the shot");
		var blocked = obstructed.tick(11050L);
		check(blocked.reasonCode().equals("TARGET_OBSTRUCTED") && blocked.message().contains("minecraft:stone")
				&& blocked.message().contains("held the draw"), "a shot still blocked at its timeout names the block and the held draw: " + blocked.message());
		check(blocked.message().contains("nearest first: none"), "blocked draw reports the empty visible arrow-line choices");
		check(obstructed.tick(11100L) == blocked, "the blocked draw cannot retry or retarget on its own");
		var cleared = aimingController(unsafe, player, target, true, false, Vec3.ZERO);
		check(cleared.tick(1000L).state() == ServerTransactionAdapter.TickState.RUNNING, "a second draw begins clear");
		check(cleared.tick(1050L).state() == ServerTransactionAdapter.TickState.RUNNING, "it holds while blocked");
		level.obstructed = false;
		check(cleared.tick(1100L).state() == ServerTransactionAdapter.TickState.RUNNING, "and draws on once the arc is clear again");
		level.obstructed = true;
		level.obstructed = false;
	}

	private static void verifyMultipartLookup(sun.misc.Unsafe unsafe, ServerPlayer player, FixtureDragon parent, FixtureLevel level)
			throws ReflectiveOperationException {
		var head = (FixturePart) unsafe.allocateInstance(FixturePart.class);
		head.setId(1018); // 26.3 assigns entity IDs in the constructor, which Unsafe allocation skips.
		set(head, EnderDragonPart.class, "parentMob", parent);
		set(head, Entity.class, "uuid", UUID.randomUUID());
		position(head, parent.position(), parent.getBoundingBox(), level);
		level.parts = List.of(head);
		check(ObservedEntityTarget.resolve(player, head.getUUID().toString()) == head,
				"actual resolver finds the exact visible part UUID outside the ordinary entity index");
		refuses(player, UUID.randomUUID(), "TARGET_UNAVAILABLE", "a different part UUID never selects an available part");
		parent.alive = false;
		refuses(player, head.getUUID(), "TARGET_UNAVAILABLE", "a part with a dead parent cannot remain an observed target");
		parent.alive = true;
		level.obstructed = true;
		refuses(player, head.getUUID(), "TARGET_NOT_VISIBLE", "a separately indexed part still requires actual current visibility");
		level.obstructed = false;
		level.indexed = parent;
		check(ObservedEntityTarget.resolve(player, parent.getUUID().toString()) == parent,
				"ordinary indexed entities retain their exact UUID path beside the multipart fallback");
	}

	private static void refuses(ServerPlayer player, UUID target, String reason, String label) {
		try { ObservedEntityTarget.resolve(player, target.toString()); throw new AssertionError(label); }
		catch (AgentDomainException failure) { check(failure.code().equals(reason), label); }
	}
	private static void position(Entity entity, Vec3 position, AABB box, FixtureLevel level) throws ReflectiveOperationException {
		set(entity, Entity.class, "position", position);
		set(entity, Entity.class, "blockPosition", BlockPos.containing(position));
		set(entity, Entity.class, "bb", box);
		set(entity, Entity.class, "level", level);
		set(entity, Entity.class, "deltaMovement", Vec3.ZERO);
	}
	private static void set(Object target, Class<?> owner, String name, Object value) throws ReflectiveOperationException {
		Field field = owner.getDeclaredField(name); field.setAccessible(true); field.set(target, value);
	}
	/** The bow's arrow report states the miss as the shooter sees it: above/below and left/right of the line of sight. */
	private static void verifyArrowPassReport() {
		Vec3 eye = new Vec3(0D, 65.6D, 0D), center = new Vec3(0D, 70D, 20D);
		// Looking south (+z), Minecraft's right is west (-x).
		String low = ServerRangedUseController.describePass(eye, new Vec3(-1D, 68D, 20D), center, 1.5D);
		check(low.contains("2.0 below") && low.contains("1.0 right"), "a low pass to the west reads below and right when facing south: " + low);
		String high = ServerRangedUseController.describePass(eye, new Vec3(.5D, 71D, 20D), center, .4D);
		check(high.contains("1.0 above") && high.contains("0.5 left") && high.contains("closest pass 0.4"), "a high pass to the east reads above and left: " + high);
		check(ServerRangedUseController.describePass(eye, center, center, 0D).contains("reached the target's body"), "touching the body without a hurt flash is reported as reached, not as a hit");
		check(ServerRangedUseController.ArrowWatch.MAX_WATCH_TICKS == 60, "the arrow is watched for at most 3 s");
	}

	private static void check(boolean condition, String label) { if (!condition) throw new AssertionError(label); assertions++; }

	private static Class<?> managedFakeType() throws IOException, IllegalAccessException {
		// The real Carpet fake has a private constructor. A constructor-free test subclass retains its identity gate.
		try (var input = RangedTargetContractVerification.class.getResourceAsStream("RangedTargetContractVerification$FixturePlayer.class")) {
			if (input == null) throw new AssertionError("managed fake template is missing");
			var writer = new ClassWriter(0);
			new ClassReader(input).accept(new ClassVisitor(Opcodes.ASM9, writer) {
				@Override public void visit(int version, int access, String name, String signature, String parent, String[] interfaces) {
					super.visit(version, access, name, signature, "carpet/patches/EntityPlayerMPFake", interfaces);
				}
				@Override public MethodVisitor visitMethod(int access, String name, String descriptor, String signature, String[] exceptions) {
					return name.equals("<init>") ? null : super.visitMethod(access, name, descriptor, signature, exceptions);
				}
			}, 0);
			return MethodHandles.lookup().defineHiddenClass(writer.toByteArray(), true, MethodHandles.Lookup.ClassOption.NESTMATE).lookupClass();
		}
	}

	private static final class FixturePlayer extends ServerPlayer implements ServerPlayerInterface {
		EntityPlayerActionPack pack;
		FixtureLevel world;
		Abilities abilities;
		boolean using;
		private FixturePlayer() { super(null, null, null, null); }
		@Override public ServerLevel level() { return world; }
		@Override public EntityPlayerActionPack getActionPack() { return pack; }
		@Override public void invalidateEntityObjectReference() { }
		@Override public boolean isInvalidEntityObject() { return false; }
		@Override public void setShiftKeyDown(boolean value) { }
		@Override public void setSprinting(boolean value) { }
		@Override public boolean isShiftKeyDown() { return false; }
		@Override public boolean isInWater() { return false; }
		@Override public boolean isUnderWater() { return false; }
		@Override public boolean isInLava() { return false; }
		@Override public boolean isSpectator() { return false; }
		@Override public boolean hasEffect(Holder<MobEffect> effect) { return false; }
		@Override public boolean isUsingItem() { return using; }
		// No bow tick has been drawn in these isolated aiming phases, so none of them may release.
		@Override public int getTicksUsingItem() { return 0; }
		@Override public InteractionHand getUsedItemHand() { return InteractionHand.MAIN_HAND; }
		@Override public ItemStack getUseItem() { return ItemStack.EMPTY; }
		@Override public ItemStack getMainHandItem() { return ItemStack.EMPTY; }
		@Override public Abilities getAbilities() { return abilities; }
	}
	private static final class FixtureConnection extends ServerGamePacketListenerImpl {
		private FixtureConnection() { super(null, null, null, null); }
		@Override public void send(Packet<?> packet) { } // Rotation uses the actual player implementation; only packet transport is fake.
	}
	private static final class FixtureDragon extends EnderDragon {
		boolean alive;
		private FixtureDragon() { super(EntityTypes.ENDER_DRAGON, null); }
		@Override public boolean isAlive() { return alive; }
		@Override public boolean isInvisibleTo(Player observer) { return false; }
	}
	private static final class FixturePart extends EnderDragonPart {
		private FixturePart() { super(null, "head", 1F, 1F); }
		@Override public boolean isAlive() { return true; }
		@Override public boolean isInvisibleTo(Player observer) { return false; }
	}
	private static final class FixtureLevel extends ServerLevel {
		// 26.3 entities take their ID from the level, and ServerLevel asks its (absent) chunk source.
		private int fixtureEntityIds = 100_000;
		@Override public int getNextEntityId() { return ++fixtureEntityIds; }
		Collection<EnderDragonPart> parts;
		Entity indexed;
		boolean obstructed;
		private FixtureLevel() { super(null, null, null, null, null, null, false, 0, List.of(), false); }
		@Override public boolean hasChunkAt(BlockPos position) { return true; }
		@Override public int getHeight() { return 384; }
		@Override public int getMinY() { return -64; }
		@Override public int getMaxY() { return 320; }
		@Override public BlockState getBlockState(BlockPos position) {
			return obstructed && position.getZ() == 4 ? Blocks.STONE.defaultBlockState() : Blocks.AIR.defaultBlockState();
		}
		@Override public FluidState getFluidState(BlockPos position) { return getBlockState(position).getFluidState(); }
		@Override public Entity getEntity(UUID identity) { return indexed != null && indexed.getUUID().equals(identity) ? indexed : null; }
		@Override public Collection<EnderDragonPart> dragonParts() { return parts; }
		@Override public List<Entity> getEntities(Entity except, AABB bounds, java.util.function.Predicate<? super Entity> filter) { return List.of(); }
		@Override public <T extends Entity> List<T> getEntities(net.minecraft.world.level.entity.EntityTypeTest<Entity, T> type, net.minecraft.world.phys.AABB box, java.util.function.Predicate<? super T> filter) { return List.of(); }
	}
}
