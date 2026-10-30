package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.attribute.EnvironmentAttributes;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.LightLayer;
import net.minecraft.world.level.gamerules.GameRules;
import dev.agaminggod.arenaagents.server.runtime.input.ModelPlayerInputBridge;

/** A focused vanilla screen read. Hidden survival counters are deliberately not HUD facts. */
public final class PlayerHudInspection {
	private PlayerHudInspection() { }

	public static JsonObject collect(ServerPlayer player) {
		JsonObject result = new JsonObject();
		result.addProperty("source", "vanilla_hud_inventory_and_local_debug_screen");
		JsonObject vitals = new JsonObject();
		vitals.addProperty("hearts", halfHearts(player.getHealth()));
		vitals.addProperty("maxHearts", halfHearts(player.getMaxHealth()));
		vitals.addProperty("absorptionHearts", halfHearts(player.getAbsorptionAmount()));
		vitals.addProperty("hunger", player.getFoodData().getFoodLevel());
		vitals.addProperty("hungerShaking", player.getFoodData().getSaturationLevel() <= 0);
		vitals.addProperty("armor", player.getArmorValue());
		if (player.isUnderWater() || player.getAirSupply() < player.getMaxAirSupply()) {
			vitals.addProperty("airBubbles", airBubbles(player.getAirSupply(), player.getMaxAirSupply()));
		}
		vitals.addProperty("xpLevel", player.experienceLevel);
		vitals.addProperty("xpBarPixels", xpPixels(player.experienceProgress));
		vitals.addProperty("xpBarWidth", 182);
		vitals.addProperty("burning", player.isOnFire());
		result.add("vitals", vitals);
		result.addProperty("selectedSlot", player.getInventory().getSelectedSlot());
		JsonArray hotbar = new JsonArray();
		for (int slot = 0; slot < 9; slot++) {
			JsonObject item = hudItem(player.getInventory().getItem(slot));
			item.addProperty("slot", slot);
			hotbar.add(item);
		}
		result.add("hotbar", hotbar);
		result.add("offhand", hudItem(player.getOffhandItem()));
		JsonObject held = new JsonObject();
		held.addProperty("mainHandCooldownPixels", cooldownPixels(player.getCooldowns().getCooldownPercent(player.getMainHandItem(), 0.0F)));
		held.addProperty("offhandCooldownPixels", cooldownPixels(player.getCooldowns().getCooldownPercent(player.getOffhandItem(), 0.0F)));
		held.addProperty("cooldownOverlayHeight", 16);
		result.add("heldCooldowns", held);
		var vehicle = player.getVehicle();
		if (vehicle != null) {
			JsonObject mount = new JsonObject();
			if (vehicle.showVehicleHealth() && vehicle instanceof net.minecraft.world.entity.LivingEntity living) {
				mount.addProperty("hearts", halfHearts(living.getHealth()));
				mount.addProperty("maxHearts", halfHearts(living.getMaxHealth()));
			}
			if (vehicle instanceof net.minecraft.world.entity.PlayerRideableJumping jumping) {
				mount.addProperty("jumpAvailable", jumping.canJump());
				mount.addProperty("jumpCoolingDown", jumping.getJumpCooldown() > 0);
				Float charge = ModelPlayerInputBridge.ridingJumpScale(player);
				if (charge == null) mount.addProperty("jumpCharge", "not_observed");
				else {
					mount.addProperty("jumpBarPixels", jumping.getJumpCooldown() > 0 ? 0 : jumpPixels(charge));
					mount.addProperty("jumpBarWidth", 182);
				}
			}
			result.add("mount", mount);
		}
		JsonArray effects = new JsonArray();
		for (var effect : player.getActiveEffects()) {
			JsonObject row = new JsonObject();
			row.addProperty("effectId", effect.getEffect().unwrapKey().map(key -> key.identifier().toString()).orElse(effect.getDescriptionId()));
			row.addProperty("level", effect.getAmplifier() + 1);
			row.addProperty("secondsLeft", effect.isInfiniteDuration() ? -1 : Math.max(0, effect.getDuration() / 20));
			row.addProperty("hudIcon", effect.showIcon());
			effects.add(row);
		}
		result.add("effects", effects);
		result.add("bossBars", PlayerObservationEvents.snapshot(player).getAsJsonArray("bossBars"));
		result.add("tabList", PlayerObservationEvents.tabList(player));
		result.add("locator", PlayerObservationEvents.locator(player));
		result.add("sidebar", sidebar(player));
		result.add("crosshair", ServerObservationCollector.crosshair(player));
		JsonObject damage = PlayerObservationEvents.recentDamage(player);
		if (damage != null) result.add("recentDamage", damage);
		result.add("environment", environment(player));
		result.add("debug", debug(player));
		return result;
	}

	static double halfHearts(float points) { return Math.ceil(Math.max(0, points)) / 2.0D; }
	static int xpPixels(float progress) { return (int) (Math.clamp(progress, 0.0F, 1.0F) * 183.0F); }
	static int airBubbles(int air, int maximum) { return Math.clamp((int) Math.ceil((air - 2) * 10.0D / Math.max(1, maximum)), 0, 10); }
	static int cooldownPixels(float progress) { return Math.clamp((int) Math.ceil(Math.clamp(progress, 0.0F, 1.0F) * 16), 0, 16); }
	static int jumpPixels(float progress) { return net.minecraft.util.Mth.lerpDiscrete(Math.clamp(progress, 0.0F, 1.0F), 0, 182); }

	private static JsonObject sidebar(ServerPlayer player) {
		var scoreboard = player.level().getScoreboard();
		var objective = scoreboard.getDisplayObjective(net.minecraft.world.scores.DisplaySlot.SIDEBAR);
		var team = player.getTeam();
		if (team != null) {
			var slot = team.getColor().map(net.minecraft.world.scores.TeamColor::displaySlot).orElse(null);
			if (slot != null && scoreboard.getDisplayObjective(slot) != null) objective = scoreboard.getDisplayObjective(slot);
		}
		JsonObject result = new JsonObject();
		JsonArray rows = new JsonArray();
		if (objective != null) {
			result.addProperty("title", ObservationDetails.bounded(objective.getDisplayName().getString(), 256));
			var format = objective.numberFormatOrDefault(net.minecraft.network.chat.numbers.StyledFormat.SIDEBAR_DEFAULT);
			scoreboard.listPlayerScores(objective).stream().filter(entry -> !entry.isHidden())
					.sorted(java.util.Comparator.comparingInt(net.minecraft.world.scores.PlayerScoreEntry::value).reversed().thenComparing(net.minecraft.world.scores.PlayerScoreEntry::owner, String.CASE_INSENSITIVE_ORDER)).limit(15).forEach(entry -> {
						JsonObject row = new JsonObject();
						row.addProperty("name", ObservationDetails.bounded(net.minecraft.world.scores.PlayerTeam.formatNameForTeam(scoreboard.getPlayersTeam(entry.owner()), entry.ownerName()).getString(), 256));
						row.addProperty("value", ObservationDetails.bounded(entry.formatValue(format).getString(), 256));
						rows.add(row);
					});
		}
		result.add("rows", rows);
		return result;
	}

	static JsonObject hudItem(ItemStack stack) {
		JsonObject result = new JsonObject();
		result.addProperty("itemId", BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
		result.addProperty("count", stack.getCount());
		if (!stack.isEmpty()) {
			result.addProperty("name", ObservationDetails.bounded(stack.getHoverName().getString(), 256));
			if (stack.isBarVisible()) {
				result.addProperty("durabilityBarPixels", stack.getBarWidth());
				result.addProperty("durabilityBarWidth", 13);
			}
		}
		return result;
	}

	private static JsonObject environment(ServerPlayer player) {
		var level = player.level();
		JsonObject result = new JsonObject();
		boolean skyVisible = level.dimensionType().hasSkyLight() && level.canSeeSky(BlockPos.containing(player.getEyePosition()));
		boolean clockVisible = false;
		for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
			if (player.getInventory().getItem(slot).is(net.minecraft.world.item.Items.CLOCK)) { clockVisible = true; break; }
		}
		boolean phaseKnown = level.dimension().equals(net.minecraft.world.level.Level.OVERWORLD) && (skyVisible || clockVisible);
		result.addProperty("skyVisible", skyVisible);
		result.addProperty("dayPhase", phaseKnown ? dayPhase(level.getDefaultClockTime()) : "unknown");
		result.addProperty("weather", skyVisible && level.canHaveWeather() ? level.isThundering() ? "thunderstorm" : level.isRaining() ? "rain" : "clear" : "unknown");
		var bed = level.environmentAttributes().getValue(EnvironmentAttributes.BED_RULE, player.blockPosition());
		result.addProperty("bedExplodes", bed.destroyOnUse());
		result.addProperty("bedTimeAllowsSleep", bed.canSleep(level));
		result.addProperty("sleepSafetyChecked", false);
		return result;
	}

	static String dayPhase(long clock) {
		long tick = Math.floorMod(clock, 24_000L);
		return tick < 11_000 ? "day" : tick < 13_000 ? "sunset" : tick < 23_000 ? "night" : "sunrise";
	}

	static boolean reducedDebug(ServerPlayer player) {
		return player.isReducedDebugInfo() || player.level().getGameRules().get(GameRules.REDUCED_DEBUG_INFO);
	}

	private static JsonObject debug(ServerPlayer player) {
		JsonObject result = new JsonObject();
		boolean reduced = reducedDebug(player);
		result.addProperty("reduced", reduced);
		result.addProperty("dimension", player.level().dimension().identifier().toString());
		if (reduced) return result;
		result.addProperty("x", Math.round(player.getX() * 1000) / 1000.0D);
		result.addProperty("y", Math.round(player.getY() * 1000) / 1000.0D);
		result.addProperty("z", Math.round(player.getZ() * 1000) / 1000.0D);
		result.addProperty("facing", player.getDirection().getName());
		result.addProperty("yaw", Math.round(net.minecraft.util.Mth.wrapDegrees(player.getYRot()) * 10) / 10.0D);
		result.addProperty("pitch", Math.round(player.getXRot() * 10) / 10.0D);
		player.level().getBiome(player.blockPosition()).unwrapKey().ifPresent(key -> result.addProperty("biome", key.identifier().toString()));
		result.addProperty("blockLight", player.level().getBrightness(LightLayer.BLOCK, player.blockPosition()));
		result.addProperty("skyLight", player.level().getBrightness(LightLayer.SKY, player.blockPosition()));
		return result;
	}
}
