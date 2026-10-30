package dev.agaminggod.arenaagents.client.mixin;

import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;
import dev.agaminggod.arenaagents.client.pov.PovClient;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.client.renderer.culling.Frustum;
import net.minecraft.client.renderer.entity.state.EntityRenderState;
import net.minecraft.client.renderer.extract.LevelExtractor;
import net.minecraft.core.BlockPos;
import net.minecraft.tags.TagKey;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.block.RenderShape;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.Fluid;
import net.minecraft.world.phys.AABB;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;

/**
 * The in-block, underwater and fire overlays read the operator's own body. During an agent view the camera is
 * the agent, so an operator standing inside a wall blacked out the whole view. Read the agent instead, and draw
 * nothing while the agent is unavailable (signal lost or dead). Since 26.3 the overlays draw from the player state
 * that LevelExtractor fills, so the reads are answered there. The extracted avatar is the agent's too: its spectator
 * flag gates the fluid and fire overlays (as the old isSpectator wrap did), and the first-person arm takes its skin,
 * sleeves, swing and map tilt from it (as the old arm draw did from the agent).
 */
@Mixin(LevelExtractor.class)
abstract class ScreenEffectRendererPovMixin {
	@WrapOperation(method = "extractPlayerState", at = @At(value = "INVOKE",
			target = "Lnet/minecraft/client/renderer/extract/LevelExtractor;extractEntity(Lnet/minecraft/world/entity/Entity;F)Lnet/minecraft/client/renderer/entity/state/EntityRenderState;"))
	private EntityRenderState arenaagents$povAvatar(LevelExtractor extractor, Entity player, float partialTick, Operation<EntityRenderState> original) {
		AbstractClientPlayer agent = PovClient.isActive() ? PovClient.agentPlayer() : null;
		return original.call(extractor, agent == null ? player : agent, partialTick);
	}

	@WrapOperation(method = "extractPlayerState", at = @At(value = "INVOKE",
			target = "Lnet/minecraft/client/renderer/extract/LevelExtractor;getViewBlockingState(Lnet/minecraft/client/player/LocalPlayer;Lnet/minecraft/client/renderer/culling/Frustum;)Lnet/minecraft/world/level/block/state/BlockState;"))
	private static BlockState arenaagents$povViewBlockingState(LocalPlayer player, Frustum frustum, Operation<BlockState> original) {
		if (!PovClient.isActive()) return original.call(player, frustum);
		AbstractClientPlayer agent = PovClient.agentPlayer();
		return agent == null ? null : arenaagents$viewBlockingState(agent, frustum);
	}

	// LevelExtractor.getViewBlockingState, which only takes the local player, run on the agent's body.
	private static BlockState arenaagents$viewBlockingState(AbstractClientPlayer player, Frustum frustum) {
		if (player.noPhysics) return null;
		AABB nearPlane = frustum.getNearPlaneBounds().move(player.getEyePosition());
		BlockPos.MutableBlockPos test = new BlockPos.MutableBlockPos();
		for (int i = 0; i < 8; i++) {
			test.set(player.getX() + ((i >> 0) % 2 - 0.5F) * player.getBbWidth() * 0.8F,
					player.getEyeY() + ((i >> 1) % 2 - 0.5F) * 0.1F * player.getScale(),
					player.getZ() + ((i >> 2) % 2 - 0.5F) * player.getBbWidth() * 0.8F);
			BlockState state = player.level().getBlockState(test);
			if (state.getRenderShape() != RenderShape.INVISIBLE && state.isViewBlocking(player.level(), test, nearPlane)) return state;
		}
		return null;
	}

	@WrapOperation(method = "extractPlayerState", at = @At(value = "INVOKE",
			target = "Lnet/minecraft/client/player/LocalPlayer;isEyeInFluid(Lnet/minecraft/tags/TagKey;)Z"))
	private boolean arenaagents$povEyeInFluid(LocalPlayer player, TagKey<Fluid> fluid, Operation<Boolean> original) {
		if (!PovClient.isActive()) return original.call(player, fluid);
		AbstractClientPlayer agent = PovClient.agentPlayer();
		return agent != null && agent.isEyeInFluid(fluid);
	}

	@WrapOperation(method = "extractPlayerState", at = @At(value = "INVOKE",
			target = "Lnet/minecraft/client/player/LocalPlayer;isOnFire()Z"))
	private boolean arenaagents$povOnFire(LocalPlayer player, Operation<Boolean> original) {
		if (!PovClient.isActive()) return original.call(player);
		AbstractClientPlayer agent = PovClient.agentPlayer();
		return agent != null && agent.isOnFire();
	}
}
