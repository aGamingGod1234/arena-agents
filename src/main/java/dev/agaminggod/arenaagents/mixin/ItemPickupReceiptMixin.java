package dev.agaminggod.arenaagents.mixin;

import carpet.patches.EntityPlayerMPFake;
import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;
import dev.agaminggod.arenaagents.server.perception.PickupReceipts;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;

@Mixin(ItemEntity.class)
abstract class ItemPickupReceiptMixin {
	@WrapOperation(method = "playerTouch", at = @At(value = "INVOKE",
			target = "Lnet/minecraft/world/entity/player/Inventory;add(Lnet/minecraft/world/item/ItemStack;)Z"))
	private boolean arenaagents$rememberPickup(Inventory inventory, ItemStack stack, Operation<Boolean> original, Player player) {
		if (!(player instanceof EntityPlayerMPFake) || player.getAbilities().instabuild) return original.call(inventory, stack);
		ItemStack identity = stack.copy();
		boolean added = original.call(inventory, stack);
		// Vanilla removes precisely what the inventory accepted, including partial pickups.
		PickupReceipts.record((ServerPlayer) player, ((ItemEntity) (Object) this).getUUID(), identity,
				identity.getCount() - stack.getCount());
		return added;
	}
}
