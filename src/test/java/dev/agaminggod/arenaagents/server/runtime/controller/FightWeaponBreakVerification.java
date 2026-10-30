package dev.agaminggod.arenaagents.server.runtime.controller;

import com.mojang.authlib.GameProfile;
import dev.agaminggod.arenaagents.agent.AgentId;
import dev.agaminggod.arenaagents.agent.AgentRecord;
import dev.agaminggod.arenaagents.server.AgentSavedData;
import dev.agaminggod.arenaagents.server.CodexAgentManager;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputRuntime;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputState;
import dev.agaminggod.arenaagents.server.runtime.input.InputStateSink;
import dev.agaminggod.arenaagents.server.runtime.input.LeasedServerInputController;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.network.syncher.EntityDataAccessor;
import net.minecraft.network.syncher.SynchedEntityData;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.dedicated.DedicatedServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.EntityTypes;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.EntityEquipment;
import net.minecraft.world.entity.monster.zombie.Zombie;
import net.minecraft.world.entity.player.Abilities;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.food.FoodData;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/**
 * Drives the real {@link ServerFightController#tick} through a fight in which the held sword breaks mid-fight while a
 * spare axe waits in the hotbar. The player, target and level are Unsafe-allocated fixtures (no live server); the input
 * lease runs through the real {@link LeasedServerInputController} with a sink that applies the leased hotbar slot the
 * way a client slot change would.
 */
public final class FightWeaponBreakVerification {
	private static int assertions;

	private FightWeaponBreakVerification() {
	}

	public static void main(String[] arguments) throws Exception {
		System.out.println("PASS: " + verify() + " fight weapon-break assertions");
	}

	public static int verify() throws Exception {
		assertions = 0;
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		// Two runs: the second proves the first left no shared state behind that changes the outcome.
		for (int run = 0; run < 2; run++) runIsolated();
		return assertions;
	}

	/**
	 * The fight's backstep reads terrain through SeenTerrain, whose per-player memory and sweep clock are static and shared
	 * with every other verification. The existing memories are moved out for the run (so its sweep cannot prune them),
	 * then restored exactly, on success and on failure.
	 */
	private static void runIsolated() throws Exception {
		Map<ServerPlayer, Object> seenPlayers = seenTerrainPlayers();
		Field sweptAtField = dev.agaminggod.arenaagents.server.perception.SeenTerrain.class.getDeclaredField("sweptAt");
		sweptAtField.setAccessible(true);
		Map<ServerPlayer, Object> savedPlayers = new java.util.IdentityHashMap<>(seenPlayers);
		long savedSweptAt = sweptAtField.getLong(null);
		seenPlayers.clear();
		Fixture fixture = null;
		try {
			fixture = Fixture.create();
			// Unit bootstrap leaves item components and tags unbound; bind what a vanilla registry load gives these weapons.
			try (ItemBindings bindings = new ItemBindings()) {
				bindings.bind(Items.IRON_SWORD, 250, net.minecraft.tags.ItemTags.SWORDS);
				bindings.bind(Items.STONE_AXE, 131, net.minecraft.tags.ItemTags.AXES);
				fixture.run();
				fixture.verifyNoPursuit();
				fixture.verifySneaking();
			}
			check(seenPlayers.containsKey(fixture.player), "the fight's backstep reached the shared terrain memory");
		} finally {
			if (fixture != null) fixture.close();
			seenPlayers.clear();
			seenPlayers.putAll(savedPlayers);
			sweptAtField.setLong(null, savedSweptAt);
		}
		check(seenPlayers.size() == savedPlayers.size() && savedPlayers.entrySet().stream()
				.allMatch(entry -> seenPlayers.get(entry.getKey()) == entry.getValue()),
				"the run leaves every other player's terrain memory in place");
		check(sweptAtField.getLong(null) == savedSweptAt, "the run leaves the terrain sweep clock unchanged");
	}

	@SuppressWarnings("unchecked")
	private static Map<ServerPlayer, Object> seenTerrainPlayers() throws Exception {
		Field field = dev.agaminggod.arenaagents.server.perception.SeenTerrain.class.getDeclaredField("PLAYERS");
		field.setAccessible(true);
		return (Map<ServerPlayer, Object>) field.get(null);
	}

	private static final class Fixture {
		static final int SWORD_SLOT = 0;
		static final int AXE_SLOT = 4;
		final sun.misc.Unsafe unsafe;
		final MinecraftServer server;
		final FightLevel level;
		final FightPlayer player;
		final FightZombie zombie;
		final List<Integer> leasedSlots = new ArrayList<>();
		final AgentId agentId;

		private Fixture(sun.misc.Unsafe unsafe, MinecraftServer server, FightLevel level, FightPlayer player, FightZombie zombie,
				AgentId agentId) {
			this.unsafe = unsafe;
			this.server = server;
			this.level = level;
			this.player = player;
			this.zombie = zombie;
			this.agentId = agentId;
		}

		static Fixture create() throws Exception {
			Field unsafeField = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
			unsafeField.setAccessible(true);
			sun.misc.Unsafe unsafe = (sun.misc.Unsafe) unsafeField.get(null);
			MinecraftServer server = (MinecraftServer) unsafe.allocateInstance(DedicatedServer.class);
			FightLevel level = (FightLevel) unsafe.allocateInstance(FightLevel.class);
			level.server = server;
			// An empty enchantment registry: neither weapon is enchanted.
			var registries = new net.minecraft.core.MappedRegistry<net.minecraft.core.Registry<?>>(
					net.minecraft.resources.ResourceKey.createRegistryKey(
							net.minecraft.core.registries.BuiltInRegistries.REGISTRY.key().identifier()),
					com.mojang.serialization.Lifecycle.stable());
			var enchantments = new net.minecraft.core.MappedRegistry<net.minecraft.world.item.enchantment.Enchantment>(
					net.minecraft.core.registries.Registries.ENCHANTMENT, com.mojang.serialization.Lifecycle.stable());
			enchantments.freeze();
			net.minecraft.core.Registry.register(registries, net.minecraft.core.registries.Registries.ENCHANTMENT.identifier(), enchantments);
			registries.freeze();
			level.registries = net.minecraft.core.RegistryAccess.fromRegistryOfRegistries(registries);
			set(unsafe, level, Level.class, "dimension", Level.OVERWORLD);

			CodexAgentManager manager = (CodexAgentManager) unsafe.allocateInstance(CodexAgentManager.class);
			set(unsafe, manager, CodexAgentManager.class, "server", server);
			set(unsafe, manager, CodexAgentManager.class, "savedData", new AgentSavedData());
			AgentRecord record = manager.registry().create("gpt-5.6-sol", "high", Optional.of("Fighter"), 1_000L);
			UUID playerId = UUID.fromString("00000000-0000-4000-8000-00000000f001");
			manager.registry().attachEntity(record.agentId(), playerId, 1_000L);
			instances().put(server, manager);

			Fixture[] holder = new Fixture[1];
			LeasedServerInputController controller = new LeasedServerInputController(new InputStateSink() {
				@Override
				public void apply(AgentId agent, AgentInputState previous, AgentInputState state) {
					if (state == null) return;
					holder[0].leasedSlots.add(state.selectedSlot());
					// A client hotbar key press: the leased slot becomes the selected slot.
					holder[0].player.getInventory().setSelectedSlot(state.selectedSlot());
				}

				@Override
				public void clear(AgentId agent, AgentInputState previous) {
				}
			});
			controllers().put(server, controller);

			FightPlayer player = (FightPlayer) unsafe.allocateInstance(FightPlayer.class);
			player.setId(1013); // 26.3 assigns entity IDs in the constructor, which Unsafe allocation skips.
			player.fixtureLevel = level;
			player.attacks = new ArrayList<>();
			player.selectedAtAttack = new ArrayList<>();
			set(unsafe, player, Entity.class, "uuid", playerId);
			set(unsafe, player, Player.class, "gameProfile", new GameProfile(playerId, "Fighter"));
			set(unsafe, player, Entity.class, "type", EntityTypes.PLAYER);
			set(unsafe, player, Entity.class, "level", level);
			EntityEquipment equipment = new EntityEquipment();
			set(unsafe, player, LivingEntity.class, "equipment", equipment);
			set(unsafe, player, Player.class, "inventory", new Inventory(player, equipment));
			set(unsafe, player, Player.class, "abilities", new Abilities());
			set(unsafe, player, Player.class, "foodData", new FoodData());
			set(unsafe, player, LivingEntity.class, "activeEffects", new HashMap<>());
			set(unsafe, player, LivingEntity.class, "attributes",
					new net.minecraft.world.entity.ai.attributes.AttributeMap(Player.createAttributes().build()));
			place(unsafe, player, new Vec3(0.5D, 64.0D, 0.5D), 0.6D, 1.8D);
			unsafe.putFloat(player, unsafe.objectFieldOffset(Entity.class.getDeclaredField("eyeHeight")), 1.62F);
			health(unsafe, player, 20.0F);

			FightZombie zombie = (FightZombie) unsafe.allocateInstance(FightZombie.class);
			zombie.setId(1014); // 26.3 assigns entity IDs in the constructor, which Unsafe allocation skips.
			zombie.fixtureLevel = level;
			set(unsafe, zombie, Entity.class, "uuid", UUID.fromString("00000000-0000-4000-8000-00000000f00d"));
			set(unsafe, zombie, Entity.class, "type", EntityTypes.ZOMBIE);
			set(unsafe, zombie, Entity.class, "level", level);
			set(unsafe, zombie, LivingEntity.class, "activeEffects", new HashMap<>());
			set(unsafe, zombie, LivingEntity.class, "equipment", new EntityEquipment());
			set(unsafe, zombie, LivingEntity.class, "attributes",
					new net.minecraft.world.entity.ai.attributes.AttributeMap(Zombie.createAttributes().build()));
			// Two blocks north of the player, inside sword reach and in clear sight.
			place(unsafe, zombie, new Vec3(0.5D, 64.0D, 2.5D), 0.6D, 1.95D);
			unsafe.putFloat(zombie, unsafe.objectFieldOffset(Entity.class.getDeclaredField("eyeHeight")), 1.74F);
			health(unsafe, zombie, 20.0F);

			level.entities = List.of(player, zombie);
			Fixture fixture = new Fixture(unsafe, server, level, player, zombie, record.agentId());
			holder[0] = fixture;
			return fixture;
		}

		/** The hotbar slot the fight's combat input lease holds right now, as arbitrated by the real input controller. */
		int leasedSlot() {
			try {
				return controllers().get(server).currentState(agentId).orElseThrow().selectedSlot();
			} catch (Exception exception) {
				throw new AssertionError("no leased fight input", exception);
			}
		}

		void run() {
			Inventory inventory = player.getInventory();
			inventory.setItem(SWORD_SLOT, new ItemStack(Items.IRON_SWORD));
			inventory.setItem(AXE_SLOT, new ItemStack(Items.STONE_AXE));
			inventory.setSelectedSlot(2);
			ServerFightController fight = new ServerFightController(zombie, null, null, 60_000L, 0L);
			long now = 0L;

			// The fight picks the sword; the swing waits until the sword is actually held.
			player.charge = 1.0F;
			ServerController.TickResult first = fight.tick(player, now += 50L);
			check(first.state() == ServerController.State.RUNNING, "the fight runs: " + first);
			check(leasedSlot() == SWORD_SLOT, "the fight selects the sword first");
			check(inventory.getSelectedSlot() == SWORD_SLOT, "the sword is held");
			check(player.attacks.isEmpty(), "no swing on the tick the weapon is still being selected");
			fight.tick(player, now += 50L);
			check(player.attacks.size() == 1 && player.attacks.getFirst() == zombie, "the sword hits the named zombie");
			check(player.selectedAtAttack.getFirst() == SWORD_SLOT, "the first hit is made with the sword");

			// The sword breaks on that hit: its slot stays valid but now holds nothing. The attack cooldown restarts.
			inventory.setItem(SWORD_SLOT, ItemStack.EMPTY);
			int leasesAtBreak = leasedSlots.size();
			player.charge = 0.2F;
			ServerController.TickResult afterBreak = fight.tick(player, now += 50L);
			check(afterBreak.state() == ServerController.State.RUNNING, "the fight goes on after the sword breaks: " + afterBreak);
			check(leasedSlot() == AXE_SLOT, "the next tick leases the spare axe");
			check(inventory.getSelectedSlot() == AXE_SLOT, "the spare axe is held after the sword breaks");
			check(player.attacks.size() == 1, "no swing while the attack cooldown is still charging");
			for (int tick = 0; tick < 5; tick++) {
				fight.tick(player, now += 50L);
				check(leasedSlot() == AXE_SLOT && inventory.getSelectedSlot() == AXE_SLOT,
						"the axe stays selected while recharging (no slot oscillation)");
				check(player.attacks.size() == 1, "still no swing below full charge");
			}

			// Full charge again: the next swing uses the axe on the same target.
			player.charge = 1.0F;
			fight.tick(player, now += 50L);
			check(player.attacks.size() == 2 && player.attacks.getLast() == zombie, "the axe swings at the same zombie");
			check(player.selectedAtAttack.getLast() == AXE_SLOT, "the swing is made with the axe held");
			List<Integer> later = new ArrayList<>();
			for (int tick = 0; tick < 10; tick++) {
				ServerController.TickResult result = fight.tick(player, now += 50L);
				check(result.state() == ServerController.State.RUNNING, "the fight keeps running: " + result);
				later.add(leasedSlot());
			}
			check(later.stream().allMatch(slot -> slot == AXE_SLOT), "subsequent ticks keep the axe: " + later);
			check(leasedSlots.subList(leasesAtBreak, leasedSlots.size()).stream().noneMatch(slot -> slot == SWORD_SLOT),
					"the broken sword's slot is never leased again: " + leasedSlots);
			check(player.attacks.stream().allMatch(entity -> entity == zombie), "every swing stays on the named target");
		}

		void verifyNoPursuit() throws Exception {
			ServerFightController hold = new ServerFightController(zombie, null, 10F, false,
					CombatPlanning.TargetPolicy.NAMED, false, false, 60_000L, 0L);
			int hits = player.attacks.size();
			long now = 0;
			// Within reach it still attacks, including cooldown and backoff phases.
			for (int tick = 0; tick < 20; tick++) {
				hold.tick(player, now += 50L);
				checkNoMovement();
			}
			check(player.attacks.size() > hits, "pursue:false still hits in reach");
			// A retreating/teleporting target must not trigger route search or the five-second stall failure.
			place(unsafe, zombie, new Vec3(0.5D, 61.0D, 8.5D), 0.6D, 1.95D);
			hits = player.attacks.size();
			for (int tick = 0; tick < 120; tick++) {
				check(hold.tick(player, now += 50L).state() == ServerController.State.RUNNING,
						"pursue:false waits for the model's timeout when the target leaves reach");
				checkNoMovement();
			}
			check(player.attacks.size() == hits, "out-of-reach targets cannot be hit from held ground");
		}

		void verifySneaking() throws Exception {
			ServerFightController hold = new ServerFightController(zombie, null, 10F, false,
					CombatPlanning.TargetPolicy.NAMED, false, false, true, false, 60_000L, 0L);
			for (int tick = 1; tick <= 20; tick++) {
				hold.tick(player, tick * 50L);
				checkNoMovement();
				check(controllers().get(server).currentState(agentId).orElseThrow().sneak(), "model-selected crouch stays held");
			}
		}

		void checkNoMovement() throws Exception {
			AgentInputState input = controllers().get(server).currentState(agentId).orElseThrow();
			check(input.forward() == 0 && input.strafe() == 0 && !input.jump() && !input.sprint(),
					"pursue:false leases no chase or backoff movement");
		}

		void close() throws Exception {
			instances().remove(server);
			controllers().remove(server);
		}
	}

	/** Temporarily binds item components and tags, restoring the originals afterwards. */
	private static final class ItemBindings implements AutoCloseable {
		private final List<Runnable> restores = new ArrayList<>();

		void bind(net.minecraft.world.item.Item item, int maxDamage, net.minecraft.tags.TagKey<net.minecraft.world.item.Item> tag)
				throws Exception {
			var holder = item.builtInRegistryHolder();
			var originalComponents = holder.areComponentsBound() ? holder.components() : null;
			var originalTags = holder.tags().toList();
			holder.bindComponents(net.minecraft.core.component.DataComponentMap.builder()
					.set(net.minecraft.core.component.DataComponents.MAX_STACK_SIZE, 1)
					.set(net.minecraft.core.component.DataComponents.MAX_DAMAGE, maxDamage)
					.set(net.minecraft.core.component.DataComponents.DAMAGE, 0).build());
			var bindTags = net.minecraft.core.Holder.Reference.class.getDeclaredMethod("bindTags", java.util.Collection.class);
			bindTags.setAccessible(true);
			List<net.minecraft.tags.TagKey<net.minecraft.world.item.Item>> tags = new ArrayList<>(originalTags);
			tags.add(tag);
			bindTags.invoke(holder, tags);
			restores.add(() -> {
				try {
					bindTags.invoke(holder, originalTags);
					Field components = net.minecraft.core.Holder.Reference.class.getDeclaredField("components");
					components.setAccessible(true);
					if (originalComponents == null) components.set(holder, null);
					else holder.bindComponents(originalComponents);
				} catch (ReflectiveOperationException exception) {
					throw new AssertionError("could not restore item bindings", exception);
				}
			});
		}

		@Override
		public void close() {
			for (Runnable restore : restores.reversed()) restore.run();
		}
	}

	@SuppressWarnings("unchecked")
	private static Map<MinecraftServer, CodexAgentManager> instances() throws Exception {
		Field field = CodexAgentManager.class.getDeclaredField("INSTANCES");
		field.setAccessible(true);
		return (Map<MinecraftServer, CodexAgentManager>) field.get(null);
	}

	@SuppressWarnings("unchecked")
	private static Map<MinecraftServer, LeasedServerInputController> controllers() throws Exception {
		Field field = AgentInputRuntime.class.getDeclaredField("CONTROLLERS");
		field.setAccessible(true);
		return (Map<MinecraftServer, LeasedServerInputController>) field.get(null);
	}

	private static void place(sun.misc.Unsafe unsafe, Entity entity, Vec3 position, double width, double height) throws Exception {
		set(unsafe, entity, Entity.class, "position", position);
		set(unsafe, entity, Entity.class, "blockPosition", BlockPos.containing(position));
		set(unsafe, entity, Entity.class, "bb", new AABB(position.x - width / 2.0D, position.y, position.z - width / 2.0D,
				position.x + width / 2.0D, position.y + height, position.z + width / 2.0D));
	}

	@SuppressWarnings("unchecked")
	private static void health(sun.misc.Unsafe unsafe, LivingEntity entity, float health) throws Exception {
		Field healthField = LivingEntity.class.getDeclaredField("DATA_HEALTH_ID");
		healthField.setAccessible(true);
		EntityDataAccessor<Float> accessor = (EntityDataAccessor<Float>) healthField.get(null);
		Field flagsField = Entity.class.getDeclaredField("DATA_SHARED_FLAGS_ID");
		flagsField.setAccessible(true);
		EntityDataAccessor<Byte> flags = (EntityDataAccessor<Byte>) flagsField.get(null);
		var items = new SynchedEntityData.DataItem<?>[Math.max(accessor.id(), flags.id()) + 1];
		items[accessor.id()] = new SynchedEntityData.DataItem<>(accessor, health);
		items[flags.id()] = new SynchedEntityData.DataItem<>(flags, (byte) 0);
		var constructor = SynchedEntityData.class.getDeclaredConstructor(
				net.minecraft.network.syncher.SyncedDataHolder.class, SynchedEntityData.DataItem[].class);
		constructor.setAccessible(true);
		set(unsafe, entity, Entity.class, "entityData", constructor.newInstance(entity, items));
	}

	private static void set(sun.misc.Unsafe unsafe, Object target, Class<?> owner, String name, Object value) throws Exception {
		unsafe.putObject(target, unsafe.objectFieldOffset(owner.getDeclaredField(name)), value);
	}

	private static void check(boolean condition, String label) {
		if (!condition) throw new AssertionError(label);
		assertions++;
	}

	private static final class FightLevel extends ServerLevel {
		// 26.3 entities take their ID from the level, and ServerLevel asks its (absent) chunk source.
		private int fixtureEntityIds = 100_000;
		@Override public int getNextEntityId() { return ++fixtureEntityIds; }
		private MinecraftServer server;
		private net.minecraft.core.RegistryAccess registries;
		private List<Entity> entities;

		private FightLevel() {
			super(null, Runnable::run, null, null, Level.OVERWORLD, null, false, 0L, List.of(), false);
		}

		@Override public MinecraftServer getServer() { return server; }
		@Override public long getGameTime() { return 1_000L; }
		@Override public boolean hasChunkAt(BlockPos position) { return true; }
		@Override public int getHeight() { return 384; }
		@Override public net.minecraft.core.RegistryAccess registryAccess() { return registries; }
		@Override public boolean hasChunk(int x, int z) { return true; }
		@Override public <T extends Entity> List<T> getEntitiesOfClass(Class<T> type, AABB bounds,
				java.util.function.Predicate<? super T> predicate) {
			return entities.stream().filter(type::isInstance).map(type::cast)
					.filter(entity -> entity.getBoundingBox().intersects(bounds)).filter(predicate).toList();
		}
		@Override public int getMinY() { return -64; }
		@Override public int getMaxY() { return 320; }
		@Override public net.minecraft.world.level.material.FluidState getFluidState(BlockPos position) {
			return net.minecraft.world.level.material.Fluids.EMPTY.defaultFluidState();
		}
		@Override public BlockState getBlockState(BlockPos position) {
			return position.getY() < 64 ? Blocks.STONE.defaultBlockState() : Blocks.AIR.defaultBlockState();
		}
	}

	private static final class FightPlayer extends ServerPlayer {
		private FightLevel fixtureLevel;
		private float charge;
		private long lastTickTime;
		private List<Entity> attacks;
		private List<Integer> selectedAtAttack;

		private FightPlayer() {
			super(null, null, null, null);
		}

		@Override public ServerLevel level() { return fixtureLevel; }
		@Override public boolean isAlive() { return true; }
		@Override public boolean isUsingItem() { return false; }
		@Override public boolean isSpectator() { return false; }
		@Override public boolean isCreative() { return false; }
		@Override public boolean onGround() { return true; }
		@Override public boolean isInWater() { return false; }
		@Override public boolean isUnderWater() { return false; }
		@Override public boolean isInLava() { return false; }
		@Override public boolean onClimbable() { return false; }
		@Override public float getHealth() { return 20.0F; }
		@Override public int getAirSupply() { return 300; }
		@Override public float getAttackStrengthScale(float partialTick) { return charge; }
		@Override public double entityInteractionRange() { return 3.0D; }
		@Override public boolean swing(net.minecraft.world.InteractionHand hand, net.minecraft.world.item.component.SwingAnimation animation, boolean toSelf) { return true; }

		@Override
		public void attack(Entity target) {
			if (attacks == null) attacks = new ArrayList<>();
			if (selectedAtAttack == null) selectedAtAttack = new ArrayList<>();
			attacks.add(target);
			selectedAtAttack.add(getInventory().getSelectedSlot());
		}
	}

	private static final class FightZombie extends Zombie {
		private FightLevel fixtureLevel;

		private FightZombie() {
			super(EntityTypes.ZOMBIE, null);
		}

		@Override public Level level() { return fixtureLevel; }
		@Override public boolean isAlive() { return true; }
		@Override public boolean isUsingItem() { return false; }
		@Override public float getHealth() { return 20.0F; }
		@Override public boolean isInvisibleTo(Player observer) { return false; }
	}
}
