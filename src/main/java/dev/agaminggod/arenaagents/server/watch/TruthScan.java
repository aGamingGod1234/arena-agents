package dev.agaminggod.arenaagents.server.watch;

import dev.agaminggod.arenaagents.mixin.AbstractArrowInvoker;
import dev.agaminggod.arenaagents.server.perception.ProjectilePerception;
import dev.agaminggod.arenaagents.server.perception.SeenTerrain;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.particles.ParticleTypes;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.entity.AreaEffectCloud;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.boss.enderdragon.EnderDragon;
import net.minecraft.world.entity.boss.enderdragon.phases.EnderDragonPhase;
import net.minecraft.world.entity.monster.Blaze;
import net.minecraft.world.entity.monster.Creeper;
import net.minecraft.world.entity.monster.Enderman;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.monster.Ghast;
import net.minecraft.world.entity.monster.piglin.AbstractPiglin;
import net.minecraft.world.entity.monster.skeleton.AbstractSkeleton;
import net.minecraft.world.entity.monster.skeleton.WitherSkeleton;
import net.minecraft.world.entity.projectile.Projectile;
import net.minecraft.world.entity.projectile.arrow.AbstractArrow;
import net.minecraft.world.entity.projectile.hurtingprojectile.AbstractHurtingProjectile;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

/**
 * Ground truth around one agent: every danger the world really holds, read straight from the server (no player
 * gating; this never reaches the model). Bounded: mobs, projectiles and clouds within {@link #ENTITY_RADIUS} (ghasts
 * {@link #GHAST_RADIUS}, the dragon anywhere in its fight), terrain within {@link #BLOCK_RADIUS} of the feet.
 * Read-only: nothing here changes the world or any agent memory.
 */
final class TruthScan {
	static final double ENTITY_RADIUS = 24.0D;
	static final double GHAST_RADIUS = 64.0D;
	static final int BLOCK_RADIUS = 3;
	static final int BLOCK_DOWN = 4;
	static final int BLOCK_UP = 2;
	static final int MAX_FALL_SCAN = 64;
	/** Damage starts above this fall height. */
	static final double SAFE_FALL = 3.0D;
	/** Floor for "speed toward a hazard", so a still body next to it still has a finite time-to-harm. */
	static final double REST_SPEED = 0.5D;
	static final double CHASE_SPEED = 3.0D;
	static final double MELEE_REACH = 2.0D;

	private TruthScan() {
	}

	static String typeId(Entity entity) {
		return BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString();
	}

	private static Danger entityDanger(String kind, Entity source, double eta, double distance) {
		String uuid = source.getUUID().toString();
		return new Danger(uuid, kind, typeId(source), uuid, null, eta, distance);
	}

	private static double meleeEta(double distance, double speed) {
		return Math.max(0.0D, distance - MELEE_REACH) / speed;
	}

	/** Hostile mobs (and their attack state), projectiles on course and dragon breath clouds. */
	static void entities(ServerPlayer player, List<Danger> out) {
		ServerLevel level = player.level();
		AABB box = player.getBoundingBox().inflate(ENTITY_RADIUS);
		for (Entity entity : level.getEntities(player, box, entity -> entity.isAlive()
				&& (entity instanceof Mob || entity instanceof Projectile || entity instanceof AreaEffectCloud))) {
			if (entity instanceof Ghast || entity instanceof EnderDragon) continue;
			if (entity instanceof Mob mob) mob(player, mob, out);
			else if (entity instanceof Projectile projectile) projectile(player, projectile, out);
			else cloud(player, (AreaEffectCloud) entity, out);
		}
		// Ghasts shoot from up to 64 blocks; the wide query runs only where they live.
		if (level.dimension() == net.minecraft.world.level.Level.NETHER) for (Ghast ghast : level.getEntitiesOfClass(Ghast.class,
				player.getBoundingBox().inflate(GHAST_RADIUS), Ghast::isAlive)) {
			if (ghast.getTarget() != player) continue;
			double distance = player.distanceTo(ghast);
			out.add(entityDanger("ghast", ghast, (ghast.isCharging() ? 0.5D : 2.5D) + distance / 30.0D, distance));
		}
		for (EnderDragon dragon : level.getDragons()) dragon(player, dragon, out);
	}

	private static void mob(ServerPlayer player, Mob mob, List<Danger> out) {
		double distance = player.distanceTo(mob);
		boolean targeting = mob.getTarget() == player;
		if (mob instanceof Creeper creeper) {
			float swelling = creeper.getSwelling(1.0F);
			if ((creeper.getSwellDir() > 0 || swelling > 0.0F) && distance <= 7.0D) {
				out.add(entityDanger("creeper", creeper, (1.0D - swelling) * 1.5D, distance));
			} else if (targeting) {
				out.add(entityDanger("creeper", creeper, Math.max(0.0D, distance - 3.0D) / CHASE_SPEED + 1.5D, distance));
			}
			return;
		}
		if (!targeting) return;
		if (mob instanceof WitherSkeleton) {
			out.add(entityDanger("wither_skeleton", mob, meleeEta(distance, CHASE_SPEED), distance));
		} else if (mob instanceof AbstractSkeleton) {
			double draw = mob.isUsingItem() ? Math.max(0.0D, 20.0D - mob.getTicksUsingItem()) / 20.0D : 1.5D;
			out.add(entityDanger("ranged_mob", mob, draw + distance / 50.0D, distance));
		} else if (mob instanceof Blaze blaze) {
			out.add(entityDanger("blaze", blaze, (blaze.isOnFire() ? 0.3D : 2.5D) + distance / 20.0D, distance));
		} else if (mob instanceof AbstractPiglin) {
			double eta = mob.isUsingItem() ? 1.0D + distance / 50.0D : meleeEta(distance, CHASE_SPEED);
			out.add(entityDanger("piglin", mob, eta, distance));
		} else if (mob instanceof Enderman) {
			out.add(entityDanger("enderman", mob, Math.max(0.0D, distance - 3.0D) / 8.0D, distance));
		} else if (mob instanceof Enemy) {
			out.add(entityDanger("mob", mob, meleeEta(distance, CHASE_SPEED), distance));
		} else {
			// A provoked neutral mob (wolf, golem, bee, polar bear) after this agent.
			out.add(entityDanger("mob", mob, meleeEta(distance, CHASE_SPEED), distance));
		}
	}

	private static void dragon(ServerPlayer player, EnderDragon dragon, List<Danger> out) {
		if (!dragon.isAlive() || dragon.level() != player.level()) return;
		double distance = player.distanceTo(dragon);
		if (distance > 160.0D) return;
		EnderDragonPhase<?> phase = dragon.getPhaseManager().getCurrentPhase().getPhase();
		double eta = Double.POSITIVE_INFINITY;
		if (phase == EnderDragonPhase.CHARGING_PLAYER) eta = Math.max(0.0D, distance - 5.0D) / 20.0D;
		else if (phase == EnderDragonPhase.STRAFE_PLAYER) eta = 1.0D + distance / 30.0D;
		else if ((phase == EnderDragonPhase.LANDING || phase == EnderDragonPhase.TAKEOFF || phase == EnderDragonPhase.SITTING_FLAMING
				|| phase == EnderDragonPhase.SITTING_ATTACKING || phase == EnderDragonPhase.SITTING_SCANNING) && distance < 12.0D) {
			eta = Math.max(0.0D, distance - 4.0D) / 4.0D;
		}
		// The wings and body knock back and hurt whatever they pass through in any phase.
		if (distance < 8.0D) eta = Math.min(eta, Math.max(0.0D, distance - 4.0D) / 10.0D);
		if (Double.isFinite(eta)) out.add(entityDanger("dragon", dragon, eta, distance));
	}

	private static void projectile(ServerPlayer player, Projectile projectile, List<Danger> out) {
		Entity owner = projectile.getOwner();
		if (owner == player) return;
		boolean arrow = projectile instanceof AbstractArrow;
		boolean fireball = projectile instanceof AbstractHurtingProjectile;
		if (!arrow && !fireball) return;
		if (arrow && ((AbstractArrowInvoker) projectile).arenaagents$isInGround()) return;
		double eta = ProjectilePerception.impactSeconds(projectile.position(), projectile.getDeltaMovement(), player.getBoundingBox(),
				player.getDeltaMovement(), fireball, ProjectilePerception.HIT_MARGIN,
				(from, to) -> player.level().clip(new ClipContext(from, to, ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, projectile))
						.getType() == HitResult.Type.MISS);
		if (!Double.isFinite(eta)) return;
		double distance = player.distanceTo(projectile);
		// A shot merges into its shooter's episode: the danger is the shooter.
		Entity source = owner != null && owner.isAlive() ? owner : projectile;
		String uuid = source.getUUID().toString();
		out.add(new Danger(uuid, "projectile", typeId(source), uuid, null, eta, distance));
	}

	private static void cloud(ServerPlayer player, AreaEffectCloud cloud, List<Danger> out) {
		if (cloud.getParticle().getType() != ParticleTypes.DRAGON_BREATH) return;
		double gap = Math.hypot(player.getX() - cloud.getX(), player.getZ() - cloud.getZ()) - cloud.getRadius() - player.getBbWidth() / 2.0D;
		if (Math.abs(player.getY() - cloud.getY()) > 3.0D || gap > 3.0D) return;
		out.add(new Danger(cloud.getUUID().toString(), "dragon_breath", typeId(cloud), cloud.getUUID().toString(), null,
				Math.max(0.0D, gap) / 4.3D, Math.max(0.0D, gap)));
	}

	/** Speed (blocks per second) of the body toward a point, horizontally; never below {@link #REST_SPEED}. */
	private static double speedToward(ServerPlayer player, double x, double z) {
		Vec3 motion = player.getDeltaMovement();
		double dx = x - player.getX();
		double dz = z - player.getZ();
		double length = Math.hypot(dx, dz);
		if (length < 1.0E-6D) return REST_SPEED;
		return Math.max(REST_SPEED, (motion.x * dx + motion.z * dz) / length * 20.0D);
	}

	private static double gap(AABB body, BlockPos cell) {
		double dx = Math.max(0.0D, Math.max(cell.getX() - body.maxX, body.minX - (cell.getX() + 1.0D)));
		double dy = Math.max(0.0D, Math.max(cell.getY() - body.maxY, body.minY - (cell.getY() + 1.0D)));
		double dz = Math.max(0.0D, Math.max(cell.getZ() - body.maxZ, body.minZ - (cell.getZ() + 1.0D)));
		return Math.sqrt(dx * dx + dy * dy + dz * dz);
	}

	private static boolean open(ServerLevel level, BlockPos cell) {
		BlockState state = level.getBlockState(cell);
		return state.getCollisionShape(level, cell).isEmpty() && state.getFluidState().isEmpty();
	}

	private static int[] array(BlockPos cell) {
		return new int[] {cell.getX(), cell.getY(), cell.getZ()};
	}

	/**
	 * Lava and fire the body can reach (an open side within reach), lava one block behind or under the block the body
	 * is breaking ({@code breaking}), and the drops beside or ahead of the feet. One danger per kind: the nearest.
	 */
	static void blocks(ServerPlayer player, BlockPos breaking, List<Danger> out) {
		ServerLevel level = player.level();
		AABB body = player.getBoundingBox();
		BlockPos feet = player.blockPosition();
		BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();
		Danger lava = null;
		Danger fire = null;
		Danger hidden = null;
		boolean inLava = player.isInLava();
		for (int dy = -BLOCK_DOWN; dy <= BLOCK_UP; dy++) {
			for (int dx = -BLOCK_RADIUS; dx <= BLOCK_RADIUS; dx++) {
				for (int dz = -BLOCK_RADIUS; dz <= BLOCK_RADIUS; dz++) {
					cursor.set(feet.getX() + dx, feet.getY() + dy, feet.getZ() + dz);
					BlockState state = level.getBlockState(cursor);
					boolean isLava = state.getFluidState().is(FluidTags.LAVA);
					boolean isFire = state.is(BlockTags.FIRE);
					if (!isLava && !isFire) continue;
					BlockPos cell = cursor.immutable();
					double gap = gap(body, cell);
					if (exposed(level, cell, body)) {
						double eta = gap <= 0.0D ? 0.0D : gap / speedToward(player, cell.getX() + 0.5D, cell.getZ() + 0.5D);
						if (isLava && (lava == null || eta < lava.etaS())) {
							lava = new Danger("lava", "lava", "minecraft:lava", null, array(cell), inLava ? 0.0D : eta, gap);
						} else if (isFire && (fire == null || eta < fire.etaS())) {
							fire = new Danger("fire", "fire", BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString(), null, array(cell), eta, gap);
						}
					} else if (isLava && breaking != null && hidden == null && behind(cell, breaking)) {
						// Lava sealed by exactly the block being broken: it pours in when that block goes.
						hidden = new Danger("lava_hidden", "lava_hidden", "minecraft:lava", null, array(cell), 2.0D, gap);
					}
				}
			}
		}
		if (inLava && lava == null) {
			lava = new Danger("lava", "lava", "minecraft:lava", null, array(feet), 0.0D, 0.0D);
		}
		if (lava != null) out.add(lava);
		if (fire != null) out.add(fire);
		if (hidden != null) out.add(hidden);
		drops(player, out);
	}

	/** A hazard cell the body can touch: it overlaps the body, or an open neighbour lies within a step of it. */
	private static boolean exposed(ServerLevel level, BlockPos cell, AABB body) {
		if (gap(body, cell) <= 0.0D) return true;
		for (Direction direction : Direction.values()) {
			BlockPos side = cell.relative(direction);
			if (gap(body, side) > 1.0D) continue;
			if (gap(body, side) <= 0.0D || open(level, side)) return true;
		}
		return false;
	}

	private static boolean behind(BlockPos lava, BlockPos breaking) {
		return lava.distManhattan(breaking) == 1;
	}

	/** Drops beside the feet (and up to 3 blocks along the motion) deeper than a safe fall; the void counts as a drop. */
	private static void drops(ServerPlayer player, List<Danger> out) {
		ServerLevel level = player.level();
		if (!player.onGround()) {
			falling(player, out);
			return;
		}
		AABB body = player.getBoundingBox();
		int feetY = player.blockPosition().getY();
		Danger best = null;
		Vec3 motion = new Vec3(player.getDeltaMovement().x, 0.0D, player.getDeltaMovement().z);
		BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();
		java.util.Set<Long> checked = new java.util.HashSet<>();
		for (int dx = -1; dx <= 1; dx++) {
			for (int dz = -1; dz <= 1; dz++) {
				best = edge(player, level, body, new BlockPos(player.getBlockX() + dx, feetY, player.getBlockZ() + dz), best, checked, cursor);
			}
		}
		if (motion.lengthSqr() > 1.0E-4D) {
			Vec3 heading = motion.normalize();
			for (double step = 1.0D; step <= 3.0D; step += 0.5D) {
				Vec3 at = player.position().add(heading.scale(step));
				best = edge(player, level, body, BlockPos.containing(at.x, feetY, at.z), best, checked, cursor);
			}
		}
		if (best != null) out.add(best);
	}

	private static Danger edge(ServerPlayer player, ServerLevel level, AABB body, BlockPos cell, Danger best, java.util.Set<Long> checked,
			BlockPos.MutableBlockPos cursor) {
		if (!checked.add(cell.asLong())) return best;
		if (!open(level, cell) || !open(level, cell.below())) return best;
		int depth = 0;
		boolean voidBelow = true;
		for (int y = cell.getY() - 1; y >= Math.max(level.getMinY(), cell.getY() - MAX_FALL_SCAN); y--) {
			cursor.set(cell.getX(), y, cell.getZ());
			BlockState state = level.getBlockState(cursor);
			if (state.getFluidState().is(FluidTags.WATER)) return best;
			if (!state.getCollisionShape(level, cursor).isEmpty() || !state.getFluidState().isEmpty()) {
				voidBelow = false;
				break;
			}
			depth++;
		}
		voidBelow = voidBelow && cell.getY() - MAX_FALL_SCAN <= level.getMinY();
		if (!voidBelow && depth <= SAFE_FALL) return best;
		double gap = gap(body, cell);
		double eta = gap <= 0.0D ? 0.0D : gap / speedToward(player, cell.getX() + 0.5D, cell.getZ() + 0.5D);
		if (best != null && best.etaS() <= eta) return best;
		String kind = voidBelow ? "void" : "drop";
		return new Danger(kind, kind, voidBelow ? "void" : "drop:" + depth, null, array(cell), eta, gap);
	}

	/** A fall in progress that will hurt on landing (or never land). */
	private static void falling(ServerPlayer player, List<Danger> out) {
		ServerLevel level = player.level();
		double vy = player.getDeltaMovement().y;
		if (vy >= 0.0D) return;
		BlockPos feet = player.blockPosition();
		BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();
		int remaining = 0;
		boolean voidBelow = true;
		for (int y = feet.getY(); y >= Math.max(level.getMinY(), feet.getY() - MAX_FALL_SCAN); y--) {
			cursor.set(feet.getX(), y, feet.getZ());
			BlockState state = level.getBlockState(cursor);
			if (state.getFluidState().is(FluidTags.WATER)) return;
			if (!state.getCollisionShape(level, cursor).isEmpty() || !state.getFluidState().isEmpty()) {
				voidBelow = false;
				break;
			}
			remaining++;
		}
		voidBelow = voidBelow && feet.getY() - MAX_FALL_SCAN <= level.getMinY();
		double total = player.fallDistance + remaining;
		if (!voidBelow && total <= SAFE_FALL + 0.5D) return;
		double eta = remaining / Math.max(5.0D, -vy * 20.0D);
		String kind = voidBelow ? "void" : "fall";
		out.add(new Danger(kind, kind, voidBelow ? "void" : "fall", null, array(feet.below(remaining)), eta, remaining));
	}

	/** Body state: burning, air running out, low health. */
	static void body(ServerPlayer player, List<Danger> out) {
		if (player.isOnFire() && !player.fireImmune() && !player.hasEffect(MobEffects.FIRE_RESISTANCE)) {
			out.add(new Danger("burning", "burning", "fire", null, null, 0.0D, 0.0D));
		}
		if (player.isUnderWater() && player.getAirSupply() < player.getMaxAirSupply() && !player.hasEffect(MobEffects.WATER_BREATHING)) {
			out.add(new Danger("drowning", "drowning", "water", null, null, (Math.max(0, player.getAirSupply()) + 20) / 20.0D, 0.0D));
		}
		if (player.getHealth() <= 4.0F) {
			out.add(new Danger("low_health", "low_health", "player", null, null, 2.0D, 0.0D));
		}
	}

	/** Whether the cell is known to the body (seen now or remembered) as the given hazard, without touching its memory. */
	static boolean knows(ServerPlayer player, int[] block, boolean lava) {
		if (block == null) return false;
		BlockState known = SeenTerrain.remembered(player, block[0], block[1], block[2]);
		if (known == null) return false;
		return lava ? known.getFluidState().is(FluidTags.LAVA) : known.is(BlockTags.FIRE) || known.isAir();
	}
}
