package dev.agaminggod.arenaagents.server.runtime;

import com.google.gson.JsonObject;
import dev.agaminggod.arenaagents.agent.AgentId;
import dev.agaminggod.arenaagents.protocol.ActionType;
import dev.agaminggod.arenaagents.server.CodexAgentManager;
import dev.agaminggod.arenaagents.server.runtime.controller.ThrowPreview;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputRuntime;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputState;
import dev.agaminggod.arenaagents.server.runtime.input.ControlSequence;
import dev.agaminggod.arenaagents.server.runtime.input.InputStateSink;
import dev.agaminggod.arenaagents.server.runtime.input.LeasedServerInputController;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.level.ServerPlayerGameMode;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityEquipment;
import net.minecraft.world.entity.player.Abilities;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

/** Executor ticks with a recording input sink; no live server or vanilla physics is simulated here. */
final class EndActionVerification {
	private static final Class<?> ACTION;
	private static int assertions;
	static {
		try { ACTION = Class.forName(ServerActionExecutor.class.getName() + "$ActiveAction"); }
		catch (ClassNotFoundException failure) { throw new ExceptionInInitializerError(failure); }
	}
	public static void main(String[] args) {
		net.minecraft.SharedConstants.tryDetectVersion(); net.minecraft.server.Bootstrap.bootStrap();
		System.out.println("End checks: " + (verify() + dev.agaminggod.arenaagents.server.perception.CloudDangerVerification.verify()));
	}
	static int verify() {
		assertions = 0;
		try {
			var singleton = sun.misc.Unsafe.class.getDeclaredField("theUnsafe"); singleton.setAccessible(true);
			var unsafe = (sun.misc.Unsafe) singleton.get(null);
			var player = (Body) unsafe.allocateInstance(Body.class);
			player.setId(1007); // 26.3 assigns entity IDs in the constructor, which Unsafe allocation skips.
			var level = (World) unsafe.allocateInstance(World.class);
			var server = (net.minecraft.server.dedicated.DedicatedServer) unsafe.allocateInstance(net.minecraft.server.dedicated.DedicatedServer.class);
			player.world = level; level.server = server;
			player.inventory = new Inventory(null, new EntityEquipment());
			player.abilities = new Abilities(); player.health = 20;
			set(player, Entity.class, "position", new Vec3(.5, 64, .5));
			set(player, Entity.class, "blockPosition", new BlockPos(0,64,0));
			set(player, Entity.class, "bb", new AABB(.2,64,.2,.8,65.8,.8));
			set(player, Entity.class, "deltaMovement", new Vec3(.1,0,0));
			set(player, Entity.class, "eyeHeight", 1.62F);
			set(player, ServerPlayer.class, "gameMode", unsafe.allocateInstance(GameMode.class));
			set(level, net.minecraft.world.level.Level.class, "dimension", net.minecraft.world.level.Level.END);
			var manager = (CodexAgentManager) unsafe.allocateInstance(CodexAgentManager.class);
			Map<MinecraftServer, CodexAgentManager> managers = map(CodexAgentManager.class, "INSTANCES");
			Map<MinecraftServer, LeasedServerInputController> controllers = map(AgentInputRuntime.class, "CONTROLLERS");
			List<AgentInputState> inputs = new ArrayList<>();
			var input = new LeasedServerInputController(new InputStateSink() {
				@Override public void apply(AgentId id, AgentInputState previous, AgentInputState state) { inputs.add(state); }
				@Override public void clear(AgentId id, AgentInputState previous) { }
			});
			managers.put(server, manager); controllers.put(server, input);
			try {
				var request = new ServerActionRequest(AgentId.random(), 1, "end-check", ActionType.CONTROL_SEQUENCE,
						new JsonObject(), new ActionProvenance("codex", "gpt-6.1-sol", "high", "priority", "end", 1, "step", 1, "trace"), "trace");
				var crouch = new AgentInputState(1,0,false,true,false,true,true,0,0,0,InteractionHand.MAIN_HAND);
				var sequence = new ControlSequence(List.of(new ControlSequence.Frame(crouch,1,List.of())), 10);
				Object action = factory("controlSequence", request, player, sequence);
				check(tick(action) == null && inputs.getLast().forward() == 1, "sequence applies the authored frame");
				check(tick(action) == null, "normal sequence completion settles residual crouched movement");
				var held = inputs.getLast();
				check(held.sneak() && held.forward() == 0 && !held.attack() && !held.use(), "settling retains only sneak and releases movement and clicks");
				set(player, Entity.class, "deltaMovement", Vec3.ZERO);
				check(tick(action).reasonCode().equals("CONTROL_SEQUENCE_COMPLETED"), "settled sequence returns its terminal receipt");
				cleanup(action);
				set(player, Entity.class, "deltaMovement", new Vec3(.1,0,0));
				for (String condition : List.of("hurt", "on_fire", "health_below")) {
					player.health = 20; player.fire = false; player.hurtTime = 0;
					sequence = new ControlSequence(List.of(new ControlSequence.Frame(crouch,10,
							List.of(new ControlSequence.Branch(condition, condition.equals("health_below") ? 10 : 1, 1)))), 20);
					action = factory("controlSequence", request, player, sequence);
					check(tick(action) == null, "danger guard starts with the authored crouch");
					int before = inputs.size();
					if (condition.equals("hurt")) player.hurtTime = 10;
					if (condition.equals("on_fire")) player.fire = true;
					if (condition.equals("health_below")) player.health = 9;
					check(tick(action).reasonCode().equals("CONTROL_SEQUENCE_STOPPED") && inputs.size() == before,
							condition + " branch stop returns immediately without a settling input");
					cleanup(action);
				}
				player.health = 20; player.fire = false; player.hurtTime = 0;
				for (String skip : List.of("water", "ladder", "hurt", "fire", "no_sneak")) {
					player.water = skip.equals("water"); player.ladder = skip.equals("ladder");
					player.hurtTime = skip.equals("hurt") ? 10 : 0; player.fire = skip.equals("fire");
					var frame = new AgentInputState(1,0,false,!skip.equals("no_sneak"),false,false,false,0,0,0,InteractionHand.MAIN_HAND);
					action = factory("control", request, player, frame, 1, true);
					check(tick(action) == null && tick(action) != null, skip + " control completion adds no settling delay");
					cleanup(action);
				}
				player.water = false; player.ladder = false; player.fire = false; player.hurtTime = 0;
				action = factory("control", request, player, crouch, 1, true);
				check(tick(action) == null && tick(action) == null, "ordinary control enters crouch settling");
				player.hurtTime = 10;
				check(tick(action) != null, "damage during settling returns control on that tick");
				cleanup(action); player.hurtTime = 0;
				var holder = Items.ENDER_PEARL.builtInRegistryHolder();
				var original = holder.areComponentsBound() ? holder.components() : null;
				var components = net.minecraft.core.component.DataComponentMap.builder();
				if (original != null) components.addAll(original);
				components.set(net.minecraft.core.component.DataComponents.MAX_STACK_SIZE, 16);
				components.set(net.minecraft.core.component.DataComponents.ITEM_NAME, net.minecraft.network.chat.Component.literal("Pearl"));
				holder.bindComponents(components.build());
				try {
					player.held = new ItemStack(Items.ENDER_PEARL, 4);
					action = factory("use", request, player, 50L, InteractionHand.MAIN_HAND, null, true);
					set(action, ACTION, "inspectThrow", true);
					set(action, ACTION, "useAim", (java.util.function.Supplier<Vec3>) () -> new Vec3(.5,64,8));
					int before = inputs.size();
					var receipt = tick(action);
					check(receipt.message().startsWith("throwPreview={"), "predicted landing facts lead the throw receipt");
					check(receipt.reasonCode().equals("THROW_PREVIEW") && !receipt.physicalAttempted(), "inspect succeeds through the executor without physical use");
					check(inputs.size() == before && player.held.getCount() == 4 && input.acceptedUses(request.agentId()) == 0,
							"inspect emits no input, accepts no use and consumes no pearl");
					cleanup(action);
					set(player, Entity.class, "onGround", true); level.loaded = true; level.tick++;
					set(player, Entity.class, "deltaMovement", new Vec3(0,.8,0));
					var aim = new Vec3(.5,64,8);
					var ground = ThrowPreview.sample(player, player.held, aim);
					set(player, Entity.class, "onGround", false);
					var airborne = ThrowPreview.sample(player, player.held, aim);
					check(ground.get("status").getAsString().equals("observed_impact") && airborne.get("ticks").getAsInt() > ground.get("ticks").getAsInt(),
							"sample uses requested aim and inherits vertical motion only while airborne: " + ground + " / " + airborne);
					var opposite = ThrowPreview.sample(player, player.held, new Vec3(.5,64,-8));
					check(opposite.get("status").getAsString().equals("unknown_terrain"), "aim behind the body stays unknown rather than borrowing forward terrain");
					check(!ground.has("mobsNearLanding"), "an empty landing names no mobs");
				} finally {
					var field = net.minecraft.core.Holder.Reference.class.getDeclaredField("components"); field.setAccessible(true); field.set(holder, original);
				}
			} finally {
				controllers.remove(server); managers.remove(server);
				dev.agaminggod.arenaagents.server.perception.SeenTerrain.forget(player);
			}
			return assertions;
		} catch (ReflectiveOperationException failure) { throw new AssertionError("executor End regression fixture failed", failure); }
	}
	private static Object factory(String name, Object... args) throws ReflectiveOperationException {
		var method = Arrays.stream(ACTION.getDeclaredMethods()).filter(m -> m.getName().equals(name)).findFirst().orElseThrow();
		method.setAccessible(true); return method.invoke(null,args);
	}
	private static ServerActionResult tick(Object action) throws ReflectiveOperationException {
		var method = ACTION.getDeclaredMethod("tick", long.class); method.setAccessible(true);
		return (ServerActionResult) method.invoke(action, System.currentTimeMillis());
	}
	private static void cleanup(Object action) throws ReflectiveOperationException {
		var method = ACTION.getDeclaredMethod("cleanup"); method.setAccessible(true); method.invoke(action);
	}
	private static void set(Object object, Class<?> type, String name, Object value) throws ReflectiveOperationException {
		Field field = type.getDeclaredField(name); field.setAccessible(true); field.set(object,value);
	}
	@SuppressWarnings("unchecked") private static <T> Map<MinecraftServer,T> map(Class<?> type, String name) throws ReflectiveOperationException {
		Field field = type.getDeclaredField(name); field.setAccessible(true); return (Map<MinecraftServer,T>) field.get(null);
	}
	private static void check(boolean value, String reason) { assertions++; if (!value) throw new AssertionError(reason); }
	private static final class GameMode extends ServerPlayerGameMode implements ServerActionExecutor.BlockBreakReceiptAccess {
		GameMode() { super(null); }
		@Override public ServerActionExecutor.BlockBreakReceipt arenaagents$getBlockBreakReceipt() { return null; }
	}
	private static final class Body extends ServerPlayer {
		World world; Inventory inventory; Abilities abilities; ItemStack held; float health; boolean water, ladder, fire;
		Body() { super(null,null,null,null); }
		@Override public ServerLevel level() { return world; }
		@Override public Inventory getInventory() { return inventory; }
		@Override public Abilities getAbilities() { return abilities; }
		@Override public boolean isAlive() { return true; }
		@Override public boolean fireImmune() { return false; }
		@Override public boolean isOnFire() { return fire; }
		@Override public boolean isInLava() { return false; }
		@Override public boolean isInWater() { return water; }
		@Override public boolean onClimbable() { return ladder; }
		@Override public boolean isUsingItem() { return false; }
		@Override public boolean isDescending() { return false; }
		@Override public boolean hasEffect(net.minecraft.core.Holder<net.minecraft.world.effect.MobEffect> effect) { return false; }
		@Override public float getHealth() { return health; }
		@Override public int getAirSupply() { return 300; }
		@Override public net.minecraft.world.food.FoodData getFoodData() { return new net.minecraft.world.food.FoodData(); }
		@Override public ItemStack getItemInHand(InteractionHand hand) { return getMainHandItem(); }
		@Override public ItemStack getMainHandItem() { return held == null ? ItemStack.EMPTY : held; }
		@Override public Vec3 getKnownMovement() { return getDeltaMovement(); }
	}
	private static final class World extends ServerLevel {
		// 26.3 entities take their ID from the level, and ServerLevel asks its (absent) chunk source.
		private int fixtureEntityIds = 100_000;
		@Override public int getNextEntityId() { return ++fixtureEntityIds; }
		MinecraftServer server; boolean loaded; long tick;
		World() { super(null,null,null,null,null,null,false,0,List.of(),false); }
		@Override public MinecraftServer getServer() { return server; }
		@Override public long getGameTime() { return tick; }
		@Override public int getMinY() { return -64; }
		@Override public int getHeight() { return 384; }
		@Override public boolean hasChunk(int x, int z) { return loaded; }
		@Override public boolean hasChunkAt(BlockPos at) { return loaded; }
		@Override public net.minecraft.world.level.material.FluidState getFluidState(BlockPos at) { return getBlockState(at).getFluidState(); }
		@Override public BlockState getBlockState(BlockPos at) { return at.getY() == 63 ? Blocks.STONE.defaultBlockState() : Blocks.AIR.defaultBlockState(); }
		@Override public BlockHitResult clip(ClipContext context) { return BlockHitResult.miss(context.getTo(),net.minecraft.core.Direction.UP,BlockPos.containing(context.getTo())); }
		@Override public <T extends Entity> List<T> getEntitiesOfClass(Class<T> type, net.minecraft.world.phys.AABB box, java.util.function.Predicate<? super T> filter) { return List.of(); }
	}
}
