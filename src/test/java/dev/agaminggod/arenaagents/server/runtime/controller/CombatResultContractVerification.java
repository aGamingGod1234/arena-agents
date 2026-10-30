package dev.agaminggod.arenaagents.server.runtime.controller;

import com.mojang.authlib.GameProfile;
import com.mojang.serialization.Lifecycle;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.core.MappedRegistry;
import net.minecraft.core.Registry;
import net.minecraft.core.RegistryAccess;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ClientInformation;
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
import net.minecraft.world.item.enchantment.Enchantment;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/** Runs real terminal controller ticks, replacing only world storage and observed player facts. */
public final class CombatResultContractVerification {
	private static int assertions;
	private CombatResultContractVerification() { }

	public static void main(String[] args) {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		System.out.println("PASS: " + verify() + " combat result contract assertions");
	}

	public static int verify() {
		assertions = 0;
		try {
			var unsafeField = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
			unsafeField.setAccessible(true);
			var allocator = (sun.misc.Unsafe) unsafeField.get(null);
			FixtureLevel level = (FixtureLevel) allocator.allocateInstance(FixtureLevel.class);
			level.entities = new ArrayList<>();
			var registries = new MappedRegistry<Registry<?>>(net.minecraft.resources.ResourceKey.createRegistryKey(BuiltInRegistries.REGISTRY.key().identifier()), Lifecycle.stable());
			var enchantments = new MappedRegistry<Enchantment>(Registries.ENCHANTMENT, Lifecycle.stable());
			enchantments.freeze();
			Registry.register(registries, Registries.ENCHANTMENT.identifier(), enchantments);
			registries.freeze();
			level.registries = RegistryAccess.fromRegistryOfRegistries(registries);
			FixturePlayer player = body(allocator, level, new Vec3(0.5D, 64, 0.5D));
			FixturePlayer target = body(allocator, level, new Vec3(4.5D, 64, 0.5D));
			verifyFight(player, target);
			verifyUnreachableRetry(player, target);
			verifyFlee(player, target);
			verifyFightHandoff(player, target);
			verifyPolicySchedule(player, target);
			verifyAfloatFleeReceipt(player, target);
			verifyTrappedReceipts(player, target);
			verifyNavigationLandingStop(player);
			return assertions;
		} catch (ReflectiveOperationException failure) {
			throw new AssertionError("combat result fixture failed", failure);
		}
	}

	private static void verifyFight(FixturePlayer player, FixturePlayer target) {
		target.alive = false;
		target.dead = true;
		var killed = fight(target, null).tick(player, 1000);
		check(killed, ServerController.State.SUCCEEDED, "TARGET_KILLED");
		check(killed.message().contains("kills: 1x minecraft:player"), "kill receipt includes all verified kills");
		target.dead = false;
		check(fight(target, null).tick(player, 1000), ServerController.State.SUCCEEDED, "TARGET_GONE");
		target.alive = true;
		player.health = 6;
		player.burningTicks = 80;
		var bailout = fight(target, 6F).tick(player, 1000);
		check(bailout, ServerController.State.FAILED, "LOW_HEALTH_BAILOUT");
		check(bailout.message().contains("input idle, motion stationary, onFire=true (4.0s), contact=none"),
				"real low-health fight stop remains idle and burning on dry ground");
		check(bailout.message().contains("nearest known water: none known"), "real bailout reports unknown extinguishing options honestly");
		check(bailout.message().startsWith("body idle; no retreat performed;"), "bailout reports a stop without retreat");
		player.burningTicks = 0;
		player.health = 20;
		var expired = fight(target, null).tick(player, 2000);
		check(expired, ServerController.State.TIMED_OUT, "FIGHT_TIMED_OUT");
		check(expired.message().startsWith("body idle; no retreat performed;"), "fight timeout leaves the body idle");
		check(expired.message().contains("hits 0"), "timeout does not invent a hit");
		var farTarget = target.position();
		try {
			move(target, new Vec3(40.5D, 64, .5D));
			check(fight(target, null).tick(player, 1000), ServerController.State.FAILED, "TARGET_ESCAPED");
		} finally { move(target, farTarget); }
		player.alive = false;
		check(fight(target, null).tick(player, 1000), ServerController.State.FAILED, "AGENT_DEAD");
		player.alive = true;
		var controller = fight(target, null);
		check(invoke(controller, "unreachable", new Class<?>[]{ServerPlayer.class, String.class}, player,
				"all tested reachable cells were seen and unreachable"), ServerController.State.FAILED, "TARGET_UNREACHABLE");
		try { set(controller, ServerFightController.class, "unseenRoute", "route enters unseen terrain"); }
		catch (ReflectiveOperationException failure) { throw new AssertionError(failure); }
		try {
			set(controller, ServerFightController.class, "stalls", 1);
			var clock = (CombatPlanning.ProgressClock) field(controller, "clock");
			clock.observe(4); clock.observe(4);
			var detector = (CombatStallDetector) field(controller, "stallDetector");
			for (int i = 1; i < CombatStallDetector.WINDOW_TICKS; i++) detector.observe(.5, 64, .5, true, true, true, false);
			var blocked = invoke(controller, "observeStall", new Class<?>[]{ServerPlayer.class, boolean.class, float.class}, player, true, 0F);
			check(blocked, ServerController.State.FAILED, "NO_SEEN_ROUTE");
			check(blocked.message().contains("route enters unseen terrain"), "stalled unseen approach returns facts so the model chooses another action");
			var ended = controller.tick(player, 2000);
			check(ended, ServerController.State.TIMED_OUT, "FIGHT_TIMED_OUT");
			check(ended.message().contains("input idle"), "timeout reports idle input after stopping the fight");
		} catch (ReflectiveOperationException failure) { throw new AssertionError(failure); }
		// Feed the same real detector that observeStall uses; its first stall requests a check and its next ends the action.
		try {
			Field detector = ServerFightController.class.getDeclaredField("stallDetector");
			detector.setAccessible(true);
			var stalled = fight(target, null);
			set(stalled, ServerFightController.class, "stalls", 1);
			Field clock = ServerFightController.class.getDeclaredField("clock");
			clock.setAccessible(true);
			((CombatPlanning.ProgressClock) clock.get(stalled)).observe(4);
			((CombatPlanning.ProgressClock) clock.get(stalled)).observe(4);
			var tracker = (CombatStallDetector) detector.get(stalled);
			for (int i = 1; i < CombatStallDetector.WINDOW_TICKS; i++) tracker.observe(.5, 64, .5, true, true, true, false);
			check(invoke(stalled, "observeStall", new Class<?>[]{ServerPlayer.class, boolean.class, float.class}, player, true, 0F),
					ServerController.State.FAILED, "APPROACH_BLOCKED");
		} catch (ReflectiveOperationException failure) { throw new AssertionError(failure); }
	}

	private static void verifyUnreachableRetry(FixturePlayer player, FixturePlayer target) throws ReflectiveOperationException {
		var level = player.fixtureLevel;
		float yaw = player.getYRot();
		Vec3 targetPosition = target.position();
		try {
			level.loaded = true;
			target.visible = true;
			player.setYRot(-90F);
			player.setYHeadRot(-90F);
			var blocks = new java.util.HashMap<BlockPos, BlockState>();
			blocks.put(new BlockPos(0, 63, 0), Blocks.STONE.defaultBlockState());
			blocks.put(new BlockPos(0, 64, 0), Blocks.AIR.defaultBlockState());
			blocks.put(new BlockPos(0, 65, 0), Blocks.AIR.defaultBlockState());
			installAcquiredReader(player, blocks, java.util.Set.copyOf(blocks.keySet()));
			var view = ObservedTerrain.forCheck(player);
			view.cellAt(new dev.agaminggod.arenaagents.client.navigation.GridPosition(0, 63, 0));
			view.endSlice();
			var constructor = Class.forName(ServerFightController.class.getName() + "$ReachCheck").getDeclaredConstructors()[0];
			constructor.setAccessible(true);
			var box = target.getBoundingBox();
			var cells = new MeleeReach.ReachCells(box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ, 3D);
			Object priorCheck = constructor.newInstance(view, cells,
					new dev.agaminggod.arenaagents.client.navigation.GridPosition(0, 64, 0),
					new dev.agaminggod.arenaagents.client.navigation.GridPosition(4, 64, 0), target.position(), box, 12, 0);
			var original = fight(target, null);
			set(original, ServerFightController.class, "lastReach", priorCheck);
			set(original, ServerFightController.class, "unseenRoute", "no route through seen terrain");
			set(original, ServerFightController.class, "reachFacts", "; observed melee cells: (4.5,64,0.5) 4.0m path=no_seen_route");
			var stopped = invoke(original, "finish", new Class<?>[]{ServerPlayer.class, ServerController.TickResult.class}, player,
					ServerController.TickResult.failed("NO_SEEN_ROUTE", "blocked", 0D));
			check(stopped.message().contains("observed melee cells"), "completed zero-hit negative check preserves the prior reach facts: " + stopped.message());
			check(((java.util.Map<?, ?>) field(original, "FAILED_APPROACHES")).containsKey(player.getUUID()),
					"negative check stored for retry: " + stopped.message());
			level.gameTime++;
			var retry = fight(target, null);
			var repeated = retry.tick(player, 1000);
			check(repeated, ServerController.State.FAILED, "NO_SEEN_ROUTE");
			check(repeated.message().contains("Unchanged unreachable approach") && repeated.message().contains("path=no_seen_route"),
					"real repeated fight returns prior observed positions on its very first tick");
			check((int) field(retry, "weaponSlot") == -1 && field(retry, "reachCheck") == null,
					"fast failure performs no weapon selection, route search or movement");
			check(repeated.message().contains("input idle") && repeated.message().contains("onFire=false"), "fast failure reports fresh body facts");
			move(target, target.position().add(0, 1D, 0));
			var refreshed = invoke(original, "finish", new Class<?>[]{ServerPlayer.class, ServerController.TickResult.class}, player,
					ServerController.TickResult.failed("LOW_HEALTH_BAILOUT", "stopped", 0D));
			check(refreshed.message().contains("observed melee cells") && !refreshed.message().contains("path=no_seen_route"),
					"changed hover height refreshes current reach geometry instead of repeating old cells");
			original.cancel(player);
			player.burningTicks = 60;
			check(original.stoppedBodyFacts(player).contains("input idle, motion stationary, onFire=true (3.0s)"),
					"explicit cancellation reports burning idle body facts after releasing input");
		} finally {
			move(target, targetPosition);
			player.burningTicks = 0;
			level.loaded = false;
			level.blocks = null;
			target.visible = false;
			player.setYRot(yaw);
			player.setYHeadRot(yaw);
			dev.agaminggod.arenaagents.server.perception.SeenTerrain.forget(player);
		}
	}

	private static ServerFightController fight(FixturePlayer target, Float fleeAtHealth) {
		return new ServerFightController(target, null, fleeAtHealth, false, 1000, 1000);
	}

	private static void verifyFlee(FixturePlayer player, FixturePlayer target) {
		target.alive = false;
		var gone = new ServerFleeController(target, 8, 1000, 1000).tick(player, 1000);
		check(gone, ServerController.State.FAILED, "TARGET_GONE");
		check(gone.message().contains("disappearance does not establish escape") && gone.message().contains("last observed separation unknown"),
				"a vanished target never fabricates successful escape or an observed distance");
		target.alive = true;
		check(new ServerFleeController(target, 8, 1000, 1000).tick(player, 2000), ServerController.State.TIMED_OUT, "FLEE_TIMED_OUT");
		player.alive = false;
		check(new ServerFleeController(target, 8, 1000, 1000).tick(player, 1000), ServerController.State.FAILED, "AGENT_DEAD");
		player.alive = true;
		// Seed only the production distance-history tracker so this tick begins at a terminal separation decision.
		var escaped = new ServerFleeController(target, 3, 1000, 1000);
		try {
			Field progress = ServerFleeController.class.getDeclaredField("progress");
			progress.setAccessible(true);
			var tracker = (CombatPlanning.FleeProgress) progress.get(escaped);
			for (int tick = 0; tick < CombatPlanning.NOT_CLOSING_WINDOW_TICKS + 2; tick++) tracker.observe(4, true);
			check(escaped.tick(player, 1000), ServerController.State.SUCCEEDED, "ESCAPED");
			var lost = new ServerFleeController(target, 8, 1000, 1000);
			tracker = (CombatPlanning.FleeProgress) progress.get(lost);
			for (int tick = 0; tick < CombatPlanning.LOST_TICKS; tick++) tracker.observe(4, false);
			target.hunting = false;
			check(lost.tick(player, 1000), ServerController.State.SUCCEEDED, "TARGET_LOST");
			target.hunting = true;
		} catch (ReflectiveOperationException failure) { throw new AssertionError(failure); }
		var blocked = new ServerFleeController(target, 8, 1000, 1000);
		var stopped = invoke(blocked, "blocked", new Class<?>[]{ServerPlayer.class, List.class, double.class}, player, List.of(), 4D);
		check(stopped, ServerController.State.FAILED, "FLEE_BLOCKED");
		check(stopped.message().startsWith("body idle; no further retreat performed;"), "blocked flee leaves the body idle");
	}

	private static void verifyTrappedReceipts(FixturePlayer player, FixturePlayer target) throws ReflectiveOperationException {
		Vec3 start = player.position();
		var blocks = new java.util.HashMap<BlockPos, BlockState>();
		blocks.put(new BlockPos(30, 49, 27), Blocks.MAGMA_BLOCK.defaultBlockState());
		blocks.put(new BlockPos(29, 51, 27), Blocks.BASALT.defaultBlockState());
		blocks.put(new BlockPos(28, 52, 27), Blocks.BASALT.defaultBlockState());
		for (BlockPos p : List.of(new BlockPos(30, 50, 27), new BlockPos(30, 51, 27), new BlockPos(29, 52, 27),
				new BlockPos(29, 53, 27), new BlockPos(28, 53, 27), new BlockPos(28, 54, 27))) blocks.put(p, Blocks.AIR.defaultBlockState());
		try {
			move(player, new Vec3(30.30000001192093D, 50D, 27.137887602061607D));
			player.health = 19.58F;
			set(player, Entity.class, "onGround", true);
			installAcquiredReader(player, blocks, java.util.Set.copyOf(blocks.keySet()));
			var flee = new ServerFleeController(target, 12, 6000, 1000);
			var stopped = invoke(flee, "blocked", new Class<?>[]{ServerPlayer.class, List.class, double.class}, player, List.of(), 10D);
			check(stopped, ServerController.State.FAILED, "FLEE_BLOCKED");
			check(stopped.message().contains("health 19.6; onGround=true; footing below center: minecraft:magma_block at 30,49,27"),
					"D1 blocked retreat reports current health and acquired magma support");
			check(stopped.message().contains("exits:") && stopped.message().contains("up2 landing route unknown (29,52,27)"),
					"trapped retreat reports the retained higher basalt exit without claiming a walkable route");
			check(stopped.message().indexOf("health 19.6") < 400 && stopped.message().indexOf("exits:") < 500,
					"support and exits precede the long heading list inside the coordinator's 2048-character blocker limit");
			var fightController = fight(target, null);
			var blockedFight = invoke(fightController, "unreachable", new Class<?>[]{ServerPlayer.class, String.class}, player, "all seen approaches blocked");
			var fight = invoke(fightController, "finish", new Class<?>[]{ServerPlayer.class, ServerController.TickResult.class}, player, blockedFight);
			check(fight.message().contains("all seen approaches blocked") && fight.message().contains("health 19.6")
					&& fight.message().contains("footing below center: minecraft:magma_block") && fight.message().contains("exits:"),
					"blocked combat retains its reason alongside the same support, health and hazard exits");
			check(fight.message().indexOf("health 19.6") < 100, "combat support and health precede long reach and threat details");
			check(field(flee, ServerFleeController.class, "motor") == null, "blocked receipt facts issue no movement");
			installAcquiredReader(player, blocks, java.util.Set.of());
			String unknown = CombatMoveText.supportFacts(player);
			check(unknown.contains("footing below center: unknown at 30,49,27") && !unknown.contains("minecraft:magma_block"),
					"an unacquired support block is not named from hidden world state");
		} finally {
			move(player, start);
			player.health = 20F;
			set(player, Entity.class, "onGround", false);
			dev.agaminggod.arenaagents.server.perception.SeenTerrain.forget(player);
			player.fixtureLevel.blocks = null;
		}
	}

	private static void verifyNavigationLandingStop(FixturePlayer player) throws ReflectiveOperationException {
		Vec3 start = player.position();
		var blocks = new java.util.HashMap<BlockPos, BlockState>();
		blocks.put(new BlockPos(28, 55, 28), Blocks.BASALT.defaultBlockState());
		blocks.put(new BlockPos(28, 56, 28), Blocks.AIR.defaultBlockState());
		blocks.put(new BlockPos(28, 57, 28), Blocks.AIR.defaultBlockState());
		blocks.put(new BlockPos(26, 56, 28), Blocks.BASALT.defaultBlockState());
		blocks.put(new BlockPos(27, 57, 28), Blocks.BASALT.defaultBlockState());
		for (int y = 57; y <= 61; y++) {
			blocks.put(new BlockPos(26, y, 28), Blocks.AIR.defaultBlockState());
			if (y >= 58) blocks.put(new BlockPos(27, y, 28), Blocks.AIR.defaultBlockState());
			blocks.put(new BlockPos(28, y, 27), Blocks.AIR.defaultBlockState());
			if (y >= 58) blocks.put(new BlockPos(28, y, 28), Blocks.AIR.defaultBlockState());
		}
		try {
			// Local takeoff on the retained basalt cell; the following airborne and landing positions are verbatim D1.
			move(player, new Vec3(26.5D, 57D, 28.5D));
			set(player, Entity.class, "onGround", true);
			// Facing the step (+x), as the walk up to it leaves the body; a jump into a walled landing waits for the turn.
			player.setYRot(-90F);
			installAcquiredReader(player, blocks, java.util.Set.copyOf(blocks.keySet()));
			var navigation = new ServerNavigationController(new Vec3(40D, 58D, 27D), 2D, true, 1000L, 12000L);
			var landing = (ServerNavigationController.LandingCheck) field(navigation, ServerNavigationController.class, "landingCheck");
			var route = new dev.agaminggod.arenaagents.client.navigation.PathPlan(List.of(
					new dev.agaminggod.arenaagents.client.navigation.PathNode(new dev.agaminggod.arenaagents.client.navigation.GridPosition(26, 57, 28),
							dev.agaminggod.arenaagents.client.navigation.TraversalType.START),
					new dev.agaminggod.arenaagents.client.navigation.PathNode(new dev.agaminggod.arenaagents.client.navigation.GridPosition(27, 58, 28),
							dev.agaminggod.arenaagents.client.navigation.TraversalType.JUMP_UP)), dev.agaminggod.arenaagents.client.navigation.PathOutcome.FOUND, 1);
			set(navigation, ServerNavigationController.class, "plan", route);
			set(navigation, ServerNavigationController.class, "waypointIndex", 1);
			set(navigation, ServerNavigationController.class, "progress", new WaypointProgress(Math.sqrt(2D), 1000L, 4000L, 3));
			int[] released = {0};
			var inputs = new dev.agaminggod.arenaagents.server.runtime.input.LeasedServerInputController(
					new dev.agaminggod.arenaagents.server.runtime.input.InputStateSink() {
						public void apply(dev.agaminggod.arenaagents.agent.AgentId id,
								dev.agaminggod.arenaagents.server.runtime.input.AgentInputState previous,
								dev.agaminggod.arenaagents.server.runtime.input.AgentInputState state) { }
						public void clear(dev.agaminggod.arenaagents.agent.AgentId id,
								dev.agaminggod.arenaagents.server.runtime.input.AgentInputState previous) { released[0]++; }
					});
			var id = dev.agaminggod.arenaagents.agent.AgentId.random();
			var lease = inputs.acquire(id, dev.agaminggod.arenaagents.server.runtime.input.InputOwner.NAVIGATION, 100);
			inputs.apply(lease, new dev.agaminggod.arenaagents.server.runtime.input.AgentInputState(1F, 0F, true, false, true,
					false, false, 90F, 0F, 1, net.minecraft.world.InteractionHand.MAIN_HAND));
			set(navigation, ServerNavigationController.class, "inputController", inputs);
			set(navigation, ServerNavigationController.class, "inputLease", lease);
			check(navigation.tick(player, 1050L).state() == ServerController.State.RUNNING && inputs.currentState(id).orElseThrow().jump(),
					"the real controller drives the planned one-block jump from observed basalt");
			move(player, new Vec3(28.261376219070367D, 58.25220334025373D, 27.88842871911527D));
			set(player, Entity.class, "onGround", false);
			installAcquiredReader(player, blocks, java.util.Set.copyOf(blocks.keySet()));
			check(navigation.tick(player, 1100L).state() == ServerController.State.RUNNING, "the real controller retains the local jump in flight");
			move(player, new Vec3(28.30000001192093D, 56D, 28.599327473823017D));
			set(player, Entity.class, "onGround", true);
			installAcquiredReader(player, blocks, java.util.Set.copyOf(blocks.keySet()));
			var receipt = navigation.tick(player, 1150L);
			check(receipt, ServerController.State.FAILED, "MISSED_LANDING");
			check(receipt.message().contains("planned landing at 27.5,58.00,28.5") && receipt.message().contains("minecraft:basalt at 28,55,28"),
					"actual navigation entry reports the failed local jump and the lower observed support");
			check(released[0] == 1 && inputs.currentState(id).isEmpty(), "the failed landing releases the live navigation lease");
			check(field(navigation, ServerNavigationController.class, "search") == null && field(navigation, ServerNavigationController.class, "preparation") == null,
					"the failed landing returns control before a downhill recovery search");
			move(player, new Vec3(29.802431157388547D, 52.92159999847412D, 27.44358298655306D));
			player.velocity = new Vec3(.14623870879798498D, -.1552320045166016D, -.03315141272664165D);
			set(player, Entity.class, "onGround", false);
			landing.track(dev.agaminggod.arenaagents.client.navigation.TraversalType.DROP_DOWN, new Vec3(29.5D, 52D, 27.5D), true);
			landing.observe(false, false, player.getY());
			navigation.cancel(player);
			String handoff = navigation.stoppedBodyFacts(player);
			check(handoff.contains("navigation input released") && handoff.contains("airborne") && handoff.contains("0.20 s to its height")
					&& handoff.contains("momentum continues after release"), "a real airborne cancellation reports residual motion and an unverified height ETA");
		} finally {
			move(player, start);
			player.velocity = Vec3.ZERO;
			set(player, Entity.class, "onGround", false);
			dev.agaminggod.arenaagents.server.perception.SeenTerrain.forget(player);
			player.fixtureLevel.blocks = null;
		}
	}

	private static Object field(Object target, Class<?> owner, String name) throws ReflectiveOperationException {
		Field field = owner.getDeclaredField(name);
		field.setAccessible(true);
		return field.get(target);
	}

	private static void verifyAfloatFleeReceipt(FixturePlayer player, FixturePlayer target) throws ReflectiveOperationException {
		var blocks = new java.util.HashMap<BlockPos, BlockState>();
		for (int x : new int[]{3, 7}) {
			blocks.put(new BlockPos(x, 63, 0), Blocks.STONE.defaultBlockState());
			blocks.put(new BlockPos(x, 64, 0), Blocks.AIR.defaultBlockState());
			blocks.put(new BlockPos(x, 65, 0), Blocks.AIR.defaultBlockState());
		}
		try {
			target.alive = false;
			player.afloat = true;
			player.underwater = true;
			player.fixtureAir = 130;
			installAcquiredReader(player, blocks, java.util.Set.copyOf(blocks.keySet()));
			var controller = new ServerFleeController(target, 8, 1000, 1000);
			var receipt = controller.tick(player, 1000);
			check(receipt, ServerController.State.FAILED, "TARGET_GONE");
			check(receipt.message().contains("still under water with 6.5 s of air; swim input released"),
					"real afloat terminal receipt reports current air and released swim input");
			check(receipt.message().contains("land seen at 3,64,0 (3.0 m), 7,64,0 (7.0 m)"),
					"real afloat terminal receipt reports only acquired shores, nearest first");
			Field motor = ServerFleeController.class.getDeclaredField("motor"); motor.setAccessible(true);
			check(motor.get(controller) == null, "ending afloat publishes shore facts without choosing a shore or issuing swim input");
			player.underwater = false;
			String surface = new ServerFleeController(target, 8, 1000, 1000).tick(player, 1000).message();
			check(surface.contains("still swimming in deep water; swim input released") && !surface.contains(" s of air"),
					"eyes above water report deep swimming without an invented drowning countdown");
			player.underwater = true;
			player.fixtureAir = -20;
			String unknown = null;
			for (BlockState hidden : new BlockState[]{Blocks.STONE.defaultBlockState(), Blocks.AIR.defaultBlockState(), Blocks.LAVA.defaultBlockState()}) {
				blocks.put(new BlockPos(3, 63, 0), hidden);
				installAcquiredReader(player, blocks, java.util.Set.of());
				String message = new ServerFleeController(target, 8, 1000, 1000).tick(player, 1000).message();
				check(message.contains("still under water with 0.0 s of air; swim input released; no land seen within ")
						&& !message.contains("land seen at"), "unknown shore is explicitly unknown and air never becomes negative");
				check(unknown == null || unknown.equals(message), "hidden support, gap and lava cannot change an afloat shore receipt");
				unknown = message;
			}
			player.afloat = false;
			String dry = new ServerFleeController(target, 8, 1000, 1000).tick(player, 1000).message();
			check(!dry.contains("swim input") && !dry.contains("land seen"), "dry terminal receipts do not retain stale swimming facts");
		} finally {
			player.afloat = false;
			player.underwater = false;
			target.alive = true;
			dev.agaminggod.arenaagents.server.perception.SeenTerrain.forget(player);
		}
	}

	private static void installAcquiredReader(FixturePlayer player, java.util.Map<BlockPos, BlockState> blocks,
			java.util.Set<BlockPos> acquired) throws ReflectiveOperationException {
		var memory = new dev.agaminggod.arenaagents.server.perception.SeenTerrain.Memory<BlockState>();
		var source = new dev.agaminggod.arenaagents.server.perception.SeenTerrain.Source<BlockState>() {
			@Override public BlockState live(int x, int y, int z) {
				return blocks.getOrDefault(new BlockPos(x, y, z), Blocks.AIR.defaultBlockState());
			}
			@Override public boolean sees(int x, int y, int z) { return acquired.contains(new BlockPos(x, y, z)); }
		};
		var reader = new dev.agaminggod.arenaagents.server.perception.SeenTerrain.Reader<>(memory, source,
				player.fixtureLevel.gameTime, null);
		var state = dev.agaminggod.arenaagents.server.perception.SeenTerrain.class.getDeclaredMethod("state",
				ServerPlayer.class, ServerLevel.class, long.class);
		state.setAccessible(true);
		Object cache = state.invoke(null, player, player.fixtureLevel, player.fixtureLevel.gameTime);
		set(cache, cache.getClass(), "memory", memory);
		set(cache, cache.getClass(), "reader", reader);
		player.fixtureLevel.blocks = blocks;
		set(cache, cache.getClass(), "eye", player.getEyePosition());
		set(cache, cache.getClass(), "yaw", player.getYRot());
		set(cache, cache.getClass(), "pitch", player.getXRot());
	}

	private static void verifyFightHandoff(FixturePlayer player, FixturePlayer target) throws ReflectiveOperationException {
		var holder = net.minecraft.world.item.Items.MACE.builtInRegistryHolder();
		var original = holder.areComponentsBound() ? holder.components() : null;
		try {
			holder.bindComponents(net.minecraft.core.component.DataComponentMap.builder()
					.set(net.minecraft.core.component.DataComponents.MAX_STACK_SIZE, 1)
					.set(net.minecraft.core.component.DataComponents.MAX_DAMAGE, 500).build());
			player.getInventory().setItem(2, new ItemStack(net.minecraft.world.item.Items.MACE));
			target.alive = false;
			target.dead = false;
			for (long age : new long[]{0, 40, 41, -1}) {
				player.fixtureLevel.gameTime = 100;
				var previous = fight(target, null);
				set(previous, ServerFightController.class, "weaponSlot", 2);
				set(previous, ServerFightController.class, "backoffTicks", 11);
				previous.cancel(player);
				player.fixtureLevel.gameTime = 100 + age;
				var replacement = fight(target, null);
				check(replacement.tick(player, 1000), ServerController.State.SUCCEEDED, "TARGET_GONE");
				boolean inherited = age >= 0 && age <= 40;
				check((int) field(replacement, "weaponSlot") == (inherited ? 2 : -1), "only timely fight replacement inherits an available weapon");
				check((int) field(replacement, "backoffTicks") == (inherited ? 11 : 0), "only timely fight replacement inherits remaining swing backoff");
				var unrelated = fight(target, null);
				unrelated.tick(player, 1000);
				check((int) field(unrelated, "weaponSlot") == -1 && (int) field(unrelated, "backoffTicks") == 0,
						"cancelled stance is consumed once, never applied to later fights");
			}
			player.fixtureLevel.gameTime = 200;
			var previous = fight(target, null);
			set(previous, ServerFightController.class, "weaponSlot", 2);
			set(previous, ServerFightController.class, "backoffTicks", 7);
			previous.cancel(player);
			player.getInventory().setItem(2, ItemStack.EMPTY);
			var missingWeapon = fight(target, null);
			missingWeapon.tick(player, 1000);
			check((int) field(missingWeapon, "weaponSlot") == -1, "handoff never equips a vanished hotbar weapon");
			check((int) field(missingWeapon, "backoffTicks") == 7, "existing swing backoff survives a missing weapon");
		} finally {
			player.getInventory().setItem(2, ItemStack.EMPTY);
			player.fixtureLevel.gameTime = 0;
			target.alive = true;
			if (original != null) holder.bindComponents(original);
			else {
				Field components = Holder.Reference.class.getDeclaredField("components");
				components.setAccessible(true);
				components.set(holder, null);
			}
		}
	}

	private static void verifyPolicySchedule(FixturePlayer player, FixturePlayer target) {
		var controller = new ServerFightController(target, null, null, false, CombatPlanning.TargetPolicy.NEAREST_ATTACKER,
				false, 1000, 1000);
		player.fixtureLevel.entityQueries = 0;
		for (int tick = 1; tick < 10; tick++) invoke(controller, "applyTargetPolicy", new Class<?>[]{ServerPlayer.class}, player);
		check(player.fixtureLevel.entityQueries == 0, "policy preserves the authored initial target for the first nine ticks");
		invoke(controller, "applyTargetPolicy", new Class<?>[]{ServerPlayer.class}, player);
		check(player.fixtureLevel.entityQueries == 1, "opted-in policy checks attackers after half a second of authored fight ticks");
		for (int tick = 0; tick < 10; tick++) invoke(controller, "applyTargetPolicy", new Class<?>[]{ServerPlayer.class}, player);
		check(player.fixtureLevel.entityQueries == 2, "policy checks again after the next half second of authored fight ticks");
		for (int tick = 0; tick < 10; tick++) invoke(controller, "applyTargetPolicy", new Class<?>[]{ServerPlayer.class}, player);
		check(player.fixtureLevel.entityQueries == 3, "half-second cadence continues without restarting the fight");
		player.fixtureLevel.entityQueries = 0;
		var named = fight(target, null);
		for (int tick = 0; tick < 25; tick++) invoke(named, "applyTargetPolicy", new Class<?>[]{ServerPlayer.class}, player);
		check(player.fixtureLevel.entityQueries == 0, "named policy never scans for an autonomous replacement target");
	}

	private static Object field(ServerFightController controller, String name) throws ReflectiveOperationException {
		Field field = ServerFightController.class.getDeclaredField(name);
		field.setAccessible(true);
		return field.get(controller);
	}

	private static ServerController.TickResult invoke(Object target, String name, Class<?>[] types, Object... arguments) {
		try {
			var method = target.getClass().getDeclaredMethod(name, types);
			method.setAccessible(true);
			return (ServerController.TickResult) method.invoke(target, arguments);
		} catch (ReflectiveOperationException failure) { throw new AssertionError("terminal result method " + name, failure); }
	}

	private static FixturePlayer body(sun.misc.Unsafe allocator, FixtureLevel level, Vec3 position) throws ReflectiveOperationException {
		FixturePlayer player = (FixturePlayer) allocator.allocateInstance(FixturePlayer.class);
		player.setId(1019); // 26.3 assigns entity IDs in the constructor, which Unsafe allocation skips.
			player.fixtureLevel = level;
			player.alive = true;
			player.hunting = true;
			player.health = 20;
			player.abilities = new Abilities();
			player.abilities.invulnerable = true;
			EntityEquipment equipment = new EntityEquipment();
			set(player, Player.class, "inventory", new Inventory(player, equipment));
			set(player, LivingEntity.class, "equipment", equipment);
			set(player, Entity.class, "uuid", UUID.randomUUID());
			set(player, Entity.class, "type", EntityTypes.PLAYER);
			set(player, Entity.class, "eyeHeight", 1.62F);
			move(player, position);
			return player;
	}

	private static void move(FixturePlayer player, Vec3 at) {
		try {
			set(player, Entity.class, "position", at);
			set(player, Entity.class, "blockPosition", BlockPos.containing(at));
			set(player, Entity.class, "bb", new AABB(at.x - .3D, at.y, at.z - .3D, at.x + .3D, at.y + 1.8D, at.z + .3D));
		} catch (ReflectiveOperationException failure) { throw new AssertionError(failure); }
	}

	private static void set(Object target, Class<?> owner, String name, Object value) throws ReflectiveOperationException {
		Field field = owner.getDeclaredField(name);
		field.setAccessible(true);
		field.set(target, value);
	}

	private static void check(ServerController.TickResult result, ServerController.State state, String code) {
		check(result.state() == state && result.reasonCode().equals(code), "expected " + state + " " + code + ", got " + result);
	}
	private static void check(boolean condition, String label) {
		if (!condition) throw new AssertionError(label);
		assertions++;
	}

	private static final class FixturePlayer extends ServerPlayer {
		FixtureLevel fixtureLevel;
		Abilities abilities;
		boolean alive, dead, hunting, afloat, underwater, visible;
		int fixtureAir;
		int burningTicks;
		float health;
		Vec3 velocity = Vec3.ZERO;
		net.minecraft.world.food.FoodData food;
		private FixturePlayer(MinecraftServer server, ServerLevel level, GameProfile profile, ClientInformation client) {
			super(server, level, profile, client);
		}
		@Override public ServerLevel level() { return fixtureLevel; }
		@Override public boolean isAlive() { return alive; }
		@Override public boolean isDeadOrDying() { return dead; }
		@Override public float getHealth() { return health; }
		@Override public net.minecraft.world.food.FoodData getFoodData() {
			if (food == null) food = new net.minecraft.world.food.FoodData();
			return food;
		}
		@Override public Abilities getAbilities() { return abilities; }
		@Override public boolean hasEffect(Holder<MobEffect> effect) { return false; }
		@Override public boolean isInvisibleTo(Player observer) { return !visible; }
		@Override public boolean hasLineOfSight(Entity other) { return hunting; }
		@Override public boolean isDescending() { return false; }
		@Override public double getAttributeValue(Holder<net.minecraft.world.entity.ai.attributes.Attribute> attribute) { return 20D; }
		@Override public net.minecraft.world.item.component.AttackRange getAttackRangeWith(ItemStack stack) {
			return new net.minecraft.world.item.component.AttackRange(0F, 3F, 0F, 5F, 0F, 1F);
		}
		@Override public ItemStack getMainHandItem() { return ItemStack.EMPTY; }
		@Override public boolean isInWater() { return afloat; }
		@Override public boolean isUnderWater() { return underwater; }
		@Override public int getAirSupply() { return fixtureAir; }
		@Override public boolean isInLava() { return false; }
		@Override public boolean isEyeInFluid(net.minecraft.tags.TagKey<net.minecraft.world.level.material.Fluid> tag) { return false; }
		@Override public Vec3 getDeltaMovement() { return velocity == null ? Vec3.ZERO : velocity; }
		@Override public boolean isFallFlying() { return false; }
		@Override public boolean isOnFire() { return burningTicks > 0; }
		@Override public int getRemainingFireTicks() { return burningTicks; }
		@Override public boolean onClimbable() { return false; }
		@Override public boolean isSpectator() { return false; }
		@Override public boolean isCreative() { return false; }
	}

	private static final class FixtureLevel extends ServerLevel {
		// 26.3 entities take their ID from the level, and ServerLevel asks its (absent) chunk source.
		private int fixtureEntityIds = 100_000;
		@Override public int getNextEntityId() { return ++fixtureEntityIds; }
		List<LivingEntity> entities;
		RegistryAccess registries;
		long gameTime;
		int entityQueries;
		boolean loaded;
		java.util.Map<BlockPos, BlockState> blocks;
		private FixtureLevel() { super(null, null, null, null, null, null, false, 0, List.of(), false); }
		@Override public long getGameTime() { return gameTime; }
		@Override public boolean hasChunk(int x, int z) { return loaded; }
		@Override public boolean hasChunkAt(BlockPos position) { return loaded; }
		@Override public int getHeight() { return 384; }
		@Override public int getMinY() { return -64; }
		@Override public int getMaxY() { return 320; }
		@Override public RegistryAccess registryAccess() { return registries; }
		@Override public BlockState getBlockState(BlockPos position) { return blocks == null ? Blocks.AIR.defaultBlockState() : blocks.getOrDefault(position, Blocks.AIR.defaultBlockState()); }
		@Override public net.minecraft.world.level.material.FluidState getFluidState(BlockPos position) { return getBlockState(position).getFluidState(); }
		@Override public <T extends Entity> List<T> getEntitiesOfClass(Class<T> type, AABB bounds, Predicate<? super T> predicate) {
			entityQueries++;
			return entities.stream().filter(type::isInstance).map(type::cast).filter(predicate).toList();
		}
	}
}
