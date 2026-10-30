package dev.agaminggod.arenaagents.server.runtime;

import dev.agaminggod.arenaagents.server.perception.ObservationVisibility;
import dev.agaminggod.arenaagents.server.runtime.controller.AcquiredResultTerrain;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/** Facts sampled only for a terminal result, never a replacement action or target. */
public final class ActionResultFacts {
	private ActionResultFacts() {
	}

	public static String unavailableDrop(ServerPlayer player, Vec3 lastPosition, ItemStack identity) {
		String visible = visibleDrops(player, lastPosition, identity);
		return unavailableDropMessage(visible);
	}

	static String unavailableDropMessage(String visible) {
		return "Drop not visible" + visible;
	}

	public static String visibleDrops(ServerPlayer player, Vec3 position, ItemStack identity) {
		ObservationVisibility.Frame sight = ObservationVisibility.frame(player.level(), player);
		AABB area = position == null ? player.getBoundingBox().inflate(8.0D)
				: new AABB(position, position).inflate(2.0D);
		List<String> rows = player.level().getEntitiesOfClass(ItemEntity.class, area,
				item -> item.isAlive() && !item.getItem().isEmpty()).stream()
				.filter(item -> identity == null || ItemStack.isSameItemSameComponents(item.getItem(), identity))
				.filter(sight::canSeeEntity)
				.sorted(Comparator.comparingDouble(player::distanceToSqr))
				.map(item -> dropRow(item.getUUID().toString(), BuiltInRegistries.ITEM.getKey(item.getItem().getItem()).toString(),
						item.getItem().getCount())).toList();
		return dropSummary(rows);
	}

	static String dropRow(String uuid, String itemId, int count) {
		return uuid + " " + count + " " + itemId;
	}

	static String dropSummary(List<String> rows) {
		if (rows.isEmpty()) return "";
		StringBuilder result = new StringBuilder("; seen: ");
		int shown = 0;
		for (String row : rows) {
			// Leave room for the rest of the existing 2,048-character terminal message.
			if (result.length() + row.length() > 1_024) break;
			if (shown++ > 0) result.append("; ");
			result.append(row);
		}
		if (shown < rows.size()) result.append("; ").append(rows.size() - shown).append(" more seen");
		return result.toString();
	}

	public static String blockedDestination(ServerPlayer player, Vec3 destination) {
		AcquiredResultTerrain world = AcquiredResultTerrain.of(player);
		BlockPos feet = BlockPos.containing(destination);
		AABB body = player.getBoundingBox().move(destination.subtract(player.position()));
		String occupied = "";
		for (BlockPos cell : List.of(feet, feet.above())) {
			var state = world.knownState(cell);
			if (state != null && world.intersects(cell, body)) {
				occupied = "Seen obstruction: " + BuiltInRegistries.BLOCK.getKey(state.getBlock())
						+ " at " + cell.getX() + "," + cell.getY() + "," + cell.getZ();
				break;
			}
		}
		if (occupied.isEmpty()) return "";
		Vec3 nearest = nearestCell(destination, cell -> world.isFullBlockStandable(BlockPos.containing(cell)));
		return occupied + (nearest == null ? "; no seen standing cell (full-block support; radius 3h/1v)"
				: "; nearest seen standing cell: " + coordinates(nearest)
						+ " (full-block support; radius 3h/1v; route unverified)");
	}

	static String destinationMessage(String reasonCode, String controllerMessage, String facts) {
		if (facts.isEmpty()) return controllerMessage;
		String genericArrival = "Destination has no supported arrival region that can be approached within the requested tolerance";
		if (reasonCode.equals("NO_STANDABLE_PATH") && controllerMessage.startsWith(genericArrival)) {
			return facts + controllerMessage.substring(genericArrival.length());
		}
		return controllerMessage + "; " + facts;
	}

	static Vec3 nearestCell(Vec3 destination, Predicate<Vec3> seenStandable) {
		BlockPos origin = BlockPos.containing(destination);
		List<Vec3> cells = new ArrayList<>();
		for (int x = -3; x <= 3; x++) for (int y = -1; y <= 1; y++) for (int z = -3; z <= 3; z++) {
			Vec3 cell = Vec3.atBottomCenterOf(origin.offset(x, y, z));
			if (Math.abs(cell.y - destination.y) <= 1.0D
					&& Math.pow(cell.x - destination.x, 2) + Math.pow(cell.z - destination.z, 2) <= 9.0D) cells.add(cell);
		}
		cells.sort(Comparator.comparingDouble(destination::distanceToSqr));
		return cells.stream().filter(seenStandable).findFirst().orElse(null);
	}

	static String coordinates(Vec3 position) {
		return coordinate(position.x) + "," + coordinate(position.y) + "," + coordinate(position.z);
	}

	private static String coordinate(double value) {
		String rounded = String.format(Locale.ROOT, "%.2f", value);
		int end = rounded.length();
		while (rounded.charAt(end - 1) == '0') end--;
		if (rounded.charAt(end - 1) == '.') end--;
		return rounded.substring(0, end);
	}
}
