package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonObject;
import java.util.Locale;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.AreaEffectCloud;
import net.minecraft.world.entity.Crackiness;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.animal.golem.IronGolem;
import net.minecraft.world.entity.animal.sheep.Sheep;
import net.minecraft.core.particles.ParticleTypes;
import net.minecraft.world.entity.boss.enderdragon.EndCrystal;
import net.minecraft.world.entity.boss.enderdragon.EnderDragon;
import net.minecraft.world.entity.monster.Blaze;
import net.minecraft.world.entity.monster.Creeper;
import net.minecraft.world.entity.monster.Enderman;
import net.minecraft.world.entity.monster.Ghast;
import net.minecraft.world.entity.monster.piglin.AbstractPiglin;
import net.minecraft.world.entity.monster.piglin.PiglinArmPose;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.SpawnerBlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

/**
 * What the vanilla renderer shows on a mob or block beyond its type and pose: a charging blaze, the block an
 * enderman carries, a piglin admiring gold, dragon movement, a crystal's synced beam or cage, the
 * mob spinning inside a spawner. Only non-default facts are written and nothing when none show, so ordinary rows
 * cost no bytes. AI state a player cannot see (targets, timers, teleport destinations) stays private.
 */
final class VisibleAppearance {
	private VisibleAppearance() { }

	static JsonObject entity(ServerPlayer viewer, Entity entity) {
		ObservationVisibility.Frame visibility = ObservationVisibility.frame(viewer.level(), viewer);
		if (!visibility.canSeeAppearance(entity)) return null;
		JsonObject look = new JsonObject();
		if (entity instanceof LivingEntity living && living.isBaby()) look.addProperty("baby", true);
		if (entity instanceof Blaze blaze) {
			// Blaze.isOnFire is its synced charged flag: it glows and smokes before each fireball volley.
			if (blaze.isOnFire()) look.addProperty("charging", true);
			if (!blaze.onGround()) look.addProperty("airborne", true);
		} else if (entity instanceof Ghast ghast) {
			if (ghast.isCharging()) look.addProperty("charging", true);
		} else if (entity instanceof IronGolem golem) {
			// The cracked-iron texture: damage a player reads off the model, never the health number.
			String cracks = crackStage(golem.getCrackiness());
			if (cracks != null) look.addProperty("cracks", cracks);
		} else if (entity instanceof Sheep sheep) {
			look.addProperty("woolColor", sheep.getColor().getSerializedName());
			if (sheep.isSheared()) look.addProperty("sheared", true);
		} else if (entity instanceof AreaEffectCloud cloud) {
			boolean dragonBreath = cloud.getParticle().getType() == ParticleTypes.DRAGON_BREATH;
			look.addProperty("cloud", dragonBreath ? "dragon_breath" : "lingering");
			if (cloud.isWaiting()) look.addProperty("arming", true);
			else if (dragonBreath) look.addProperty("harmful", true);
			look.addProperty("radius", Math.round(cloud.getRadius() * 10.0D) / 10.0D);
			// The cloud visibly contracts; its exact remaining ticks are not drawn.
			if (cloud.getRadiusPerTick() < 0.0F) look.addProperty("shrinking", true);
			// Fireball breath visibly spreads (3 to 7 blocks over 30 s): an edge that is clear now reaches you later.
			else if (cloud.getRadiusPerTick() > 0.0F) look.addProperty("growing", true);
		} else if (entity instanceof Creeper creeper) {
			if (creeper.isPowered()) look.addProperty("powered", true);
		} else if (entity instanceof Enderman enderman) {
			BlockState carried = enderman.getCarriedBlock();
			if (carried != null) look.addProperty("carriedBlock", BuiltInRegistries.BLOCK.getKey(carried.getBlock()).toString());
			// Open mouth and shaking: an angry enderman.
			if (enderman.isCreepy()) look.addProperty("screaming", true);
			if (eyeContact(viewer, enderman)) look.addProperty("eyeContact", true);
		} else if (entity instanceof AbstractPiglin piglin) {
			String pose = armPose(piglin.getArmPose());
			if (pose != null) look.addProperty("armPose", pose);
			if (piglin.isConverting()) look.addProperty("shaking", true);
		} else if (entity instanceof EnderDragon dragon) {
			// Positions are rendered; a selected flight phase can precede its visible maneuver.
			Vec3 movement = renderedMotion(dragon);
			// A still dragon resting on the fountain's bedrock is seen sitting on it, even when the pillar top itself is
			// hidden from the ground (End runs 2026-10-21: 70-83% of fountain perches read "hovering" from below).
			// It lands with its root up to a block off the 1x1 pillar, so the cells around the one below count too.
			boolean support = false;
			for (BlockPos cell : BlockPos.betweenClosed(dragon.blockPosition().offset(-1, -3, -1), dragon.blockPosition().offset(1, -1, 1))) {
				if (dragon.level().getBlockState(cell).is(Blocks.BEDROCK)) { support = true; break; }
			}
			look.addProperty("motion", dragonMotion(movement, support));
			// nearestCrystal is independently randomized on client and server. It is not a synced beam source.
		} else if (entity instanceof EndCrystal crystal) {
			CrystalCage cage = CrystalCage.of(crystal.level(), crystal);
			if (cage != null) {
				look.addProperty("caged", true);
				// Broken bars beside or above it are the gaps arrows and hits can pass.
				if (!cage.openings().isEmpty()) {
					com.google.gson.JsonArray open = new com.google.gson.JsonArray();
					for (BlockPos cell : cage.openings().subList(0, Math.min(6, cage.openings().size()))) open.add(cell.getX() + "," + cell.getY() + "," + cell.getZ());
					look.add("cageOpen", open);
				}
			}
			BlockPos beam = crystal.getBeamTarget();
			// EndCrystalRenderer uses this synced endpoint (respawn beams), unlike dragon healing beams.
			if (beam != null && viewer.getEyePosition().distanceToSqr(Vec3.atCenterOf(beam)) <= 128.0D * 128.0D
					&& visibility.seesCell(beam)) look.addProperty("beamTarget", beam.getX() + "," + beam.getY() + "," + beam.getZ());
		}
		return look.size() == 0 ? null : look;
	}

	static JsonObject block(Level level, BlockPos position, BlockState state) {
		if (!state.is(Blocks.SPAWNER) || !(level.getBlockEntity(position) instanceof SpawnerBlockEntity spawner)) return null;
		return SpawnerAppearance.block(spawner, level.registryAccess());
	}

	/** Vanilla Enderman.isBeingStaredBy: the viewer's crosshair is on its head and no carved pumpkin hides the gaze. */
	private static boolean eyeContact(ServerPlayer viewer, Enderman enderman) {
		return LivingEntity.PLAYER_NOT_WEARING_DISGUISE_ITEM.test(viewer)
				&& enderman.isLookingAtMe(viewer, 0.025D, true, false, enderman.getEyeY());
	}

	/** Iron golem crack texture stage; undamaged is omitted. */
	static String crackStage(Crackiness.Level level) {
		return level == null || level == Crackiness.Level.NONE ? null : level.name().toLowerCase(Locale.ROOT);
	}

	/** The arm pose is drawn on the model; admiring means it took gold and is looking it over. Default is omitted. */
	static String armPose(PiglinArmPose pose) {
		return pose == null || pose == PiglinArmPose.DEFAULT ? null : pose.name().toLowerCase(Locale.ROOT);
	}

	/**
	 * The dragon's rendered movement this tick. Its delta movement is only updated while a flight phase has a target,
	 * so a perched dragon keeps its last flight vector there (0.4-0.5 blocks per tick in End runs) while it sits still.
	 */
	public static Vec3 renderedMotion(EnderDragon dragon) {
		return dragon.position().subtract(dragon.xo, dragon.yo, dragon.zo);
	}

	/** Conservative descriptions of displacement, without guessing flight intent or attack targets. */
	static String dragonMotion(Vec3 movement, boolean visibleSupport) {
		if (movement.lengthSqr() < 0.0025D) return visibleSupport ? "perched" : "hovering";
		if (movement.y < -0.05D) return "descending";
		if (movement.y > 0.05D) return "ascending";
		return "flying";
	}

	/** A guarded spike's iron-bar cage (see {@link CrystalCage}) still mostly stands round the crystal. */
	static boolean caged(Predicate<BlockPos> ironBars, BlockPos crystal) {
		return CrystalCage.find(ironBars, crystal) != null;
	}
}
