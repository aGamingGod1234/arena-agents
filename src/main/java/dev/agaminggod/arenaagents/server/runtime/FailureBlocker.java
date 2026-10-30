package dev.agaminggod.arenaagents.server.runtime;

import carpet.script.utils.Tracer;
import com.google.gson.JsonObject;
import dev.agaminggod.arenaagents.protocol.ActionType;
import dev.agaminggod.arenaagents.server.perception.ObservationVisibility;
import java.util.Locale;
import java.util.Set;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;

/**
 * Adds the concrete blocker to a failure, by failure family, where terminal results are built: the
 * distance against reach, the block in the way when the player's current crosshair is on it, or the
 * distance still left to a chosen destination. Each is something the player sees or knows; none picks
 * an action. Producer text is kept; only sentences listed in GENERIC, which restate the code, are replaced.
 */
public final class FailureBlocker {
	private static final Set<String> REACH = Set.of("TARGET_TOO_FAR", "TARGET_OUT_OF_RANGE", "SIGN_NOT_REACHABLE");
	private static final Set<String> SIGHT = Set.of("TARGET_NOT_VISIBLE", "TARGET_OBSTRUCTED");
	private static final Set<String> TRAVEL_TIMEOUT = Set.of("ACTION_TIMEOUT", "NAVIGATION_TIMED_OUT");
	private static final Set<ActionType> TRAVEL = Set.of(ActionType.MOVE_TO, ActionType.NAVIGATE_TO, ActionType.TRAVEL_TO);
	// Exact producer sentences that only restate their code; the concrete distance replaces them.
	static final Set<String> GENERIC = Set.of(
			"Attack target is out of reach", "Block interaction target is out of reach", "Block is out of reach",
			"Entity interaction target is out of reach", "Placement hit is out of reach", "Placement target is out of reach",
			"Target menu is out of reach", "Navigation timed out");

	private FailureBlocker() {
	}

	/** The message with the family's blocker added, unless the producer already stated it. */
	public static String withBlocker(ServerPlayer player, ActionType type, JsonObject arguments, String reasonCode, String message) {
		if (player == null || type == null || arguments == null || reasonCode == null) return message;
		String fact;
		try {
			fact = blocker(player, type, arguments, reasonCode);
		} catch (RuntimeException unavailable) {
			// Arguments without a block target, or a world read that is not possible now: the message stands alone.
			return message;
		}
		return append(message, fact);
	}

	static String append(String message, String fact) {
		String base = message == null ? "" : message;
		if (fact == null || fact.isEmpty() || base.contains(fact)) return base;
		return base.isEmpty() || GENERIC.contains(base) ? fact : base + "; " + fact;
	}

	private static String blocker(ServerPlayer player, ActionType type, JsonObject arguments, String reasonCode) {
		if (!arguments.has("x") || !arguments.has("y") || !arguments.has("z")) return "";
		Vec3 eye = player.getEyePosition();
		if (TRAVEL_TIMEOUT.contains(reasonCode) && TRAVEL.contains(type)) {
			Vec3 destination = new Vec3(arguments.get("x").getAsDouble(), arguments.get("y").getAsDouble(), arguments.get("z").getAsDouble());
			return "destination " + metres(player.position().distanceTo(destination)) + "m away";
		}
		BlockPos target = BlockPos.containing(arguments.get("x").getAsDouble(), arguments.get("y").getAsDouble(), arguments.get("z").getAsDouble());
		if (REACH.contains(reasonCode)) {
			return reachFact(Math.sqrt(new AABB(target).distanceToSqr(eye)), player.blockInteractionRange());
		}
		if (SIGHT.contains(reasonCode)) {
			HitResult crosshair = Tracer.rayTrace(player, 1.0F, player.blockInteractionRange(), false);
			BlockPos in = sightBlocker(player.level(), CollisionContext.of(player), eye, target, crosshair, player.level()::isLoaded);
			return in == null ? "" : sightFact(BuiltInRegistries.BLOCK.getKey(player.level().getBlockState(in).getBlock()).toString(), in);
		}
		return "";
	}

	/**
	 * The block between the eye and the target, only when the player perceives it now: the current crosshair is on
	 * that same block, its chunk is loaded, and no lava lies between the eye and the point the crosshair meets.
	 * A block behind the player, outside the view or seen only through lava is never named.
	 */
	static BlockPos sightBlocker(BlockGetter level, CollisionContext context, Vec3 eye, BlockPos target, HitResult crosshair, Predicate<BlockPos> loaded) {
		BlockHitResult seen = BreakSightline.visibleBlocker(level, context, eye, target, crosshair);
		if (seen == null || !loaded.test(seen.getBlockPos())) return null;
		return ObservationVisibility.lavaBetween(level, eye, seen.getLocation(), seen.getBlockPos()) ? null : seen.getBlockPos();
	}

	static String reachFact(double distance, double reach) {
		return "target " + metres(distance) + "m from eye; reach " + metres(reach) + "m";
	}

	static String sightFact(String blockId, BlockPos first) {
		return blockId + " at " + first.getX() + "," + first.getY() + "," + first.getZ() + " is in the way";
	}

	private static String metres(double value) {
		return String.format(Locale.ROOT, "%.1f", value);
	}
}
