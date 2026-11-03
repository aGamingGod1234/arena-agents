package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.server.runtime.InventoryRoom;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.core.Holder;
import net.minecraft.core.HolderSet;
import net.minecraft.core.component.DataComponentMap;
import net.minecraft.core.component.DataComponents;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.PlayerEquipment;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.player.Abilities;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.component.Tool;
import net.minecraft.world.item.enchantment.Enchantment;
import net.minecraft.world.item.enchantment.ItemEnchantments;
import net.minecraft.world.level.block.Blocks;

/** F13: real tool choice and vanilla pickup paths, plus the production admission/start ordering. */
public final class VeinSelectedToolInventoryVerification {
	private static int assertions;

	public static void main(String[] args) throws Exception {
		System.out.println("PASS: " + verify() + " vein selected-tool inventory assertions");
	}

	public static int verify() throws Exception {
		assertions = 0;
		verifyStartOrdering();
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		Map<Holder.Reference<Item>, DataComponentMap> originals = new LinkedHashMap<>();
		try {
			bind(originals, Items.IRON_PICKAXE, 6.0F);
			bind(originals, Items.DIAMOND_PICKAXE, 8.0F);
			for (Item item : List.of(Items.RAW_IRON, Items.IRON_ORE, Items.DIRT)) bind(originals, item, 0.0F);
			ServerPlayer player = allocate(ServerPlayer.class);
			player.setId(1018);
			set(Player.class, player, "abilities", new Abilities());
			var equipment = new PlayerEquipment(player);
			set(LivingEntity.class, player, "equipment", equipment);
			Inventory inventory = new Inventory(player, equipment);
			set(Player.class, player, "inventory", inventory);
			for (int i = 0; i < Inventory.INVENTORY_SIZE; i++) inventory.setItem(i, new ItemStack(Items.DIRT, 64));
			inventory.setSelectedSlot(0);
			inventory.setItem(0, new ItemStack(Items.IRON_PICKAXE));
			ItemStack silk = new ItemStack(Items.DIAMOND_PICKAXE);
			// Datapacks are not loaded: an enchantment marker exercises forBreak's enchanted-tool rule.
			var enchantments = new ItemEnchantments.Mutable(ItemEnchantments.EMPTY);
			enchantments.set(Holder.direct(allocate(Enchantment.class)), 1);
			silk.set(DataComponents.ENCHANTMENTS, enchantments.toImmutable());
			inventory.setItem(3, silk);
			inventory.setItem(10, new ItemStack(Items.RAW_IRON, 63));
			ItemStack ordinaryDrop = new ItemStack(Items.RAW_IRON), silkDrop = new ItemStack(Items.IRON_ORE);
			check(inventory.getFreeSlot() == -1, "main inventory is full");
			check(InventoryRoom.canTake(player, ordinaryDrop), "old held-tool raw iron gate admits the block");
			var choice = MiningTools.forBreak(inventory, Blocks.IRON_ORE.defaultBlockState());
			check(choice.slot() == 3, "faster carried enchanted diamond pick beats held iron pick");
			inventory.setSelectedSlot(choice.slot());
			check(player.getMainHandItem() == silk, "admission holds the exact chosen tool");
			check(!InventoryRoom.canTake(player, silkDrop), "chosen-tool iron ore cannot be picked up: stop before swing");
			check(MiningTools.forBreak(inventory, Blocks.IRON_ORE.defaultBlockState()).slot() == 3,
					"the held enchanted tool remains the break tool");
			equipment.set(EquipmentSlot.OFFHAND, new ItemStack(Items.IRON_ORE, 63));
			check(InventoryRoom.canTake(player, silkDrop), "vanilla pickup includes a matching offhand stack");
			equipment.set(EquipmentSlot.OFFHAND, new ItemStack(Items.IRON_ORE, 64));
			check(!InventoryRoom.canTake(player, silkDrop), "a full offhand stack supplies no pickup room");
			inventory.setItem(12, new ItemStack(Items.IRON_ORE, 63));
			check(InventoryRoom.canTake(player, silkDrop), "matching main stack admits the chosen-tool drop");
			inventory.setItem(12, ItemStack.EMPTY);
			check(InventoryRoom.canTake(player, silkDrop), "an empty main slot admits the chosen-tool drop");
		} finally {
			for (var entry : originals.entrySet()) set(Holder.Reference.class, entry.getKey(), "components", entry.getValue());
		}
		return assertions;
	}

	private static void verifyStartOrdering() throws Exception {
		Path root = Path.of(System.getProperty("arenaagents.f13.sourceRoot", "."));
		Path server = root.resolve("src/main/java/dev/agaminggod/arenaagents/server/runtime");
		String controller = Files.readString(server.resolve("controller/ServerVeinController.java"));
		String start = controller.substring(controller.indexOf("private TickResult startBreak("), controller.indexOf("private TickResult breakTick("));
		check(start.indexOf("environment.breakBlock(") < start.indexOf("inventoryRoom("),
				"capacity must be checked after admission selects the final tool");
		check(start.indexOf("inventoryRoom(") < start.indexOf("return breakTick("), "capacity must be checked before the first swing");
		check(start.contains("if (room != null) return room;"), "capacity refusal stops the sub-action");
		String executor = Files.readString(server.resolve("ServerActionExecutor.java"));
		String admission = executor.substring(executor.indexOf("private ServerController veinBreak("), executor.indexOf("private ServerDigController digController("));
		check(admission.contains("mine.breakToolNote = selectBreakTool(body, body.level().getBlockState(at))"),
				"vein admission selects and records the actual held tool");
		check(!admission.contains("mine.selectsBreakTool = true"), "vein start cannot select a different tool after the capacity gate");
		check(controller.contains("InventoryRoom.canTake(player, drop)"), "veins use vanilla pickup capacity including offhand");
	}

	private static void bind(Map<Holder.Reference<Item>, DataComponentMap> originals, Item item, float speed) {
		var holder = item.builtInRegistryHolder();
		originals.put(holder, holder.areComponentsBound() ? holder.components() : null);
		var components = DataComponentMap.builder().set(DataComponents.MAX_STACK_SIZE, speed > 0 ? 1 : 64);
		if (speed > 0) components.set(DataComponents.TOOL, new Tool(List.of(Tool.Rule.minesAndDrops(
				HolderSet.direct(Blocks.IRON_ORE.builtInRegistryHolder()), speed)), 1.0F, 1, true));
		holder.bindComponents(components.build());
	}

	private static void set(Class<?> owner, Object target, String name, Object value) throws Exception {
		var field = owner.getDeclaredField(name);
		field.setAccessible(true);
		field.set(target, value);
	}

	@SuppressWarnings("unchecked")
	private static <T> T allocate(Class<T> type) throws Exception {
		var field = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
		field.setAccessible(true);
		return (T) ((sun.misc.Unsafe) field.get(null)).allocateInstance(type);
	}

	private static void check(boolean value, String reason) {
		if (!value) throw new AssertionError(reason);
		assertions++;
	}
}
