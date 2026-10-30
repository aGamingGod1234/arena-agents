package dev.agaminggod.arenaagents.server.runtime;

import dev.agaminggod.arenaagents.agent.AgentDomainException;
import dev.agaminggod.arenaagents.server.runtime.controller.ServerController;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.resources.Identifier;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.phys.AABB;

/** Regressions from live-run-2: equivalent stacks, prior collection, and physical placement refusals. */
public final class FailureOutcomeVerification {
	private static final java.util.concurrent.atomic.AtomicInteger UNSAFE_ENTITY_IDS = new java.util.concurrent.atomic.AtomicInteger(200_000);
	private FailureOutcomeVerification() { }

	public static int verify() {
		try (Components components = new Components()) {
			components.bind(Items.TORCH);
			components.bind(Items.OAK_LOG);
			components.bind(Items.STONE_PICKAXE);
			return verifyOutcomes() + verifyClearingExecutor() + verifyPickupLookup() + verifyMenuKnowledge();
		}
	}

	private static int verifyOutcomes() {
		int assertions = 0;
		List<ItemStack> inventory = new ArrayList<>(Collections.nCopies(41, ItemStack.EMPTY));
		inventory.set(2, new ItemStack(Items.TORCH, 4));
		inventory.set(7, new ItemStack(Items.TORCH, 64));
		inventory.set(12, new ItemStack(Items.TORCH, 8));
		check(ServerActionExecutor.selectionSlot(inventory.size(), inventory::get, Identifier.parse("minecraft:torch")) == 2,
				"equal components with different counts select the first hotbar stack"); assertions++;
		inventory.set(2, ItemStack.EMPTY);
		check(ServerActionExecutor.selectionSlot(inventory.size(), inventory::get, Identifier.parse("minecraft:torch")) == 7,
				"an equivalent backpack stack does not hide the selectable hotbar stack"); assertions++;
		inventory.set(7, ItemStack.EMPTY);
		check(ServerActionExecutor.selectionSlot(inventory.size(), inventory::get, Identifier.parse("minecraft:torch")) == 12,
				"backpack-only items retain the slot needed for explicit select_tool"); assertions++;
		inventory.set(0, new ItemStack(Items.STONE_PICKAXE));
		ItemStack worn = new ItemStack(Items.STONE_PICKAXE);
		worn.set(net.minecraft.core.component.DataComponents.DAMAGE, 10);
		inventory.set(1, worn);
		try {
			ServerActionExecutor.selectionSlot(inventory.size(), inventory::get, Identifier.parse("minecraft:stone_pickaxe"));
			throw new AssertionError("different durability must retain the model's slot choice");
		} catch (AgentDomainException expected) {
			check(expected.code().equals("AMBIGUOUS_ITEM"), "different durability is ambiguous"); assertions++;
		}

		inventory.set(1, new ItemStack(Items.STONE_PICKAXE));
		inventory.get(1).set(net.minecraft.core.component.DataComponents.CUSTOM_NAME, net.minecraft.network.chat.Component.literal("Named pickaxe"));
		try {
			ServerActionExecutor.selectionSlot(inventory.size(), inventory::get, Identifier.parse("minecraft:stone_pickaxe"));
			throw new AssertionError("different names must retain the model's slot choice");
		} catch (AgentDomainException expected) {
			check(expected.code().equals("AMBIGUOUS_ITEM"), "same wear with a different custom name is ambiguous"); assertions++;
		}

		ServerController collected = ServerActionExecutor.collectedPickup("Collected earlier: 1 minecraft:oak_log; no longer held");
		ServerController.TickResult receipt = collected.tick(null, 1L);
		check(receipt.state() == ServerController.State.SUCCEEDED && receipt.reasonCode().equals("ITEM_ALREADY_PICKED_UP"),
				"a proven historical collection is successful even after the item was used"); assertions++;
		check(receipt.message().contains("no longer held"), "the receipt does not fabricate current holdings"); assertions++;
		check(collected.tick(null, 2L).equals(receipt), "repeating an acknowledged receipt performs no inventory mutation"); assertions++;
		try {
			ServerActionExecutor.collectedPickup(null);
			throw new AssertionError("missing evidence must never become pickup success");
		} catch (NullPointerException expected) { assertions++; }

		for (var state : List.of(Blocks.AIR.defaultBlockState(), Blocks.GRASS_BLOCK.defaultBlockState())) {
			try {
				ServerActionExecutor.requireBreakIdentity(BlockPos.ZERO, state, "minecraft:dirt");
				throw new AssertionError("an empty or replaced target must not count as our successful break");
			} catch (AgentDomainException expected) {
				check(expected.code().equals(state.isAir() ? "TARGET_AIR" : "TARGET_CHANGED"),
						"air and changed identity keep their distinct outcomes"); assertions++;
				check(expected.getMessage().contains(state.isAir() ? "no removal or drops credited" : "no target substituted"),
						"the model is told why a retry needs different facts"); assertions++;
			}
		}
		ServerActionExecutor.requireBreakIdentity(BlockPos.ZERO, Blocks.DIRT.defaultBlockState(), "minecraft:dirt");
		assertions++;

		BlockPos destination = new BlockPos(120, 70, -652);
		AABB standingInside = new AABB(120.2, 70, -651.8, 120.8, 71.8, -651.2);
		check(ServerActionExecutor.placementBodyObstruction(EmptyBlockGetter.INSTANCE, destination,
				Blocks.CRAFTING_TABLE.defaultBlockState(), standingInside).contains("move clear"),
				"a real vanilla full-block collision explains the close placement refusal"); assertions++;
		check(ServerActionExecutor.placementBodyObstruction(EmptyBlockGetter.INSTANCE, destination,
				Blocks.CRAFTING_TABLE.defaultBlockState(), new AABB(120.94, 69.8, -651.7, 121.54, 71.6, -651.1))
				.contains("body x 120.94..121.54 y 69.80..71.60 z -651.70..-651.10"),
				"the refusal states the body box so a jump or step can be timed against the cell"); assertions++;
		check(ServerActionExecutor.placementBodyObstruction(EmptyBlockGetter.INSTANCE, destination,
				Blocks.CRAFTING_TABLE.defaultBlockState(), standingInside.move(2, 0, 0)).isEmpty(),
				"a nearby player outside the cell is not blamed"); assertions++;
		check(ServerActionExecutor.placementBodyObstruction(EmptyBlockGetter.INSTANCE, destination,
				Blocks.SHORT_GRASS.defaultBlockState(), standingInside).isEmpty(),
				"noncolliding placed outlines do not invent a body collision"); assertions++;
		check(ServerActionExecutor.missingPlacementSupport(destination, Direction.UP).contains("120,70,-652 (requested face up)"),
				"support feedback names the requested destination and face"); assertions++;
		check(AdvancedInteractionService.missingMenuMessage("minecraft:air", destination).contains("minecraft:air at 120,70,-652 has no menu"),
				"a missing furnace reports the current block rather than suggesting an unsupported furnace menu"); assertions++;
		return assertions;
	}

	/** Exercise the executor's actual configure/receipt/retry transitions, with no simulated world mutation. */
	private static int verifyClearingExecutor() {
		try {
			Class<?> actionType = Class.forName(ServerActionExecutor.class.getName() + "$ActiveAction");
			Class<?> targetType = Class.forName(ServerActionExecutor.class.getName() + "$BreakTarget");
			var target = targetType.getDeclaredConstructor(String.class, net.minecraft.world.phys.Vec3.class, BlockPos.class, String.class);
			target.setAccessible(true);
			var factory = actionType.getDeclaredMethod("breakBlock", ServerActionRequest.class, net.minecraft.server.level.ServerPlayer.class,
					BlockPos.class, long.class, String.class, String.class, net.minecraft.world.phys.Vec3.class);
			factory.setAccessible(true);
			var configure = actionType.getDeclaredMethod("configureBreakTarget", targetType); configure.setAccessible(true);
			var advance = actionType.getDeclaredMethod("advancePlantClearing", net.minecraft.world.level.block.state.BlockState.class,
					ServerActionExecutor.BlockBreakReceipt.class, java.util.function.Supplier.class); advance.setAccessible(true);
			var retry = actionType.getDeclaredMethod("retryBreakTarget", targetType); retry.setAccessible(true);
			var protection = actionType.getDeclaredField("plantProtection"); protection.setAccessible(true);
			var clearing = actionType.getDeclaredField("clearingPlant"); clearing.setAccessible(true);
			var cleared = actionType.getDeclaredField("clearedPlants"); cleared.setAccessible(true);
			var aim = new net.minecraft.world.phys.Vec3(2.5, .5, .5);
			Object direct = target.newInstance("minecraft:stone", aim, null, null);
			int checks = 0;
			for (var block : new net.minecraft.world.level.block.Block[] { Blocks.SHORT_GRASS, Blocks.LILAC, Blocks.ROSE_BUSH,
					Blocks.PEONY, Blocks.SUNFLOWER, Blocks.TALL_GRASS, Blocks.LARGE_FERN }) {
				var halves = block instanceof net.minecraft.world.level.block.DoublePlantBlock
						? net.minecraft.world.level.block.state.properties.DoubleBlockHalf.values()
						: new net.minecraft.world.level.block.state.properties.DoubleBlockHalf[] { null };
				for (var half : halves) {
					var state = half == null ? block.defaultBlockState() : block.defaultBlockState().setValue(net.minecraft.world.level.block.DoublePlantBlock.HALF, half);
					BlockPos at = half == net.minecraft.world.level.block.state.properties.DoubleBlockHalf.UPPER ? BlockPos.ZERO.above() : BlockPos.ZERO;
					String id = net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(block).toString();
					Object plant = target.newInstance("minecraft:stone", aim, at, id);
					Object action = factory.invoke(null, null, null, new BlockPos(2, 0, 0), 1000L, "minecraft:stone", "minecraft:stone", aim);
					expectDomain("PROTECTION_DENIED", () -> configure.invoke(action, plant)); checks++;
					java.util.concurrent.atomic.AtomicInteger gates = new java.util.concurrent.atomic.AtomicInteger();
					protection.set(action, (java.util.function.Consumer<BlockPos>) pos -> { check(pos.equals(at), "protection checks exact half"); gates.incrementAndGet(); });
					configure.invoke(action, plant);
					java.util.function.Supplier<Object> next = () -> direct;
					check(!(boolean) advance.invoke(action, state, null, next) && gates.get() == 2,
							"unchanged plant stays in the attack phase and rechecks protection"); checks++;
					protection.set(action, (java.util.function.Consumer<BlockPos>) pos -> { throw new AgentDomainException("PROTECTION_DENIED", "revoked"); });
					expectDomain("PROTECTION_DENIED", () -> advance.invoke(action, state, null, next)); checks++;
					protection.set(action, (java.util.function.Consumer<BlockPos>) pos -> { });
					var air = Blocks.AIR.defaultBlockState();
					expectDomain("TARGET_CHANGED", () -> advance.invoke(action, air, null, next)); checks++;
					var receipt = new ServerActionExecutor.BlockBreakReceipt(at, state, air);
					check((boolean) advance.invoke(action, air, receipt, next) && clearing.get(action) == null
							&& ((List<?>) cleared.get(action)).size() == 1, "owned clear advances to the requested block's mining aim"); checks++;
					check((boolean) retry.invoke(action, direct) && (boolean) retry.invoke(action, direct)
							&& !(boolean) retry.invoke(action, direct), "a permanently missed direct aim stops after two retries"); checks++;
					for (int i = 1; i < 8; i++) {
						configure.invoke(action, plant);
						check((boolean) advance.invoke(action, air, new ServerActionExecutor.BlockBreakReceipt(at, state, air), next), "fresh owned receipts advance clearing"); checks++;
					}
					expectDomain("TARGET_NOT_VISIBLE", () -> configure.invoke(action, plant)); checks++;
					check(((List<?>) cleared.get(action)).size() == 8, "no ninth plant is cleared"); checks++;
					Object denied = factory.invoke(null, null, null, new BlockPos(2, 0, 0), 1000L, "minecraft:stone", "minecraft:stone", aim);
					expectDomain("PROTECTION_DENIED", () -> retry.invoke(denied, plant)); checks++;
				}
			}
			return checks;
		} catch (ReflectiveOperationException e) { throw new AssertionError(e); }
	}

	private static int verifyPickupLookup() {
		try {
			var player = allocate(ReceiptPlayer.class);
			player.world = allocate(ReceiptWorld.class);
			player.inventory = new net.minecraft.world.entity.player.Inventory(player, new net.minecraft.world.entity.EntityEquipment());
			var find = ServerActionExecutor.class.getDeclaredMethod("findItem", net.minecraft.server.level.ServerPlayer.class, String.class);
			find.setAccessible(true);
			var drop = java.util.UUID.randomUUID();
			expectDomain("ITEM_NOT_FOUND", () -> find.invoke(null, player, "invalid-uuid"));
			dev.agaminggod.arenaagents.server.perception.PickupReceipts.record(player, drop, new ItemStack(Items.OAK_LOG), 1);
			for (int held : new int[] { 1, 0 }) {
				player.inventory.setItem(0, held == 0 ? ItemStack.EMPTY : new ItemStack(Items.OAK_LOG));
				for (int repeat = 0; repeat < 2; repeat++) {
					try { find.invoke(null, player, drop.toString()); throw new AssertionError("owned receipt must be recognized through findItem"); }
					catch (java.lang.reflect.InvocationTargetException e) {
						var domain = (AgentDomainException) e.getCause();
						check(domain.code().equals("ITEM_ALREADY_PICKED_UP"), "exact missing UUID resolves its owned receipt");
						var result = ServerActionExecutor.collectedPickup(domain.getMessage()).tick(player, 1L);
						check(result.state() == ServerController.State.SUCCEEDED && (held > 0 || result.message().contains("no longer held")), "historical pickup succeeds with honest holdings");
					}
					check(player.inventory.getItem(0).getCount() == held
							&& dev.agaminggod.arenaagents.server.perception.PickupReceipts.collected(player, drop) == 1,
							"acknowledging pickup never reapplies an inventory gain or receipt delta");
				}
			}
			return 13;
		} catch (ReflectiveOperationException e) { throw new AssertionError(e); }
	}

	private static int verifyMenuKnowledge() {
		BlockPos at = BlockPos.ZERO;
		var memory = new dev.agaminggod.arenaagents.server.perception.SeenTerrain.Memory<net.minecraft.world.level.block.state.BlockState>();
		boolean[] visible = { false };
		var live = new net.minecraft.world.level.block.state.BlockState[] { Blocks.DIAMOND_BLOCK.defaultBlockState() };
		var source = new dev.agaminggod.arenaagents.server.perception.SeenTerrain.Source<net.minecraft.world.level.block.state.BlockState>() {
			public net.minecraft.world.level.block.state.BlockState live(int x, int y, int z) { return live[0]; }
			public boolean sees(int x, int y, int z) { return visible[0]; }
		};
		var unseen = new dev.agaminggod.arenaagents.server.perception.SeenTerrain.Reader<>(memory, source, 0L, null);
		check(!AdvancedInteractionService.missingMenuMessage(unseen, at).contains("minecraft:"), "unknown cell returns no live identity");
		visible[0] = true;
		var seen = new dev.agaminggod.arenaagents.server.perception.SeenTerrain.Reader<>(memory, source, 1L, null);
		check(AdvancedInteractionService.missingMenuMessage(seen, at).contains("minecraft:diamond_block"), "currently seen identity is available");
		visible[0] = false; live[0] = Blocks.GOLD_BLOCK.defaultBlockState();
		var remembered = new dev.agaminggod.arenaagents.server.perception.SeenTerrain.Reader<>(memory, source, 2L, null);
		String message = AdvancedInteractionService.missingMenuMessage(remembered, at);
		check(message.contains("Last perceived minecraft:diamond_block") && !message.contains("minecraft:gold_block"), "hidden replacement never leaks through remembered coordinates");
		return 3;
	}

	private interface ReflectiveCall { void run() throws ReflectiveOperationException; }
	private static void expectDomain(String code, ReflectiveCall operation) throws ReflectiveOperationException {
		try { operation.run(); throw new AssertionError("expected " + code); }
		catch (java.lang.reflect.InvocationTargetException e) {
			if (!(e.getCause() instanceof AgentDomainException domain)) throw e;
			check(domain.code().equals(code), "expected " + code + " got " + domain.code());
		}
	}
	private static <T> T allocate(Class<T> type) throws ReflectiveOperationException {
		var field = sun.misc.Unsafe.class.getDeclaredField("theUnsafe"); field.setAccessible(true);
		Object allocated = ((sun.misc.Unsafe) field.get(null)).allocateInstance(type); if (allocated instanceof net.minecraft.world.entity.Entity entity) entity.setId(UNSAFE_ENTITY_IDS.incrementAndGet()); return type.cast(allocated); // 26.3 assigns entity IDs in the constructor.
	}
	private static final class ReceiptPlayer extends net.minecraft.server.level.ServerPlayer {
		ReceiptWorld world;
		net.minecraft.world.entity.player.Inventory inventory;
		private ReceiptPlayer() { super(null, null, null, null); }
		@Override public net.minecraft.server.level.ServerLevel level() { return world; }
		@Override public net.minecraft.world.entity.player.Inventory getInventory() { return inventory; }
	}
	private static final class ReceiptWorld extends net.minecraft.server.level.ServerLevel {
		// 26.3 entities take their ID from the level, and ServerLevel asks its (absent) chunk source.
		private int fixtureEntityIds = 100_000;
		@Override public int getNextEntityId() { return ++fixtureEntityIds; }
		private ReceiptWorld() { super(null, null, null, null, null, null, false, 0, List.of(), false); }
		@Override public net.minecraft.world.entity.Entity getEntity(java.util.UUID id) { return null; }
	}

	private static final class Components implements AutoCloseable {
		private final java.util.Map<net.minecraft.core.Holder.Reference<net.minecraft.world.item.Item>,
				net.minecraft.core.component.DataComponentMap> originals = new java.util.IdentityHashMap<>();

		void bind(net.minecraft.world.item.Item item) {
			var holder = item.builtInRegistryHolder();
			originals.put(holder, holder.areComponentsBound() ? holder.components() : null);
			if (!holder.areComponentsBound()) holder.bindComponents(net.minecraft.core.component.DataComponentMap.builder()
					.set(net.minecraft.core.component.DataComponents.MAX_STACK_SIZE, 64).build());
		}

		@Override public void close() {
			try {
				var field = net.minecraft.core.Holder.Reference.class.getDeclaredField("components");
				field.setAccessible(true);
				for (var entry : originals.entrySet()) field.set(entry.getKey(), entry.getValue());
			} catch (ReflectiveOperationException exception) { throw new AssertionError(exception); }
		}
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
	}
}
