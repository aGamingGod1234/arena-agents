package dev.agaminggod.arenaagents.compat;

import java.util.List;
import net.minecraft.commands.CommandSource;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.core.BlockPos;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.HolderSet;
import net.minecraft.core.component.DataComponentMap;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
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
import net.minecraft.world.level.block.entity.SignTextSlot;
import net.minecraft.world.phys.Vec2;
import net.minecraft.world.phys.Vec3;

/** Minecraft 26.3 fixture builders whose vanilla constructors and factories differ between the 26.x targets. */
public final class TestCompat {
	private TestCompat() {
	}

	public static CommandSourceStack commandSource(CommandSource source, Vec3 position, Vec2 rotation, ServerLevel level, PermissionSet permissions, Component name) {
		return new CommandSourceStack(source, position, rotation, level, permissions, name, null);
	}

	public static HolderLookup.Provider vanillaWorldLookup() {
		return VanillaRegistries.createWorldLookup();
	}

	/** The reloadable (datapack) registries a server builds on top of the world lookup. */
	public static HolderLookup.Provider vanillaDatapackLookup() {
		return VanillaRegistries.createReloadableLookup(VanillaRegistries.createWorldLookup());
	}

	public static ContextMap slotDisplayContext() {
		return ContextMap.builder().buildAndValidate(SlotDisplayContext.CONTEXT);
	}

	/** A tag slot display for a named item tag with no members. */
	@SuppressWarnings("unchecked")
	public static SlotDisplay.TagSlotDisplay unboundTagDisplay(TagKey<Item> key) {
		try {
			var constructor = HolderSet.Named.class.getDeclaredConstructor(net.minecraft.core.HolderOwner.class, TagKey.class);
			constructor.setAccessible(true);
			var named = (HolderSet.Named<Item>) constructor.newInstance(BuiltInRegistries.ITEM, key);
			var bind = HolderSet.Named.class.getDeclaredMethod("bind", List.class);
			bind.setAccessible(true);
			bind.invoke(named, List.of());
			return new SlotDisplay.TagSlotDisplay(named);
		} catch (ReflectiveOperationException exception) {
			throw new AssertionError("could not build an empty item tag", exception);
		}
	}

	public static ClientboundOpenSignEditorPacket openSignEditor(BlockPos position, boolean front) {
		return new ClientboundOpenSignEditorPacket(position, front ? SignTextSlot.FRONT : SignTextSlot.BACK);
	}

	/** 26.3 furnaces burn by the cooking_fuel item component, which the datapack normally supplies. */
	public static void setFuel(DataComponentMap.Builder components, net.minecraft.world.item.Item item, int burnTicks) {
		components.set(DataComponents.COOKING_FUEL, new net.minecraft.world.item.component.CookingFuel(
				new net.minecraft.world.level.storage.loot.providers.number.ints.ResolvableInt.Constant(burnTicks),
				new net.minecraft.world.level.storage.loot.providers.number.floats.ResolvableFloat.Constant(1.0F)));
	}

	/** 26.3 aiStep reads the interpolation handler every tick; an unsafely allocated entity has none. */
	public static void prepareAllocatedEntity(Entity entity) throws ReflectiveOperationException {
		var field = Entity.class.getDeclaredField("interpolationHandler");
		field.setAccessible(true);
		field.set(entity, net.minecraft.world.entity.InterpolationHandler.NO_OP);
	}
}
