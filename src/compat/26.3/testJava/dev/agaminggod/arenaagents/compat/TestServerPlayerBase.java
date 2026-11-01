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

/**
 * A ServerPlayer fixture whose version-specific overrides (the arm swing, the drop and the drop's entity) are routed to
 * hooks with one signature on every target, so a verification overrides the hook instead of a changing vanilla method.
 */
public abstract class TestServerPlayerBase extends ServerPlayer {
	protected TestServerPlayerBase(MinecraftServer server, ServerLevel level, GameProfile profile, ClientInformation information) {
		super(server, level, profile, information);
	}

	/** True when the fixture handled the swing itself (vanilla's swing is then skipped). */
	protected boolean testSwing(InteractionHand hand, boolean toSelf) {
		return false;
	}

	/** Runs before every drop (a fixture may throw here to inject a failure). */
	protected void testBeforeDrop(ItemStack stack) {
	}

	/** Creates the dropped item entity; {@code vanilla} is the real one. Returning null drops nothing. */
	protected ItemEntity testCreateDrop(ItemStack stack, boolean randomly, Supplier<ItemEntity> vanilla) {
		return vanilla.get();
	}

	/** True to simulate client-side movement for this fixture (26.3 MoveSimulationType.SERVER_AND_CLIENT). */
	protected boolean testSimulatesClientMovement() {
		return false;
	}

	@Override
	public boolean swing(InteractionHand hand, net.minecraft.world.item.component.SwingAnimation animation, boolean toSelf) {
		return testSwing(hand, toSelf) || super.swing(hand, animation, toSelf);
	}

	@Override
	public ItemEntity drop(ItemStack stack, boolean keepOwnership, net.minecraft.util.Prediction prediction) {
		testBeforeDrop(stack);
		return super.drop(stack, keepOwnership, prediction);
	}

	@Override
	public ItemEntity createItemStackToDrop(ItemStack stack, boolean randomly, boolean keepOwnership) {
		return testCreateDrop(stack, randomly, () -> super.createItemStackToDrop(stack, randomly, keepOwnership));
	}

	@Override
	public net.minecraft.world.entity.MoveSimulationType getMoveSimulationType() {
		return testSimulatesClientMovement() ? net.minecraft.world.entity.MoveSimulationType.SERVER_AND_CLIENT : super.getMoveSimulationType();
	}
}
