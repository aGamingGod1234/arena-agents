package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.agaminggod.arenaagents.agent.AgentId;
import java.io.IOException;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.effect.MobEffect;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.EntityTypes;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Abilities;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;

/** Sends the real server fire/effect JSON into the actual coordinator burn estimate. */
public final class BurnEstimateContractVerification {
	private static int assertions;
	private BurnEstimateContractVerification() { }

	public static int verify() {
		assertions = 0;
		try {
			Field field = sun.misc.Unsafe.class.getDeclaredField("theUnsafe"); field.setAccessible(true);
			var unsafe = (sun.misc.Unsafe) field.get(null);
			var level = (FixtureLevel) unsafe.allocateInstance(FixtureLevel.class);
			set(level, Level.class, "dimension", Level.OVERWORLD);
			var player = (ServerPlayer) unsafe.allocateInstance(ServerPlayer.class);
			player.setId(1020); // 26.3 assigns entity IDs in the constructor, which Unsafe allocation skips.
			set(player, Player.class, "abilities", new Abilities());
			set(player, Entity.class, "level", level);
			set(player, Entity.class, "type", EntityTypes.PLAYER);
			set(player, Entity.class, "firstTick", true);
			set(player, Entity.class, "bb", new AABB(.2D, 64D, .2D, .8D, 65.8D, .8D));
			set(player, Entity.class, "blockPosition", new BlockPos(0, 64, 0));
			var effects = ServerObservationCollector.class.getDeclaredMethod("effects", ServerPlayer.class);
			effects.setAccessible(true);
			int[][] cases = {{300, 100, 15, 10}, {300, -1, 15, 0}, {300, 400, 15, 0}, {300, 1, 15, 14},
					{281, 100, 15, 9}, {19, 18, 1, 0}, {19, 0, 1, 0}, {0, 0, 0, 0}};
			JsonArray snapshots = new JsonArray();
			for (int[] sample : cases) {
				player.setRemainingFireTicks(sample[0]);
				Map<Holder<MobEffect>, MobEffectInstance> active = new HashMap<>();
				if (sample[1] != 0) active.put(MobEffects.FIRE_RESISTANCE, new MobEffectInstance(MobEffects.FIRE_RESISTANCE, sample[1]));
				set(player, LivingEntity.class, "activeEffects", active);
				JsonObject snapshot = new JsonObject();
				new HazardFacts().addPlayerFacts(AgentId.random(), player, null, snapshot);
				snapshot.add("effects", (JsonArray) effects.invoke(null, player));
				check(sample[0] > 0 ? snapshot.get("fireTicks").getAsInt() == sample[0] : !snapshot.has("fireTicks"),
						"actual HazardFacts reports remaining fire ticks only while burning");
				JsonArray rows = snapshot.getAsJsonArray("effects");
				check(rows.size() == (sample[1] == 0 ? 0 : 1), "actual collector serializes only installed active effects");
				if (sample[1] != 0) {
					check(rows.get(0).getAsJsonObject().get("effectId").getAsString().equals("minecraft:fire_resistance"),
							"actual collector emits the exact installed fire resistance identity");
					check(rows.get(0).getAsJsonObject().get("duration").getAsInt() == sample[1],
							"actual collector preserves remaining effect ticks including infinite duration");
				}
				snapshots.add(snapshot);
			}
			JsonArray estimated = coordinatorBurnFacts(snapshots);
			for (int index = 0; index < cases.length; index++) {
				int[] sample = cases[index];
				if (sample[0] == 0) {
					check(estimated.get(index).isJsonNull(), "actual burn producer omits a finished burn");
				} else {
					JsonObject estimate = estimated.get(index).getAsJsonObject();
					check(estimate.get("seconds").getAsInt() == sample[2], "actual burn producer rounds remaining tick duration up to seconds");
					check(estimate.get("rawDamage").getAsInt() == sample[3],
							"actual burn producer subtracts resistance that expires during burning and honors infinite protection");
				}
			}
			return assertions;
		} catch (ReflectiveOperationException | IOException failure) { throw new AssertionError("burn estimate fixture failed", failure); }
	}

	private static JsonArray coordinatorBurnFacts(JsonArray snapshots) throws IOException {
		String script = "import {burnFacts} from './coordinator/src/dynamic-main.mjs'; "
				+ "const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk); "
				+ "process.stdout.write(JSON.stringify(JSON.parse(Buffer.concat(chunks).toString('utf8')).map(burnFacts)));";
		Process process = new ProcessBuilder("node", "--input-type=module", "-e", script).start();
		try {
			try (var input = process.getOutputStream()) { input.write(snapshots.toString().getBytes(StandardCharsets.UTF_8)); }
			try {
				if (!process.waitFor(30, TimeUnit.SECONDS)) throw new AssertionError("actual coordinator burn producer did not return");
			} catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new AssertionError(interrupted); }
			String errors = new String(process.getErrorStream().readAllBytes(), StandardCharsets.UTF_8);
			check(process.exitValue() == 0, "actual coordinator burn producer exits successfully: " + errors);
			return JsonParser.parseString(new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8)).getAsJsonArray();
		} finally { if (process.isAlive()) process.destroyForcibly(); }
	}
	private static void set(Object target, Class<?> owner, String name, Object value) throws ReflectiveOperationException {
		Field field = owner.getDeclaredField(name); field.setAccessible(true); field.set(target, value);
	}
	private static void check(boolean condition, String label) { if (!condition) throw new AssertionError(label); assertions++; }

	private static final class FixtureLevel extends ServerLevel {
		// 26.3 entities take their ID from the level, and ServerLevel asks its (absent) chunk source.
		private int fixtureEntityIds = 100_000;
		@Override public int getNextEntityId() { return ++fixtureEntityIds; }
		private FixtureLevel() { super(null, null, null, null, null, null, false, 0, List.of(), false); }
		@Override public <T extends net.minecraft.world.entity.Entity> java.util.List<T> getEntitiesOfClass(Class<T> type, net.minecraft.world.phys.AABB area, java.util.function.Predicate<? super T> predicate) { return java.util.List.of(); }
		@Override public long getGameTime() { return 0L; }
		@Override public BlockState getBlockState(BlockPos at) { return Blocks.AIR.defaultBlockState(); }
	}
}
