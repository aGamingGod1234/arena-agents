package dev.agaminggod.arenaagents.mixin;

import dev.agaminggod.arenaagents.server.perception.ObservationVisibility;
import dev.agaminggod.arenaagents.server.runtime.controller.ArrowImpactReceipt;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.projectile.arrow.AbstractArrow;
import net.minecraft.world.phys.EntityHitResult;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(AbstractArrow.class)
abstract class ArrowImpactReceiptMixin implements ArrowImpactReceipt {
	@Unique private final Map<UUID, Boolean> arenaagents$visibleHits = new LinkedHashMap<>();
	@Unique private final Map<UUID, String> arenaagents$visibleHitTypes = new LinkedHashMap<>();
	@Unique private boolean arenaagents$visibleImpact;
	@Unique private boolean arenaagents$aliveBeforeImpact;

	@Inject(method = "onHitEntity", at = @At("HEAD"))
	private void arenaagents$beforeHit(EntityHitResult hit, CallbackInfo ci) {
		AbstractArrow arrow = (AbstractArrow) (Object) this;
		arenaagents$aliveBeforeImpact = hit.getEntity().isAlive();
		arenaagents$visibleImpact = arrow.getOwner() instanceof ServerPlayer player
				&& ObservationVisibility.canSeeEntity(player, arrow)
				&& ObservationVisibility.canSeeEntity(player, hit.getEntity());
	}

	@Inject(method = "onHitEntity", at = @At("RETURN"))
	private void arenaagents$afterHit(EntityHitResult hit, CallbackInfo ci) {
		if (!arenaagents$visibleImpact) return;
		arenaagents$visibleHits.put(hit.getEntity().getUUID(), arenaagents$aliveBeforeImpact && !hit.getEntity().isAlive());
		arenaagents$visibleHitTypes.put(hit.getEntity().getUUID(), net.minecraft.core.registries.BuiltInRegistries.ENTITY_TYPE.getKey(hit.getEntity().getType()).toString());
		while (arenaagents$visibleHits.size() > 128) arenaagents$visibleHits.remove(arenaagents$visibleHits.keySet().iterator().next());
		while (arenaagents$visibleHitTypes.size() > 128) arenaagents$visibleHitTypes.remove(arenaagents$visibleHitTypes.keySet().iterator().next());
	}

	@Override public boolean arenaagents$struck(Entity target) { return arenaagents$visibleHits.containsKey(target.getUUID()); }
	@Override public String arenaagents$struckOther(Entity target) {
		for (var hit : arenaagents$visibleHitTypes.entrySet()) if (!hit.getKey().equals(target.getUUID())) return hit.getValue();
		return null;
	}
	@Override public boolean arenaagents$destroyed(Entity target) { return Boolean.TRUE.equals(arenaagents$visibleHits.get(target.getUUID())); }
}
