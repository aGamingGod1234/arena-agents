package dev.agaminggod.arenaagents.server.runtime.controller;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.core.Holder;
import net.minecraft.core.HolderSet;
import net.minecraft.core.component.DataComponentMap;
import net.minecraft.core.component.DataComponents;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.EntityEquipment;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.component.Tool;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

/**
 * break_block's own tool choice (and mine_vein's): the dig_to rule over the whole inventory. Before it, every block cost
 * a select_tool call and a mine call, and an ore broken with the wrong pick in hand dropped nothing even with the right
 * pick in the hotbar. Item tool rules are bound for the fixture only; verifyCore loads no item datapack.
 */
public final class MiningToolsVerification {
	private static int assertions;

	private MiningToolsVerification() {
	}

	public static void main(String[] arguments) {
		System.out.println("PASS: " + verify() + " mining tool assertions");
	}

	public static int verify() {
		assertions = 0;
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		Map<Holder.Reference<Item>, DataComponentMap> bindings = new LinkedHashMap<>();
		try {
			List<Block> picks = List.of(Blocks.STONE, Blocks.COAL_ORE, Blocks.IRON_ORE, Blocks.DIAMOND_ORE);
			bind(Items.WOODEN_PICKAXE, 59, bindings, Tool.Rule.deniesDrops(set(Blocks.IRON_ORE, Blocks.DIAMOND_ORE)), Tool.Rule.minesAndDrops(set(picks), 2.0F));
			bind(Items.STONE_PICKAXE, 131, bindings, Tool.Rule.deniesDrops(set(Blocks.DIAMOND_ORE)), Tool.Rule.minesAndDrops(set(picks), 4.0F));
			bind(Items.IRON_PICKAXE, 250, bindings, Tool.Rule.minesAndDrops(set(picks), 6.0F));
			bind(Items.STONE_AXE, 131, bindings, Tool.Rule.minesAndDrops(set(List.of(Blocks.OAK_LOG)), 4.0F));
			verifyChoices();
		} catch (ReflectiveOperationException failure) {
			throw new AssertionError("mining tool fixture failed", failure);
		} finally {
			for (var entry : bindings.entrySet()) {
				try {
					var field = Holder.Reference.class.getDeclaredField("components");
					field.setAccessible(true);
					field.set(entry.getKey(), entry.getValue());
				} catch (ReflectiveOperationException failure) {
					throw new AssertionError("restore mining tool fixture", failure);
				}
			}
		}
		return assertions;
	}

	private static void verifyChoices() throws ReflectiveOperationException {
		BlockState iron = Blocks.IRON_ORE.defaultBlockState(), diamond = Blocks.DIAMOND_ORE.defaultBlockState();
		BlockState stone = Blocks.STONE.defaultBlockState(), log = Blocks.OAK_LOG.defaultBlockState(), dirt = Blocks.DIRT.defaultBlockState();

		// The wrong pick in hand, the right one on the hotbar: before, break_block swung the wooden pick and lost the ore.
		Inventory inventory = inventory();
		inventory.setItem(0, new ItemStack(Items.WOODEN_PICKAXE));
		inventory.setItem(3, new ItemStack(Items.STONE_PICKAXE));
		inventory.setSelectedSlot(0);
		check(!inventory.getItem(0).isCorrectToolForDrops(iron), "the fixture's wooden pickaxe drops no iron ore (vanilla tier rule)");
		MiningTools.Choice ironChoice = MiningTools.forBreak(inventory, iron);
		check(ironChoice.slot() == 3 && ironChoice.changes(inventory) && !ironChoice.worn(), "iron ore is mined with the hotbar stone pickaxe, not the held wooden one: " + ironChoice);
		check("stone_pickaxe".equals(ironChoice.itemName(inventory)), "the choice names the tool it holds");
		check(MiningTools.forBreak(inventory, stone).slot() == 3, "stone is mined with the faster stone pickaxe");
		check(!MiningTools.wastesOre(inventory, iron), "a carried stone pickaxe harvests iron ore: it is swung");

		// The right pick only in the main inventory: it is swapped in (dig_to, hotbar only, refuses the same block).
		inventory = inventory();
		inventory.setItem(0, new ItemStack(Items.WOODEN_PICKAXE));
		inventory.setItem(20, new ItemStack(Items.IRON_PICKAXE));
		inventory.setSelectedSlot(0);
		check(MiningTools.forBreak(inventory, iron).slot() == 20, "a main-inventory iron pickaxe is chosen for iron ore");
		check(MiningTools.slot(inventory, iron, 9, -1, false) == MiningTools.NONE, "dig_to's hotbar rule is unchanged: no hotbar tool harvests it");
		check(MiningTools.forBreak(inventory, diamond).slot() == 20, "diamond ore takes the iron pickaxe");

		// A held tool as fast as any other stays in hand: no needless slot change.
		inventory = inventory();
		inventory.setItem(1, new ItemStack(Items.STONE_PICKAXE));
		inventory.setItem(4, new ItemStack(Items.STONE_PICKAXE));
		inventory.setSelectedSlot(4);
		MiningTools.Choice tie = MiningTools.forBreak(inventory, stone);
		check(tie.slot() == 4 && !tie.changes(inventory), "a tie keeps the held pickaxe: " + tie);
		check(MiningTools.slot(inventory, stone, 9, -1, false) == 1, "dig_to keeps its lowest-slot rule");

		// Worn tools: dig_to refuses them; one block still breaks with the last uses.
		inventory = inventory();
		ItemStack worn = new ItemStack(Items.STONE_PICKAXE);
		worn.setDamageValue(worn.getMaxDamage() - ServerDigController.WORN_USES);
		inventory.setItem(2, worn);
		inventory.setSelectedSlot(0);
		check(MiningTools.slot(inventory, iron, 9, -1, false) == MiningTools.WORN, "dig_to does not swing a worn pickaxe");
		MiningTools.Choice last = MiningTools.forBreak(inventory, iron);
		check(last.slot() == 2 && last.worn(), "one ore still breaks with the worn pickaxe's last uses: " + last);
		inventory.setItem(5, new ItemStack(Items.WOODEN_PICKAXE));
		check(MiningTools.forBreak(inventory, stone).slot() == 5, "a sound slower pickaxe beats a worn faster one");

		// No carried tool harvests the ore: break_block refuses instead of destroying it; plain stone is still the model's call.
		inventory = inventory();
		inventory.setItem(0, new ItemStack(Items.STONE_PICKAXE));
		inventory.setSelectedSlot(0);
		check(MiningTools.forBreak(inventory, diamond).slot() == MiningTools.NONE, "a stone pickaxe cannot harvest diamond ore");
		check(MiningTools.wastesOre(inventory, diamond), "diamond ore with only a stone pickaxe is a wasted ore: not swung");
		inventory.setItem(0, ItemStack.EMPTY);
		check(MiningTools.forBreak(inventory, stone).slot() == MiningTools.NONE && !MiningTools.wastesOre(inventory, stone),
				"stone by hand drops nothing but is not an ore: break_block still swings when asked");

		// Other kinds: an axe for a log, the hand for dirt with no shovel.
		inventory = inventory();
		inventory.setItem(7, new ItemStack(Items.STONE_AXE));
		inventory.setItem(1, new ItemStack(Items.IRON_PICKAXE));
		inventory.setSelectedSlot(1);
		check(MiningTools.forBreak(inventory, log).slot() == 7, "a log is cut with the axe, not the held pickaxe");
		check(MiningTools.forBreak(inventory, dirt).slot() == MiningTools.KEEP, "dirt with no shovel keeps the hand");
		check(!MiningTools.forBreak(inventory, dirt).changes(inventory), "keeping the hand changes nothing");

		// A held enchanted tool that harvests the block is the model's choice (silk touch, fortune): it stays.
		inventory = inventory();
		ItemStack enchanted = new ItemStack(Items.WOODEN_PICKAXE);
		var enchantments = new net.minecraft.world.item.enchantment.ItemEnchantments.Mutable(net.minecraft.world.item.enchantment.ItemEnchantments.EMPTY);
		enchantments.set(Holder.direct(allocate(net.minecraft.world.item.enchantment.Enchantment.class)), 1);
		enchanted.set(DataComponents.ENCHANTMENTS, enchantments.toImmutable());
		inventory.setItem(0, enchanted);
		inventory.setItem(3, new ItemStack(Items.IRON_PICKAXE));
		inventory.setSelectedSlot(0);
		check(enchanted.isEnchanted(), "the fixture pickaxe is enchanted");
		check(MiningTools.forBreak(inventory, stone).slot() == 0, "a held enchanted pickaxe that harvests stone stays in hand");
		check(MiningTools.forBreak(inventory, iron).slot() == 3, "an enchanted pickaxe too weak for the ore still gives way to one that harvests it");
	}

	private static Inventory inventory() throws ReflectiveOperationException {
		ServerPlayer player = allocate(ServerPlayer.class);
		player.setId(1017); // 26.3 assigns entity IDs in the constructor, which Unsafe allocation skips.
		Inventory inventory = new Inventory(player, new EntityEquipment());
		var field = Player.class.getDeclaredField("inventory");
		field.setAccessible(true);
		field.set(player, inventory);
		return inventory;
	}

	@SuppressWarnings("unchecked")
	private static <T> T allocate(Class<T> type) throws ReflectiveOperationException {
		var access = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
		access.setAccessible(true);
		return (T) ((sun.misc.Unsafe) access.get(null)).allocateInstance(type);
	}

	private static HolderSet<Block> set(Block... blocks) {
		return set(List.of(blocks));
	}

	private static HolderSet<Block> set(List<Block> blocks) {
		return HolderSet.direct(blocks.stream().map(Block::builtInRegistryHolder).toList());
	}

	private static void bind(Item item, int maxDamage, Map<Holder.Reference<Item>, DataComponentMap> bindings, Tool.Rule... rules) {
		var holder = item.builtInRegistryHolder();
		bindings.putIfAbsent(holder, holder.areComponentsBound() ? holder.components() : null);
		holder.bindComponents(DataComponentMap.builder()
				.set(DataComponents.MAX_STACK_SIZE, 1)
				.set(DataComponents.MAX_DAMAGE, maxDamage)
				.set(DataComponents.DAMAGE, 0)
				.set(DataComponents.TOOL, new Tool(List.of(rules), 1.0F, 1, true)).build());
	}

	private static void check(boolean value, String reason) {
		if (!value) throw new AssertionError(reason);
		assertions++;
	}
}
