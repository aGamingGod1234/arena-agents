package dev.agaminggod.arenaagents.compat;

import com.mojang.authlib.GameProfile;
import java.util.function.Supplier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ClientInformation;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.item.ItemStack;

/** 26.2 implementation of the fixture player base (see the 26.3 one). Here one drop method creates and adds the entity. */
public abstract class TestServerPlayerBase extends ServerPlayer {
	protected TestServerPlayerBase(MinecraftServer server, ServerLevel level, GameProfile profile, ClientInformation information) {
		super(server, level, profile, information);
	}

	protected boolean testSwing(InteractionHand hand, boolean toSelf) {
		return false;
	}

	protected void testBeforeDrop(ItemStack stack) {
	}

	protected ItemEntity testCreateDrop(ItemStack stack, boolean randomly, Supplier<ItemEntity> vanilla) {
		return vanilla.get();
	}

	/** True to let this fixture simulate movement without a level (26.2 asks the level whether it is the client). */
	protected boolean testSimulatesClientMovement() {
		return false;
	}

	@Override
	public boolean canSimulateMovement() {
		return testSimulatesClientMovement() || super.canSimulateMovement();
	}

	@Override
	public void swing(InteractionHand hand, boolean toSelf) {
		if (!testSwing(hand, toSelf)) super.swing(hand, toSelf);
	}

	@Override
	public ItemEntity drop(ItemStack stack, boolean randomly, boolean keepOwnership) {
		testBeforeDrop(stack);
		return testCreateDrop(stack, randomly, () -> super.drop(stack, randomly, keepOwnership));
	}
}
