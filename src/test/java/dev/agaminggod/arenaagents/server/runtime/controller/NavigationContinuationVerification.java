package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.agent.AgentId;
import dev.agaminggod.arenaagents.client.navigation.*;
import dev.agaminggod.arenaagents.server.perception.SeenTerrain;
import dev.agaminggod.arenaagents.server.runtime.input.*;
import java.lang.reflect.*;
import java.util.*;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.*;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.*;

/** Controller entry points and real acquired-terrain searches, with a stub body and input sink; no physics. */
public final class NavigationContinuationVerification {
	private static int assertions;
	private static sun.misc.Unsafe unsafe;
	private static final Vec3 HERE = new Vec3(0.5D, 64D, 0.5D);
	private static final Vec3 TARGET = new Vec3(3D, 64D, 0.5D);

	public static int verify() {
		assertions = 0;
		try {
			Field singleton = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
			singleton.setAccessible(true);
			unsafe = (sun.misc.Unsafe) singleton.get(null);
			verifyRetryAndGates();
			verifyWaitInterruptions();
			verifyUnsafeLegs();
			verifyFrontiers();
		} catch (ReflectiveOperationException exception) { throw new AssertionError(exception); }
		return assertions;
	}

	private static void verifyRetryAndGates() throws ReflectiveOperationException {
		FixturePlayer player = player();
		ServerNavigationController controller = controller(player, TARGET, 5_000L);
		MinecraftNavigationWorld world = nearWorld(null, null);
		check(retry(controller, player, world, 0L).state() == ServerController.State.RUNNING, "first empty search waits");
		check(replan(controller, player, world, 249L).state() == ServerController.State.RUNNING, "retry spacing retains the wait");
		check(retry(controller, player, world, 250L).state() == ServerController.State.RUNNING, "second empty search waits");
		var terminal = retry(controller, player, world, 500L);
		check(terminal.state() == ServerController.State.FAILED && terminal.reasonCode().equals("DESTINATION_NEAR_UNVERIFIED"), "near stop cannot claim arrival");
		check(terminal.message().contains("Stopped 2.5 blocks from target (requested tolerance 1.0)"), "near message names distance and requested tolerance");
		check(terminal.message().contains("stopped at 0.50,64.00,0.50"), "near failure retains stop facts");
		for (String gate : List.of("airborne", "water", "lava", "wall", "collision", "support", "unstable")) {
			player = player();
			controller = controller(player, TARGET, 5_000L);
			world = nearWorld(null, null);
			retry(controller, player, world, 0L);
			retry(controller, player, world, 250L);
			switch (gate) {
				case "airborne" -> {
					Field grounded = Entity.class.getDeclaredField("onGround"); grounded.setAccessible(true); grounded.setBoolean(player, false);
				}
				case "water" -> player.water = true;
				case "lava" -> player.lava = true;
				case "wall" -> player.wall = true;
				case "collision" -> player.fixtureLevel.collision = true;
				case "support" -> world = nearWorld(new BlockPos(0, 63, 0), Blocks.AIR.defaultBlockState());
				case "unstable" -> position(player, HERE.add(0.2D, 0D, 0D));
			}
			terminal = retry(controller, player, world, 500L);
			check(terminal.state() == ServerController.State.FAILED && !terminal.reasonCode().equals("DESTINATION_NEAR_UNVERIFIED"), "near stop requires safe and stable body: " + gate);
		}
		for (BlockState hazard : List.of(Blocks.AIR.defaultBlockState(), Blocks.LAVA.defaultBlockState(),
				Blocks.POWDER_SNOW.defaultBlockState(), Blocks.CACTUS.defaultBlockState())) {
			player = player();
			controller = controller(player, TARGET, 5_000L);
			world = nearWorld(new BlockPos(3, 63, 0), hazard);
			retry(controller, player, world, 0L);
			retry(controller, player, world, 250L);
			terminal = retry(controller, player, world, 500L);
			check(!terminal.reasonCode().equals("DESTINATION_NEAR_UNVERIFIED"), "unseen approach cannot hide unsafe target support: " + hazard);
		}
		player = player();
		controller = controller(player, new Vec3(12.5D, 64D, 0.5D), 5_000L);
		world = nearWorld(null, null);
		for (long time : new long[] {0L, 250L, 500L}) {
			var result = replan(controller, player, world, time);
			check(result != null && result.state() == (time < 500L ? ServerController.State.RUNNING : ServerController.State.FAILED), "actual search retries then fails without a route");
		}
	}

	private static void verifyUnsafeLegs() throws ReflectiveOperationException {
		for (int y : new int[] {63, 64, 65}) {
			FixturePlayer player = player();
			ServerNavigationController controller = controller(player, TARGET, 5_000L);
			MinecraftNavigationWorld world = nearWorld(null, null, new BlockPos(3, y, 0));
			retry(controller, player, world, 0L); retry(controller, player, world, 250L);
			check(!retry(controller, player, world, 500L).reasonCode().equals("DESTINATION_NEAR_UNVERIFIED"), "target support, feet and headroom must each be seen: " + y);
		}
		for (BlockState hazard : List.of(Blocks.LAVA.defaultBlockState(), Blocks.POWDER_SNOW.defaultBlockState(), Blocks.CACTUS.defaultBlockState())) {
			FixturePlayer player = player();
			ServerNavigationController controller = controller(player, new Vec3(12.5D, 64D, 0.5D), 5_000L);
			SeenNavigationVerification.World terrain = new SeenNavigationVerification.World();
			terrain.states.put(new BlockPos(3, 64, 0), hazard);
			MinecraftNavigationWorld world = SeenNavigationVerification.view(terrain, new SeenTerrain.Memory<>(), 1L);
			set(controller, "route", new RouteProgress(HERE.x, HERE.y, HERE.z, 12D, 0L));
			check(replan(controller, player, world, 0L) == null, "safe prefix still executes before hazardous boundary");
			PathPlan plan = (PathPlan) get(controller, "plan");
			check(plan.nodes().stream().noneMatch(node -> node.position().x() >= 3), "committed leg refuses hazardous boundary: " + hazard);
		}
		FixturePlayer rockPlayer = player();
		ServerNavigationController rockController = controller(rockPlayer, TARGET, 5_000L);
		MinecraftNavigationWorld rockWorld = nearWorld(new BlockPos(3, 64, 0), Blocks.STONE.defaultBlockState());
		retry(rockController, rockPlayer, rockWorld, 0L); retry(rockController, rockPlayer, rockWorld, 250L);
		check(!retry(rockController, rockPlayer, rockWorld, 500L).reasonCode().equals("DESTINATION_NEAR_UNVERIFIED"), "seen solid target cannot justify a near stop");
		FixturePlayer player = player();
		ServerNavigationController controller = controller(player, new Vec3(12.5D, 64D, 0.5D), 5_000L);
		SeenNavigationVerification.World terrain = new SeenNavigationVerification.World();
		terrain.states.put(new BlockPos(3, 63, 0), Blocks.AIR.defaultBlockState());
		SeenTerrain.Source<BlockState> sight = new SeenTerrain.Source<>() {
			public BlockState live(int x, int y, int z) { return terrain.live(x, y, z); }
			public boolean sees(int x, int y, int z) { return terrain.sees(x, y, z) && !(x == 3 && y == 63); }
		};
		MinecraftNavigationWorld world = new MinecraftNavigationWorld(terrain, new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), sight, 1L, null));
		set(controller, "route", new RouteProgress(HERE.x, HERE.y, HERE.z, 12D, 0L));
		check(replan(controller, player, world, 0L) == null, "safe prefix executes before unseen support");
		PathPlan plan = (PathPlan) get(controller, "plan");
		check(plan.nodes().stream().noneMatch(node -> node.position().x() >= 3), "committed leg refuses unseen drop support");
	}

	private static void verifyWaitInterruptions() throws ReflectiveOperationException {
		FixturePlayer player = player();
		ServerNavigationController controller = controller(player, TARGET, 100L);
		retry(controller, player, nearWorld(null, null), 0L);
		check(controller.tick(player, 100L).reasonCode().equals("ACTION_TIMEOUT"), "original deadline expires during observation wait");
		player = player();
		controller = controller(player, TARGET, 5_000L);
		retry(controller, player, nearWorld(null, null), 0L);
		player.health = 19F;
		check(controller.tick(player, 50L).reasonCode().equals("NAVIGATION_DAMAGED"), "health loss without any attacker bails during the wait");
		check(get(controller, "inputLease") == null, "damage releases stationary navigation input");
		player = player();
		controller = controller(player, TARGET, 5_000L);
		retry(controller, player, nearWorld(null, null), 0L);
		LeasedServerInputController inputs = (LeasedServerInputController) get(controller, "inputController");
		AgentId id = ((InputLease) get(controller, "inputLease")).agentId();
		check(inputs.currentState(id).isPresent(), "waiting holds navigation input before threat cancellation");
		// Threat attention is owned by the coordinator, which cancels the active controller.
		controller.cancel(player);
		check(inputs.currentState(id).isEmpty() && get(controller, "preparation") == null, "threat cancellation during wait releases input and planning");
	}

	@SuppressWarnings("unchecked")
	private static void verifyFrontiers() throws ReflectiveOperationException {
		FixturePlayer player = player();
		ServerNavigationController controller = controller(player, new Vec3(12.5D, 64D, 0.5D), 5_000L);
		Set<GridPosition> previous = (Set<GridPosition>) get(controller, "previousFrontiers");
		GridPosition a = new GridPosition(0, 64, 0), b = new GridPosition(1, 64, 0);
		previous.add(a); previous.add(b);
		SeenNavigationVerification.World terrain = new SeenNavigationVerification.World(); terrain.seenThrough = 1;
		MinecraftNavigationWorld world = SeenNavigationVerification.view(terrain, new SeenTerrain.Memory<>(), 1L);
		set(controller, "reachedUnknownFrontier", b);
		for (long time : new long[] {0L, 250L, 500L}) {
			position(player, time == 250L ? new Vec3(1.5D, 64D, 0.5D) : HERE);
			var result = replan(controller, player, world, time);
			check(result != null, "completed two-frontier corridor cannot produce a fresh walking leg");
			// Keep the body fixed for exhaustion below; displacement itself can grant another observation window.
		}
		position(player, HERE);
		var terminal = replan(controller, player, world, 750L);
		if (terminal.state() == ServerController.State.RUNNING) terminal = replan(controller, player, world, 1_000L);
		check(terminal.state() == ServerController.State.FAILED, "two-frontier oscillation exhausts without walking back and forth");
		controller.invalidatePlanning(a, false);
		check(previous.isEmpty(), "terrain invalidation clears stale frontier exclusions");
		// With unchanged exclusions a new observed branch may lead away from the target and is still accepted.
		controller = controller(player, new Vec3(12.5D, 64D, 0.5D), 5_000L);
		previous = (Set<GridPosition>) get(controller, "previousFrontiers");
		for (int x = 0; x <= 3; x++) previous.add(new GridPosition(x, 64, 0));
		position(player, new Vec3(3.5D, 64D, 0.5D));
		SeenTerrain.Source<BlockState> sight = new SeenTerrain.Source<>() {
			public BlockState live(int x, int y, int z) { return terrain.live(x, y, z); }
			public boolean sees(int x, int y, int z) { return x >= 0 && x <= 3 && z >= 0 && z <= 3 && y >= 63 && y <= 66; }
		};
		world = new MinecraftNavigationWorld(terrain, new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), sight, 1L, null));
		set(controller, "route", new RouteProgress(3.5D, 64D, 0.5D, 9D, 0L));
		check(replan(controller, player, world, 0L) == null, "non-improving new frontier accepts an observed detour");
		PathPlan plan = (PathPlan) get(controller, "plan");
		check(plan.nodes().getLast().position().z() > 0, "replacement guard excludes completed cells rather than requiring straight-line gain");
	}

	private static MinecraftNavigationWorld nearWorld(BlockPos changed, BlockState state) {
		return nearWorld(changed, state, null);
	}
	private static MinecraftNavigationWorld nearWorld(BlockPos changed, BlockState state, BlockPos hidden) {
		SeenNavigationVerification.World terrain = new SeenNavigationVerification.World();
		if (changed != null) terrain.states.put(changed, state);
		SeenTerrain.Source<BlockState> sight = new SeenTerrain.Source<>() {
			public BlockState live(int x, int y, int z) { return terrain.live(x, y, z); }
			public boolean sees(int x, int y, int z) { return (x == 0 || x == 3) && z == 0 && y >= 63 && y <= 66 && !new BlockPos(x, y, z).equals(hidden); }
		};
		return new MinecraftNavigationWorld(terrain, new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), sight, 1L, null));
	}
	private static FixturePlayer player() throws ReflectiveOperationException {
		FixturePlayer player = (FixturePlayer) unsafe.allocateInstance(FixturePlayer.class);
		player.setId(1015); // 26.3 assigns entity IDs in the constructor, which Unsafe allocation skips.
		player.fixtureLevel = (FixtureLevel) unsafe.allocateInstance(FixtureLevel.class);
		player.inventory = (Inventory) unsafe.allocateInstance(Inventory.class);
		player.health = 20F;
		Field level = Entity.class.getDeclaredField("level"); level.setAccessible(true); level.set(player, player.fixtureLevel);
		position(player, HERE);
		Field grounded = Entity.class.getDeclaredField("onGround"); grounded.setAccessible(true); grounded.setBoolean(player, true);
		return player;
	}
	private static void position(FixturePlayer player, Vec3 point) throws ReflectiveOperationException {
		Field position = Entity.class.getDeclaredField("position"); position.setAccessible(true); position.set(player, point);
		Field bb = Entity.class.getDeclaredField("bb"); bb.setAccessible(true); bb.set(player, new AABB(point.x - 0.3D, point.y, point.z - 0.3D, point.x + 0.3D, point.y + 1.8D, point.z + 0.3D));
	}
	private static ServerNavigationController controller(FixturePlayer player, Vec3 target, long timeout) throws ReflectiveOperationException {
		ServerNavigationController controller = new ServerNavigationController(target, 1D, false, 0L, timeout, true);
		LeasedServerInputController inputs = new LeasedServerInputController(new InputStateSink() {
			public void apply(AgentId id, AgentInputState previous, AgentInputState state) { }
			public void clear(AgentId id, AgentInputState previous) { }
		});
		set(controller, "inputController", inputs);
		set(controller, "inputLease", inputs.acquire(AgentId.random(), InputOwner.NAVIGATION, 100));
		return controller;
	}
	private static ServerController.TickResult retry(ServerNavigationController controller, FixturePlayer player, MinecraftNavigationWorld world, long time) throws ReflectiveOperationException {
		return invoke(controller, "retrySeenRoute", new Class<?>[] {ServerPlayer.class, MinecraftNavigationWorld.class, long.class, long.class, String.class}, player, world, time, time, "No seen continuation");
	}
	private static ServerController.TickResult replan(ServerNavigationController controller, FixturePlayer player, MinecraftNavigationWorld world, long time) throws ReflectiveOperationException {
		try (ServerPathPlanner.TickScope ignored = ServerPathPlanner.beginServerTick(8192, Long.MAX_VALUE, () -> 0L)) {
			return invoke(controller, "replan", new Class<?>[] {ServerPlayer.class, MinecraftNavigationWorld.class, long.class, long.class, boolean.class}, player, world, time, time, false);
		}
	}
	private static ServerController.TickResult invoke(Object target, String name, Class<?>[] types, Object... args) throws ReflectiveOperationException {
		Method method = target.getClass().getDeclaredMethod(name, types); method.setAccessible(true);
		try { return (ServerController.TickResult) method.invoke(target, args); }
		catch (InvocationTargetException exception) { throw new AssertionError(name, exception.getCause()); }
	}
	private static Object get(Object target, String name) throws ReflectiveOperationException { Field field = target.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(target); }
	private static void set(Object target, String name, Object value) throws ReflectiveOperationException { Field field = target.getClass().getDeclaredField(name); field.setAccessible(true); field.set(target, value); }
	private static void check(boolean condition, String message) { assertions++; if (!condition) throw new AssertionError(message); }

	private static final class FixturePlayer extends ServerPlayer {
		FixtureLevel fixtureLevel; Inventory inventory; float health; boolean water, lava, wall;
		FixturePlayer() { super(null, null, null, null); }
		@Override public ServerLevel level() { return fixtureLevel; }
		@Override public Inventory getInventory() { return inventory; }
		@Override public float getHealth() { return health; }
		@Override public boolean isAlive() { return true; }
		@Override public int getAirSupply() { return 300; }
		@Override public boolean isFallFlying() { return false; }
		@Override public boolean isInWater() { return water; }
		@Override public boolean isUnderWater() { return false; }
		@Override public boolean isInLava() { return lava; }
		@Override public boolean isInWall() { return wall; }
	}
	private static final class FixtureLevel extends ServerLevel {
		// 26.3 entities take their ID from the level, and ServerLevel asks its (absent) chunk source.
		private int fixtureEntityIds = 100_000;
		@Override public int getNextEntityId() { return ++fixtureEntityIds; }
		boolean collision;
		FixtureLevel() { super(null, null, null, null, null, null, false, 0L, List.of(), false); }
		@Override public ResourceKey<Level> dimension() { return Level.OVERWORLD; }
		@Override public boolean noCollision(AABB box) { return !collision; }
	}
}
