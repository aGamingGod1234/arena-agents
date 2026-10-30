package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonObject;
import java.lang.reflect.Field;
import java.util.List;
import java.util.UUID;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.EntityTypes;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

public final class PlayerHudInspectionVerification {
	private PlayerHudInspectionVerification() { }

	public static int verify() {
		check(PlayerHudInspection.halfHearts(19.1F) == 10, "health reports the displayed half-heart count");
		check(PlayerHudInspection.halfHearts(1.1F) == 1, "absorption rounds to visible half hearts");
		check(PlayerHudInspection.halfHearts(0) == 0, "no absorption gives no hearts");
		check(PlayerHudInspection.xpPixels(0.5F) == 91, "XP follows vanilla integer pixel fill");
		check(PlayerHudInspection.xpPixels(0.501F) == 91, "hidden sub-pixel XP differences are absent");
		check(PlayerHudInspection.airBubbles(300, 300) == 10, "full air is ten bubbles");
		check(PlayerHudInspection.airBubbles(150, 300) == 5, "half air is five bubbles");
		check(PlayerHudInspection.airBubbles(0, 300) == 0, "empty air has no full bubbles");
		check(PlayerHudInspection.cooldownPixels(0.5F) == 8, "item cooldown is quantized to visible overlay pixels");
		check(PlayerHudInspection.cooldownPixels(0) == 0, "ready held item has no cooldown overlay");
		check(PlayerHudInspection.dayPhase(24_000) .equals("day"), "day phase wraps the clock");
		check(PlayerHudInspection.dayPhase(12_000).equals("sunset"), "sunset is coarse sky information");
		check(PlayerHudInspection.dayPhase(14_000).equals("night"), "night is coarse sky information");
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		JsonObject empty = PlayerHudInspection.hudItem(ItemStack.EMPTY);
		check(empty.get("count").getAsInt() == 0 && empty.get("itemId").getAsString().equals("minecraft:air"), "empty hotbar slots remain explicit");
		ItemStack tool = new ItemStack(Items.IRON_PICKAXE);
		tool.set(net.minecraft.core.component.DataComponents.MAX_DAMAGE, 250);
		tool.set(net.minecraft.core.component.DataComponents.DAMAGE, 0);
		check(!PlayerHudInspection.hudItem(tool).has("durabilityBarPixels"), "an unworn item has no visible wear bar");
		tool.setDamageValue(100);
		JsonObject worn = PlayerHudInspection.hudItem(tool);
		check(worn.get("durabilityBarPixels").getAsInt() == tool.getBarWidth(), "wear is the vanilla visible bar");
		check(!worn.has("damage") && !worn.has("maxDamage"), "HUD item exposes no exact hidden wear counter");
		PlayerObservationEvents.Stream damage = new PlayerObservationEvents.Stream();
		damage.damage("arrow", 20);
		damage.damageDirection(90, 20);
		check(damage.recentDamage(21).get("direction").getAsString().equals("front"), "hurt animation supplies relative damage direction");
		check(!damage.recentDamage(21).has("entityId") && !damage.recentDamage(21).has("x"), "damage never exposes unseen identity or coordinates");
		damage.damage("on_fire", 40);
		check(!damage.recentDamage(40).has("direction"), "environmental damage cannot inherit old attacker direction");
		check(damage.recentDamage(141) == null, "recent damage expires after five seconds");
		PlayerObservationEvents.Stream boss = new PlayerObservationEvents.Stream();
		boss.boss("boss", "Boss", 0.5F, false, 1, "minecraft:overworld", "purple", "progress");
		boss.boss("boss", null, null, false, 2, "minecraft:overworld", "red", "notched_10");
		JsonObject bar = boss.snapshot().getAsJsonArray("bossBars").get(0).getAsJsonObject();
		check(bar.get("color").getAsString().equals("red") && bar.get("overlay").getAsString().equals("notched_10"), "boss bar style updates preserve visible appearance");
		check(bar.get("name").getAsString().equals("Boss") && bar.get("progress").getAsDouble() == 0.5, "style-only update keeps title and progress");
		UUID tabId = UUID.randomUUID();
		var tabEntry = new net.minecraft.network.protocol.game.ClientboundPlayerInfoUpdatePacket.Entry(tabId, new com.mojang.authlib.GameProfile(tabId, "Visible"), true, 0, net.minecraft.world.level.GameType.SURVIVAL, null, true, 0, null);
		boss.tabPlayer(tabEntry, java.util.Set.of(net.minecraft.network.protocol.game.ClientboundPlayerInfoUpdatePacket.Action.ADD_PLAYER, net.minecraft.network.protocol.game.ClientboundPlayerInfoUpdatePacket.Action.UPDATE_LISTED));
		check(boss.tabList().getAsJsonArray("names").get(0).getAsString().equals("Visible"), "Tab captures only player-addressed listed names");
		var hiddenEntry = new net.minecraft.network.protocol.game.ClientboundPlayerInfoUpdatePacket.Entry(tabId, null, false, 0, null, null, true, 0, null);
		boss.tabPlayer(hiddenEntry, java.util.Set.of(net.minecraft.network.protocol.game.ClientboundPlayerInfoUpdatePacket.Action.UPDATE_LISTED));
		check(boss.tabList().getAsJsonArray("names").isEmpty(), "unlisted names leave the Tab screen");
		try { return 25 + crosshair(); }
		catch (ReflectiveOperationException failure) { throw new AssertionError(failure); }
	}

	private static int crosshair() throws ReflectiveOperationException {
		Field singleton = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
		singleton.setAccessible(true);
		var unsafe = (sun.misc.Unsafe) singleton.get(null);
		FixtureLevel level = (FixtureLevel) unsafe.allocateInstance(FixtureLevel.class);
		FixturePlayer player = player(unsafe, level, new Vec3(0, 64, 0), new AABB(-0.3, 64, -0.3, 0.3, 65.8, 0.3));
		FixturePlayer target = player(unsafe, level, new Vec3(0, 64, 2.5), new AABB(-0.3, 64, 2.2, 0.3, 65.8, 2.8));
		level.candidate = target;
		player.hit = BlockHitResult.miss(new Vec3(0, 65.62, 4.5), Direction.SOUTH, new BlockPos(0, 65, 4));
		JsonObject visible = ServerObservationCollector.crosshair(player);
		check(visible.get("type").getAsString().equals("entity") && visible.get("uuid").getAsString().equals(target.getUUID().toString()), "real vanilla entity clipping identifies crosshair target");
		player.hit = new BlockHitResult(new Vec3(0, 65.62, 1), Direction.NORTH, new BlockPos(0, 65, 1), false);
		check(ServerObservationCollector.crosshair(player).get("type").getAsString().equals("block"), "wall occludes the entity crosshair target");
		set(target, "bb", new AABB(-0.3, 64, 5.2, 0.3, 65.8, 5.8));
		player.hit = BlockHitResult.miss(new Vec3(0, 65.62, 4.5), Direction.SOUTH, new BlockPos(0, 65, 4));
		check(ServerObservationCollector.crosshair(player).get("type").getAsString().equals("miss"), "crosshair cannot acquire an out-of-reach entity");
		return 3;
	}

	private static FixturePlayer player(sun.misc.Unsafe unsafe, FixtureLevel level, Vec3 position, AABB box) throws ReflectiveOperationException {
		FixturePlayer player = (FixturePlayer) unsafe.allocateInstance(FixturePlayer.class);
		player.setId(1031); // 26.3 assigns entity IDs in the constructor, which Unsafe allocation skips.
		player.fixtureLevel = level;
		set(player, "position", position);
		set(player, "bb", box);
		set(player, "eyeHeight", 1.62F);
		set(player, "uuid", UUID.randomUUID());
		set(player, "type", EntityTypes.PLAYER);
		return player;
	}

	private static void set(Entity entity, String name, Object value) throws ReflectiveOperationException {
		Field field = Entity.class.getDeclaredField(name);
		field.setAccessible(true);
		field.set(entity, value);
	}

	private static final class FixturePlayer extends ServerPlayer {
		FixtureLevel fixtureLevel;
		HitResult hit;
		FixturePlayer() { super(null, null, null, null); }
		@Override public ServerLevel level() { return fixtureLevel; }
		@Override public double blockInteractionRange() { return 4.5; }
		@Override public double entityInteractionRange() { return 3.0; }
		@Override public HitResult pick(double reach, float partialTick, boolean fluids) { return hit; }
		@Override public boolean isSpectator() { return false; }
		@Override public boolean isPickable() { return true; }
	}

	private static final class FixtureLevel extends ServerLevel {
		// 26.3 entities take their ID from the level, and ServerLevel asks its (absent) chunk source.
		private int fixtureEntityIds = 100_000;
		@Override public int getNextEntityId() { return ++fixtureEntityIds; }
		Entity candidate;
		FixtureLevel() { super(null, null, null, null, null, null, false, 0L, List.of(), false); }
		@Override public List<Entity> getEntities(Entity source, AABB area, Predicate<? super Entity> predicate) { return predicate.test(candidate) ? List.of(candidate) : List.of(); }
		@Override public net.minecraft.world.level.block.state.BlockState getBlockState(BlockPos position) { return net.minecraft.world.level.block.Blocks.STONE.defaultBlockState(); }
	}

	private static void check(boolean condition, String label) { if (!condition) throw new AssertionError(label); }
}
