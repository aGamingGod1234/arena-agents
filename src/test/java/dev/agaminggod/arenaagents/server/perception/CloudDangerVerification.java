package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

public final class CloudDangerVerification {
	private static int assertions;
	private CloudDangerVerification() { }
	public static int verify() {
		assertions = 0;
		AABB bounds = new AABB(-3, 0, -3, 3, 0.5, 3);
		AABB body = new AABB(-0.3, 0, -0.3, 0.3, 1.8, 0.3);
		check(CloudDanger.inside(Vec3.ZERO, 3, bounds, Vec3.ZERO, body), "body standing in breath intersects its damaging disk");
		check(!CloudDanger.inside(Vec3.ZERO, 3, bounds, new Vec3(2.9, 0, 2.9), body.move(2.9, 0, 2.9)), "cloud bounding-box corners are outside the damaging disk");
		check(!CloudDanger.inside(Vec3.ZERO, 3, bounds, new Vec3(0, 1, 0), body.move(0, 1, 0)), "cloud below the body is not contact");
		Vec3 exit = CloudDanger.nearestExit(new Vec3(0.5, 0, 0.5), Vec3.ZERO, 3, cell -> cell.x == 3.5 && cell.z == 0.5);
		check(exit != null && exit.x == 3.5, "nearest exit is outside breath on acquired standing terrain");
		check(CloudDanger.nearestExit(Vec3.ZERO, Vec3.ZERO, 3, cell -> false) == null, "no known footing yields no invented exit");
		double breathGrowth = (7.0D - 3.0D) / 600.0D;
		check(Math.abs(CloudDanger.exitRadius(3.0D, breathGrowth) - (3.0D + 4.0D / 3.0D)) < 1.0E-9D, "a growing breath cloud's exit clears its radius one model turn later");
		check(CloudDanger.exitRadius(3.0D, -0.005D) == 3.0D, "a shrinking lingering cloud's exit is its current edge");
		Vec3 grownExit = CloudDanger.nearestExit(new Vec3(0.5, 0, 0.5), Vec3.ZERO, CloudDanger.exitRadius(3.0D, breathGrowth), cell -> true);
		check(grownExit != null && Math.hypot(grownExit.x, grownExit.z) > 4.33D, "the exit cell lies beyond the grown edge, not the current one");
		JsonObject before = observation(false, false, false), entering = observation(true, false, false);
		check(AttentionSignalPolicy.changedFacts(before, entering).contains("player.clouds"), "entering unknown lingering particles is an attention edge during control");
		JsonObject contact = observation(true, true, true);
		check(AttentionSignalPolicy.changedFacts(entering, contact).contains("player.clouds"), "contact with harmful cloud raises attention before generic damage");
		check(!AttentionSignalPolicy.changedFacts(contact, contact.deepCopy()).contains("player.clouds"), "standing in the same cloud does not flood repeated attention");
		check(!AttentionSignalPolicy.changedFacts(contact, before).contains("player.clouds"), "leaving the cloud is quiet");
		JsonObject harm = PerceivedHarm.toJson(new PerceivedHarm.Snapshot("minecraft:dragon_breath", true, 6.0, null));
		check(harm.get("source").getAsString().equals("minecraft:dragon_breath") && harm.get("ongoing").getAsBoolean(), "persistent breath facts name the source and ongoing damage");
		check(CloudDanger.nearestExit(new Vec3(.5, 64, .5), new Vec3(.5, 64, .5), 3,
				cell -> cell.x == 4.5 && cell.z == .5 && cell.y == 65) != null, "exit search accepts one-block slopes");
		JsonObject known = observation(true, false, true);
		check(!AttentionSignalPolicy.changedFacts(entering, known).contains("player.clouds"), "learning harmfulness does not add a third cloud alert");
		verifyLiveExposure();
		return assertions;
	}
	private static void verifyLiveExposure() {
		try {
			var field = sun.misc.Unsafe.class.getDeclaredField("theUnsafe"); field.setAccessible(true);
			var unsafe = (sun.misc.Unsafe) field.get(null);
			var player = (CloudPlayer) unsafe.allocateInstance(CloudPlayer.class);
			player.setId(1021); // 26.3 assigns entity IDs in the constructor, which Unsafe allocation skips.
			var level = (CloudLevel) unsafe.allocateInstance(CloudLevel.class);
			var cloud = (VisibleCloud) unsafe.allocateInstance(VisibleCloud.class);
			cloud.setId(1022); // 26.3 assigns entity IDs in the constructor, which Unsafe allocation skips.
			player.world = level; level.cloud = cloud;
			set(player, "id", 1001); set(cloud, "id", 1002);
			set(player, "position", new Vec3(0.5, 64, 0.5));
			set(player, "bb", new AABB(0.2, 64, 0.2, 0.8, 65.8, 0.8));
			set(player, "deltaMovement", Vec3.ZERO);
			set(player, "eyeHeight", 1.62F);
			set(cloud, "position", new Vec3(0.5, 64, 0.5));
			set(cloud, "bb", new AABB(-2.5, 64, -2.5, 3.5, 64.5, 3.5));
			set(cloud, "uuid", java.util.UUID.randomUUID());
			check(CloudDanger.signalKeys(player).contains(CloudDanger.key(cloud.getUUID().toString(), true)),
					"raw tick sampling raises breath contact even before health drops or the body moves");
			check(CloudDanger.contactSource(player) == null, "breath contact alone does not claim received damage");
			check(CloudDanger.nearestHarmful(player, 0) == cloud, "standing in dragon breath is a cloud_near reading at within 0");
			set(player, "blockPosition", new net.minecraft.core.BlockPos(0, 64, 0));
			set(player, "entityData", unsafe.allocateInstance(net.minecraft.network.syncher.SynchedEntityData.class));
			var dimension = net.minecraft.world.level.Level.class.getDeclaredField("dimension"); dimension.setAccessible(true);
			dimension.set(level, net.minecraft.world.level.Level.END);
			var harm = new PerceivedHarm(); var id = dev.agaminggod.arenaagents.agent.AgentId.random();
			player.health = 20;
			check(harm.sample(id, player) == null, "contact with no damage has no active harm");
			player.damage = damage("indirectMagic", cloud); player.hurtTime = 10; player.health = 19.75F;
			check(harm.sample(id, player).source().equals("minecraft:dragon_breath"), "received cloud magic is attributed to breath even for a fractional HP drop");
			for (String cause : java.util.List.of("on_fire", "fall", "drown")) {
				player.damage = damage(cause, null); player.health -= 1;
				check(harm.sample(id, player).source().equals("minecraft:" + cause), "cloud contact preserves received " + cause + " damage");
			}
			player.damage = damage("indirectMagic", cloud); player.hurtTime = 0;
			harm.reset(id);
			check(harm.sample(id, player) == null, "a stale magic source without hurt or health loss does not create cloud harm");
			player.immune = true; player.hurtTime = 10;
			check(harm.sample(id, player) == null, "immune cloud contact does not fabricate harm");
			player.immune = false; player.hurtTime = 0; player.damage = null;
			cloud.waiting = true; level.tick++; int queriesBefore = level.queries;
			var arming = CloudDanger.sample(player, () -> (x, y, z) -> y == 63 ? new DropAhead.Cell(DropAhead.Kind.SOLID, 1) : DropAhead.Cell.OPEN);
			check(arming.get(0).getAsJsonObject().get("arming").getAsBoolean() && !arming.get(0).getAsJsonObject().has("harmful"), "Java serialization distinguishes arming breath from harmful breath");
			cloud.waiting = false; level.tick++;
			var reads = new java.util.concurrent.atomic.AtomicInteger();
			java.util.function.Supplier<DropAhead.Cells> terrain = () -> { reads.incrementAndGet(); return (x,y,z) -> y == 63 ? new DropAhead.Cell(DropAhead.Kind.SOLID, 1) : DropAhead.Cell.OPEN; };
			var rows = CloudDanger.sample(player, terrain); var row = rows.get(0).getAsJsonObject();
			check(row.get("harmful").getAsBoolean() && row.has("bounds") && row.has("nearestExit") && row.get("exitRoute").getAsString().equals("unverified"), "Java cloud serializer includes harmful contact, bounds and an explicitly unverified exit");
			rows.remove(0);
			check(CloudDanger.sample(player, terrain).size() == 1 && reads.get() == 1, "one terrain construction and cached serialization per tick, with independent output copies");
			check(level.queries - queriesBefore == 2, "raw signals and repeated observations share one exposure query per tick");
			cloud.lingering = true; level.tick++;
			var unknown = CloudDanger.exposures(player).getFirst();
			check(unknown.contact() && !unknown.harmful(), "an untested lingering cloud remains uncertain rather than exposing hidden potion effects");
			check(CloudDanger.contactSource(player) == null, "untested lingering particles alone do not fabricate received damage");
			player.damage = damage("indirectMagic", cloud);
			player.hurtTime = 10;
			check(CloudDanger.contactSource(player).equals("minecraft:lingering_potion"), "received cloud magic identifies a harmful lingering cloud");
			level.tick++; CloudDanger.exposures(player);
			player.hurtTime = 0;
			level.tick++;
			check(CloudDanger.exposures(player).getFirst().harmful(), "observed harmful lingering cloud stays a danger between pulses");
			cloud.lingering = false; level.tick++;
			set(player, "position", new Vec3(0.5, 65, 0.5));
			set(player, "bb", new AABB(0.2, 65, 0.2, 0.8, 66.8, 0.8));
			check(CloudDanger.contactSource(player) == null, "jumping clear of cloud height removes damage contact");
			var nearby = (CloudPlayer) unsafe.allocateInstance(CloudPlayer.class); nearby.world = level; set(nearby, "id", 1003);
			nearby.setId(1023); // 26.3 assigns entity IDs in the constructor, which Unsafe allocation skips.
			set(nearby, "position", new Vec3(.5, 64, -3.5));
			set(nearby, "bb", new AABB(.2,64,-3.8,.8,65.8,-3.2));
			set(nearby, "eyeHeight", 1.62F); set(nearby, "deltaMovement", Vec3.ZERO);
			cloud.waiting = true;
			var appearance = VisibleAppearance.entity(nearby, cloud);
			check(appearance.get("arming").getAsBoolean() && !appearance.has("harmful"), "visible appearance also reports arming without harmfulness");
			cloud.waiting = false;
			check(VisibleAppearance.entity(nearby, cloud).get("harmful").getAsBoolean(), "active breath appearance reports harmfulness");
			check(CloudDanger.nearestHarmful(nearby, 1.0) == cloud, "seen breath whose edge is 1 block away is near within 1");
			check(CloudDanger.nearestHarmful(nearby, 0.5) == null, "breath 1 block away is not near within 0.5");
			cloud.waiting = true;
			check(CloudDanger.nearestHarmful(nearby, 1.0) == cloud, "arming breath already counts: it will hurt once armed");
			cloud.waiting = false;
			cloud.lingering = true;
			check(CloudDanger.nearestHarmful(nearby, 1.0) == null, "an untested lingering cloud is not assumed harmful");
			cloud.lingering = false;
			var seen = CloudDanger.signalKeys(nearby);
			check(seen.size() == 1 && seen.contains(CloudDanger.key(cloud.getUUID().toString(), false)), "first visible sighting in danger range alerts before contact");
			set(nearby, "position", new Vec3(.5,64,.5)); set(nearby, "bb", new AABB(.2,64,.2,.8,65.8,.8)); level.tick++;
			var touched = CloudDanger.signalKeys(nearby);
			check(touched.size() == 2 && touched.containsAll(seen), "first contact adds exactly one UUID-keyed alert");
			set(nearby, "position", new Vec3(.5,64,-3.5)); set(nearby, "bb", new AABB(.2,64,-3.8,.8,65.8,-3.2)); level.tick++;
			check(CloudDanger.signalKeys(nearby).equals(touched), "leaving preserves delivered cloud edges");
			set(nearby, "position", new Vec3(.5,64,.5)); set(nearby, "bb", new AABB(.2,64,.2,.8,65.8,.8)); level.tick++;
			check(CloudDanger.signalKeys(nearby).equals(touched), "re-entry cannot generate another cloud alert");
		} catch (ReflectiveOperationException failure) { throw new AssertionError(failure); }
	}
	private static net.minecraft.world.damagesource.DamageSource damage(String type, net.minecraft.world.entity.Entity direct) {
		var key = net.minecraft.resources.ResourceKey.create(net.minecraft.core.registries.Registries.DAMAGE_TYPE,
				net.minecraft.resources.Identifier.withDefaultNamespace(type.equals("indirectMagic") ? "indirect_magic" : type));
		var holder = net.minecraft.core.Holder.Reference.createStandAlone(new net.minecraft.core.HolderOwner<net.minecraft.world.damagesource.DamageType>() { }, key);
		try {
			var value = net.minecraft.core.Holder.Reference.class.getDeclaredField("value"); value.setAccessible(true);
			value.set(holder, new net.minecraft.world.damagesource.DamageType(type, .1F));
		} catch (ReflectiveOperationException failure) { throw new AssertionError(failure); }
		return new net.minecraft.world.damagesource.DamageSource(holder, direct);
	}
	private static void set(Object target, String name, Object value) throws ReflectiveOperationException {
		var field = net.minecraft.world.entity.Entity.class.getDeclaredField(name); field.setAccessible(true); field.set(target, value);
	}
	private static final class CloudPlayer extends net.minecraft.server.level.ServerPlayer {
		CloudLevel world;
		float health;
		boolean immune;
		@Override public float getHealth() { return health; }
		@Override public float getAbsorptionAmount() { return 0; }
		@Override public boolean isAlive() { return true; }
		@Override public boolean fireImmune() { return false; }
		@Override public boolean isSpectator() { return false; }
		@Override public boolean isDescending() { return false; }
		@Override public net.minecraft.world.item.ItemStack getMainHandItem() { return net.minecraft.world.item.ItemStack.EMPTY; }
		@Override public boolean isOnFire() { return false; }
		@Override public boolean isInLava() { return false; }
		@Override public boolean isUnderWater() { return false; }
		@Override public boolean isInWall() { return false; }
		@Override public int getTicksFrozen() { return 0; }
		@Override public boolean hasEffect(net.minecraft.core.Holder<net.minecraft.world.effect.MobEffect> effect) { return false; }
		@Override public net.minecraft.world.entity.player.Abilities getAbilities() { var abilities = new net.minecraft.world.entity.player.Abilities(); abilities.invulnerable = immune; return abilities; }
		@Override public net.minecraft.world.food.FoodData getFoodData() { return new net.minecraft.world.food.FoodData(); }
		net.minecraft.world.damagesource.DamageSource damage;
		@Override public net.minecraft.world.damagesource.DamageSource getLastDamageSource() { return damage; }
		CloudPlayer() { super(null, null, null, null); }
		@Override public net.minecraft.server.level.ServerLevel level() { return world; }
	}
	private static final class CloudLevel extends net.minecraft.server.level.ServerLevel {
		// 26.3 entities take their ID from the level, and ServerLevel asks its (absent) chunk source.
		private int fixtureEntityIds = 100_000;
		@Override public int getNextEntityId() { return ++fixtureEntityIds; }
		VisibleCloud cloud;
		long tick; int queries;
		CloudLevel() { super(null, null, null, null, null, null, false, 0, java.util.List.of(), false); }
		@Override public long getGameTime() { return tick; }
		@Override public net.minecraft.world.attribute.EnvironmentAttributeSystem environmentAttributes() {
			return net.minecraft.world.attribute.EnvironmentAttributeSystem.builder().build();
		}
		@Override public int getMinY() { return -64; }
		@Override public boolean hasChunkAt(net.minecraft.core.BlockPos at) { return true; }
		@Override public net.minecraft.world.level.block.state.BlockState getBlockState(net.minecraft.core.BlockPos at) { return net.minecraft.world.level.block.Blocks.AIR.defaultBlockState(); }
		@Override public net.minecraft.world.level.material.FluidState getFluidState(net.minecraft.core.BlockPos at) { return getBlockState(at).getFluidState(); }
		@Override public net.minecraft.world.phys.BlockHitResult clip(net.minecraft.world.level.ClipContext context) {
			return net.minecraft.world.phys.BlockHitResult.miss(context.getTo(), net.minecraft.core.Direction.UP, net.minecraft.core.BlockPos.containing(context.getTo()));
		}
		@Override public <T extends net.minecraft.world.entity.Entity> java.util.List<T> getEntitiesOfClass(Class<T> type, AABB area, java.util.function.Predicate<? super T> predicate) {
			queries++;
			return type.isInstance(cloud) && area.intersects(cloud.getBoundingBox()) && predicate.test(type.cast(cloud)) ? java.util.List.of(type.cast(cloud)) : java.util.List.of();
		}
	}
	private static final class VisibleCloud extends net.minecraft.world.entity.AreaEffectCloud {
		boolean lingering, waiting;
		@Override public boolean isWaiting() { return waiting; }
		VisibleCloud() { super(net.minecraft.world.entity.EntityTypes.AREA_EFFECT_CLOUD, null); }
		@Override public net.minecraft.core.particles.ParticleOptions getParticle() {
			return lingering ? net.minecraft.core.particles.ParticleTypes.SMOKE : net.minecraft.core.particles.PowerParticleOption.create(net.minecraft.core.particles.ParticleTypes.DRAGON_BREATH, 1);
		}
		@Override public float getRadius() { return 3; }
		@Override public boolean isInvisibleTo(net.minecraft.world.entity.player.Player player) { return false; }
	}

	private static JsonObject observation(boolean cloud, boolean contact, boolean harmful) {
		JsonObject observation = new JsonObject(), player = new JsonObject(), action = new JsonObject();
		action.addProperty("active", true); action.addProperty("actionType", "control");
		observation.add("currentAction", action); observation.add("player", player);
		if (cloud) {
			JsonObject row = new JsonObject(); row.addProperty("uuid", "cloud"); row.addProperty("contact", contact); row.addProperty("harmful", harmful);
			JsonArray rows = new JsonArray(); rows.add(row); player.add("clouds", rows);
		}
		return observation;
	}
	private static void check(boolean value, String reason) { assertions++; if (!value) throw new AssertionError(reason); }
}
