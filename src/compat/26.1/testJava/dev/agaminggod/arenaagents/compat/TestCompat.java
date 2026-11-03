package dev.agaminggod.arenaagents.compat;

import net.minecraft.commands.CommandSource;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.core.BlockPos;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.component.DataComponentMap;
import net.minecraft.data.registries.VanillaRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.network.protocol.game.ClientboundOpenSignEditorPacket;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.permissions.PermissionSet;
import net.minecraft.tags.TagKey;
import net.minecraft.util.context.ContextMap;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.crafting.display.SlotDisplay;
import net.minecraft.world.item.crafting.display.SlotDisplayContext;
import net.minecraft.world.phys.Vec2;
import net.minecraft.world.phys.Vec3;

/** 26.2 implementation of the fixture builders (see the 26.3 one). */
public final class TestCompat {
	private TestCompat() {
	}

	public static CommandSourceStack commandSource(CommandSource source, Vec3 position, Vec2 rotation, ServerLevel level, PermissionSet permissions, Component name) {
		return new CommandSourceStack(source, position, rotation, level, permissions, name.getString(), name, null, null);
	}

	public static HolderLookup.Provider vanillaWorldLookup() {
		return VanillaRegistries.createLookup();
	}

	/** Before 26.3 the vanilla lookup already holds the datapack registries. */
	public static HolderLookup.Provider vanillaDatapackLookup() {
		return VanillaRegistries.createLookup();
	}

	public static ContextMap slotDisplayContext() {
		return new ContextMap.Builder().create(SlotDisplayContext.CONTEXT);
	}

	/** Before 26.3 a tag slot display names only the tag's key. */
	public static SlotDisplay.TagSlotDisplay unboundTagDisplay(TagKey<Item> key) {
		return new SlotDisplay.TagSlotDisplay(key);
	}

	public static ClientboundOpenSignEditorPacket openSignEditor(BlockPos position, boolean front) {
		return new ClientboundOpenSignEditorPacket(position, front);
	}

	/** Fuel burn ticks the fixtures declared (TestServerLevelBase answers fuelValues() from them). */
	static final java.util.Map<net.minecraft.world.item.Item, Integer> FUEL = new java.util.LinkedHashMap<>();

	/** Before 26.3 fuel is not an item component: burn times come from the level's fuel table, recorded here. */
	public static void setFuel(DataComponentMap.Builder components, net.minecraft.world.item.Item item, int burnTicks) {
		FUEL.put(item, burnTicks);
	}

	/** Before 26.3 aiStep has no interpolation handler to prepare. */
	public static void prepareAllocatedEntity(Entity entity) {
	}

	/** A downward pointed dripstone: its tip, or the base segment above a tip. */
	public static net.minecraft.world.level.block.state.BlockState dripstone(boolean tip) {
		return net.minecraft.world.level.block.Blocks.POINTED_DRIPSTONE.defaultBlockState()
				.setValue(net.minecraft.world.level.block.PointedDripstoneBlock.TIP_DIRECTION, net.minecraft.core.Direction.DOWN)
				.setValue(net.minecraft.world.level.block.PointedDripstoneBlock.THICKNESS, tip
						? net.minecraft.world.level.block.state.properties.DripstoneThickness.TIP
						: net.minecraft.world.level.block.state.properties.DripstoneThickness.BASE);
	}

	/** The HUD locator bar class (LocatorBarRenderer before 26.2). */
	public static final String LOCATOR_BAR_CLASS = "net.minecraft.client.gui.contextualbar.LocatorBarRenderer";
}
