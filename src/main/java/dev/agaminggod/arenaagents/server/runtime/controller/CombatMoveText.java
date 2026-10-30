package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.client.navigation.WalkabilityView;
import dev.agaminggod.arenaagents.server.perception.ObservationVisibility;
import dev.agaminggod.arenaagents.server.perception.SeenTerrain;
import dev.agaminggod.arenaagents.server.perception.ThreatPerception;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.item.BowItem;
import net.minecraft.world.item.CrossbowItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

/**
 * Facts a player would see when a fight approach or flee does not get anywhere: how high the target is, the refused
 * step, the block in the way, the headroom, and what ranged weapons both sides hold. Shared by fight_target and
 * flee_from so their results explain a stall in the same words. Only formats facts; it decides nothing. Blocks are
 * named as the player knows them ({@link SeenTerrain}): a remembered block says how long ago it was seen, and a block
 * the player does not know is not named, so a hidden change never shows up here.
 */
final class CombatMoveText {
	private CombatMoveText() {
	}

	static GridPosition feet(ServerPlayer player) {
		return new GridPosition(Mth.floor(player.getX()), Mth.floor(player.getY() + 0.2D), Mth.floor(player.getZ()));
	}

	/** A footing probe is not a promise of support while airborne; blocks and exits use acquired terrain only. */
	static String supportFacts(ServerPlayer player) {
		GridPosition below = new GridPosition(Mth.floor(player.getX()), Mth.floor(player.getY() - 0.01D), Mth.floor(player.getZ()));
		String block = knownBlock(player, below);
		return String.format(Locale.ROOT, "; health %.1f; onGround=%s; footing below center: %sat %d,%d,%d",
				player.getHealth(), player.onGround(), block.isEmpty() ? "unknown " : block, below.x(), below.y(), below.z())
				+ (HazardExits.inHazardBlock(player) ? "; exits: " + HazardExits.describe(HazardExits.scan(player)) : "");
	}

	/**
	 * The knockback margin for this tick: active while a mob that can hit the body (any active threat) is within
	 * {@link CombatPlanning.Margin#KNOCKBACK_RANGE}, with the support columns the body's box overhangs. One small entity
	 * query, made only when a controller consults the probe.
	 */
	static CombatPlanning.Margin knockbackMargin(ServerPlayer player) {
		double range = CombatPlanning.Margin.KNOCKBACK_RANGE;
		boolean near = !player.level().getEntitiesOfClass(LivingEntity.class, player.getBoundingBox().inflate(range),
				entity -> entity != player && entity.isAlive() && player.distanceTo(entity) <= range
						&& ThreatPerception.isActiveThreat(player, entity)).isEmpty();
		if (!near) return CombatPlanning.Margin.NONE;
		GridPosition feet = feet(player);
		Set<GridPosition> overhung = new LinkedHashSet<>();
		net.minecraft.world.phys.AABB box = player.getBoundingBox();
		for (int x = Mth.floor(box.minX + 1.0E-3D); x <= Mth.floor(box.maxX - 1.0E-3D); x++) {
			for (int z = Mth.floor(box.minZ + 1.0E-3D); z <= Mth.floor(box.maxZ - 1.0E-3D); z++) {
				if (x != feet.x() || z != feet.z()) overhung.add(new GridPosition(x, feet.y(), z));
			}
		}
		return new CombatPlanning.Margin(true, overhung);
	}

	/**
	 * The result for a fight or flee stopped because the body entered lava or a fire block (see {@link HazardEntry}).
	 * Lists the same exits a stopped model action gets ({@link HazardExits#stopMessage}).
	 */
	static String hazardStop(String code, ServerPlayer player, String action) {
		GridPosition feet = feet(player);
		String where = feet.x() + "," + feet.y() + "," + feet.z();
		String what = HazardEntry.IN_LAVA.equals(code) ? "Entered lava at " + where : "Entered fire at " + where;
		String exits = HazardEntry.IN_LAVA.equals(code) || HazardExits.inHazardBlock(player)
				? "; exits: " + HazardExits.describe(HazardExits.scan(player)) : "";
		return String.format(Locale.ROOT, "%s; %s stopped; health %.1f, burning %.1f s%s", what, action, player.getHealth(),
				player.getRemainingFireTicks() / 20.0D, exits);
	}

	/** "minecraft:piglin is 14.8 above you, 5.1 horizontal" */
	static String geometry(String subject, ServerPlayer player, LivingEntity target) {
		if (!ObservationVisibility.canSeeEntity(player, target)) return subject + " is out of view or occluded";
		double dy = target.getY() - player.getY();
		double horizontal = Math.hypot(target.getX() - player.getX(), target.getZ() - player.getZ());
		return String.format(Locale.ROOT, "%s is %.1f %s you, %.1f horizontal", subject, Math.abs(dy),
				dy >= 0.0D ? "above" : "below", horizontal);
	}

	/** Visible target equipment, carried ammunition, and whether a ranged item in either hand can be used. */
	static String rangedContext(ServerPlayer player, LivingEntity target) {
		StringBuilder text = new StringBuilder();
		// What the target holds only while the player sees it.
		String held = ObservationVisibility.canSeeEntity(player, target) ? ThreatPerception.rangedWeaponId(target) : null;
		if (held != null) {
			boolean sees = target instanceof Mob mob ? mob.getSensing().hasLineOfSight(player) : target.hasLineOfSight(player);
			text.append("; it holds ").append(held).append(sees ? " and sees you" : "");
		}
		Set<String> weapons = new LinkedHashSet<>();
		int arrows = 0, snowballs = 0, rockets = 0;
		boolean loaded = false;
		for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (stack.isEmpty()) continue;
			if (stack.getItem() instanceof BowItem || stack.getItem() instanceof CrossbowItem || stack.is(Items.TRIDENT)) {
				weapons.add(BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
				loaded |= stack.getItem() instanceof CrossbowItem && CrossbowItem.isCharged(stack);
			} else if (stack.is(Items.ARROW) || stack.is(Items.SPECTRAL_ARROW) || stack.is(Items.TIPPED_ARROW)) arrows += stack.getCount();
			else if (stack.is(Items.SNOWBALL)) snowballs += stack.getCount();
			else if (stack.is(Items.FIREWORK_ROCKET)) rockets += stack.getCount();
		}
		boolean heldReady = rangedReady(player.getMainHandItem(), arrows, rockets, player.isCreative())
				|| rangedReady(player.getOffhandItem(), arrows, rockets, player.isCreative());
		String hands = BuiltInRegistries.ITEM.getKey(player.getMainHandItem().getItem()) + "/"
				+ BuiltInRegistries.ITEM.getKey(player.getOffhandItem().getItem());
		return text.append("; ranged carried: ").append(weapons.isEmpty() ? "no bow or crossbow" : String.join(",", weapons))
				.append(", arrows=").append(arrows).append(", chargedCrossbow=").append(loaded)
				.append(", snowballs=").append(snowballs).append(", rockets=").append(rockets)
				.append("; heldRangedReady=").append(heldReady).append("; hands(main/off)=").append(hands).toString();
	}

	static boolean rangedReady(ItemStack hand, int arrows, int rockets, boolean creative) {
		if (hand.is(Items.SNOWBALL) || hand.is(Items.TRIDENT)) return true;
		if (hand.getItem() instanceof CrossbowItem) return CrossbowItem.isCharged(hand) || arrows > 0 || rockets > 0 || creative;
		return hand.getItem() instanceof BowItem && (arrows > 0 || creative);
	}

	/**
	 * "moved 0.3 m in 2 s; wall minecraft:netherrack at 381,85,-220; headroom 2". {@code held} is a route step the
	 * knockback margin refused (named as such), or null to probe the heading.
	 */
	static String stall(ServerPlayer player, WalkabilityView world, float moveYaw, CombatStallDetector.Stall stall,
			CombatPlanning.Margin margin, CombatPlanning.Refusal held) {
		StringBuilder text = new StringBuilder(String.format(Locale.ROOT, "moved %.1f m in %d s", stall.metres(),
				CombatStallDetector.WINDOW_TICKS / 20));
		GridPosition feet = feet(player);
		CombatPlanning.Refusal refusal = held != null ? held : CombatPlanning.refusal(world, feet, moveYaw, margin);
		if (held != null) {
			text.append("; held: a mob within 3 blocks could knock you into ").append(refusal(player, held));
		} else if (refusal != null) {
			text.append("; ").append(refusal(player, refusal));
		} else if (stall.wallTicks() > 0) {
			text.append("; pressed into ").append(frontBlock(player, feet, moveYaw));
		}
		if (stall.ceilingBumps() > 0) text.append("; hit the ceiling ").append(stall.ceilingBumps()).append('x');
		if (player.isInLava()) text.append("; standing in lava");
		return text.append("; headroom ").append(headroom(player, feet)).toString();
	}

	static String refusal(ServerPlayer player, CombatPlanning.Refusal refusal) {
		GridPosition at = refusal.at();
		String where = at.x() + "," + at.y() + "," + at.z();
		return switch (refusal.kind()) {
			case DROP -> refusal.drop() == 0 ? "no safe footing ahead at " + where : (refusal.drop() >= 16 ? "16+" : String.valueOf(refusal.drop())) + "-block drop ahead at " + where;
			case WALL -> "wall " + knownBlock(player, at) + "at " + where;
			case LOW_CEILING -> "low ceiling " + knownBlock(player, at) + "at " + where;
			case HAZARD -> "hazard " + knownBlock(player, at) + "at " + where + (refusal.drop() > 0 ? " (" + refusal.drop() + " down)" : "");
			case UNLOADED -> "unseen terrain at " + where;
		};
	}

	/** The first solid block straight ahead at feet or head height. */
	static String frontBlock(ServerPlayer player, GridPosition feet, float yaw) {
		double radians = Math.toRadians(yaw);
		int x = feet.x() + (int) Math.round(-Math.sin(radians));
		int z = feet.z() + (int) Math.round(Math.cos(radians));
		SeenTerrain.Reader<BlockState> seen = SeenTerrain.of(player);
		AcquiredGeometry geometry = new AcquiredGeometry(player.level(), position -> seen.known(position.getX(), position.getY(), position.getZ()));
		for (int dy = 0; dy <= 1; dy++) {
			BlockState state = seen.known(x, feet.y() + dy, z);
			var shape = state == null ? null : geometry.shape(state, new BlockPos(x, feet.y() + dy, z));
			if (shape != null && !shape.isEmpty()) {
				return knownBlock(player, new GridPosition(x, feet.y() + dy, z)) + "at " + x + "," + (feet.y() + dy) + "," + z;
			}
		}
		return "an obstacle ahead";
	}

	/**
	 * Known blocks without collision from the feet up, up to 3 (2 is a normal standing gap); fluids and fire count as
	 * room. Counting stops at a block the player does not know.
	 */
	static int headroom(ServerPlayer player, GridPosition feet) {
		return headroom(SeenTerrain.of(player), player.level(), feet);
	}

	static int headroom(SeenTerrain.Reader<BlockState> seen, net.minecraft.world.level.BlockGetter level, GridPosition feet) {
		AcquiredGeometry geometry = new AcquiredGeometry(level, position -> seen.known(position.getX(), position.getY(), position.getZ()));
		int clear = 0;
		while (clear < 3) {
			BlockState state = seen.known(feet.x(), feet.y() + clear, feet.z());
			var shape = state == null ? null : geometry.shape(state, new BlockPos(feet.x(), feet.y() + clear, feet.z()));
			if (shape == null || !shape.isEmpty()) break;
			clear++;
		}
		return clear;
	}

	/** "minecraft:stone ", "minecraft:stone (seen 4 s ago) " for a remembered block, or "" when the player does not know it. */
	static String knownBlock(ServerPlayer player, GridPosition at) {
		SeenTerrain.Reader<BlockState> seen = SeenTerrain.of(player);
		BlockState state = seen.known(at.x(), at.y(), at.z());
		if (state == null) return "";
		String id = BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
		int ago = seen.secondsSinceSeen(at.x(), at.y(), at.z());
		return ago > 0 ? id + " (seen " + ago + " s ago) " : id + " ";
	}

	static double horizontal(Vec3 from, double x, double z) {
		return Math.hypot(x - from.x, z - from.z);
	}
}
