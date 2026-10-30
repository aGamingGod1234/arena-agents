package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonObject;
import java.util.List;
import java.util.Set;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

public final class ProjectilePerceptionVerification {
	private static int assertions;
	public static int verify() {
		assertions = 0;
		AABB player = new AABB(-0.3D, 0.0D, -0.3D, 0.3D, 1.8D, 0.3D);
		check(Double.isFinite(impact(new Vec3(0, 1, 10), new Vec3(0, 0, -1), player, true)), "incoming fireball");
		check(Double.isFinite(impact(new Vec3(0, 1, 5), new Vec3(0, 0, -2), player, false)), "arrow or crossbow bolt");
		check(Double.isFinite(impact(new Vec3(0, 1, 5), new Vec3(0, 0, -1.5), player, false)), "trident");
		check(Double.isNaN(impact(new Vec3(0, 1, 5), new Vec3(0, 0, 1), player, true)), "receding");
		check(Double.isNaN(impact(new Vec3(0, 1, 5), Vec3.ZERO, player, false)), "embedded or stationary");
		check(Double.isNaN(impact(new Vec3(5, 1, 5), new Vec3(0, 0, -1), player, true)), "passes beside");
		// A small fireball (half width 0.156) grazing 0.25 past the hitbox still lands: vanilla widens the box by 0.3.
		check(Math.abs(ProjectilePerception.HIT_MARGIN - 0.3D) < 1.0E-6D, "vanilla projectile hit margin");
		check(Double.isFinite(ProjectilePerception.impactSeconds(new Vec3(0.55D, 1, 10), new Vec3(0, 0, -1), player, Vec3.ZERO, true, ProjectilePerception.HIT_MARGIN)), "grazing fireball lands");
		check(Double.isNaN(ProjectilePerception.impactSeconds(new Vec3(0.55D, 1, 10), new Vec3(0, 0, -1), player, Vec3.ZERO, true, 0.15625D)), "half-width radius misses the graze");
		check(Double.isNaN(impact(new Vec3(0, 8, 5), new Vec3(0, 0, -1), player, true)), "passes overhead");
		check(Double.isNaN(impact(new Vec3(0, 1, 100), new Vec3(0, 0, -1), player, true)), "outside short horizon");
		check(Double.isNaN(ProjectilePerception.impactSeconds(new Vec3(0,1,5), new Vec3(0,0,-1), player, new Vec3(0,0,-1), true, 0)), "relative motion");
		check(Double.isNaN(impact(new Vec3(0, 1, 20), new Vec3(0, 0, -1), player, false)), "gravity takes low arrow below body");
		for (String type : List.of("minecraft:arrow", "minecraft:spectral_arrow", "minecraft:trident", "minecraft:fireball", "minecraft:small_fireball", "minecraft:dragon_fireball")) check(ProjectilePerception.supported(type), type);
		check(!ProjectilePerception.supported("minecraft:snowball"), "harmless snowball omitted");
		JsonObject before = new JsonObject(); JsonObject after = new JsonObject();
		var row = new ProjectilePerception.Entry("projectile", "minecraft:arrow", 0, 1, true, true, false);
		after.add("incomingProjectiles", ProjectilePerception.toJson(new ProjectilePerception.Snapshot(List.of(row), Set.of())));
		check(AttentionSignalPolicy.changedFacts(before, after).contains("projectile"), "new flight raises attention");
		row = new ProjectilePerception.Entry("projectile", "minecraft:arrow", 0, 0.4, true, false, false);
		after.add("incomingProjectiles", ProjectilePerception.toJson(new ProjectilePerception.Snapshot(List.of(row), Set.of())));
		check(!AttentionSignalPolicy.changedFacts(before, after).contains("projectile"), "same flight stays quiet");
		row = new ProjectilePerception.Entry("projectile", "minecraft:arrow", 0, 0.4, true, false, true);
		after.add("incomingProjectiles", ProjectilePerception.toJson(new ProjectilePerception.Snapshot(List.of(row), Set.of())));
		check(AttentionSignalPolicy.changedFacts(before, after).contains("projectile"), "near collision edge raises attention");
		check(ProjectilePerception.toJson(new ProjectilePerception.Snapshot(List.of(), Set.of())) == null, "no always-sent bytes");
		var dragon = new ProjectilePerception.Entry("H1", "minecraft:dragon_fireball", 0, 1.39, true, true, false);
		var dragonFacts = ProjectilePerception.toJson(new ProjectilePerception.Snapshot(List.of(dragon), Set.of())).get(0).getAsJsonObject();
		check(!dragonFacts.get("shieldBlockable").getAsBoolean(), "H1 dragon cloud is explicitly not shield-blockable");
		check(dragonFacts.get("etaSeconds").getAsDouble() == 1.39D, "H1 retained ETA is exposed without a fixed hold assumption");
		check(!ProjectilePerception.shieldBlockable("minecraft:arrow", true), "piercing arrows bypass shield protection");
		check(ProjectilePerception.shieldBlockable("minecraft:arrow", false), "ordinary frontal arrows can be shielded");
		check(ProjectilePerception.damaging(false, -1, false, "minecraft:arrow"), "ordinary arrow damages");
		check(!ProjectilePerception.damaging(true, -1, false, "minecraft:arrow"), "creative body does not take damage");
		check(!ProjectilePerception.damaging(false, 4, false, "minecraft:arrow"), "Resistance V prevents damage");
		check(!ProjectilePerception.damaging(false, -1, true, "minecraft:small_fireball"), "fire resistance prevents small fireball damage");
		check(!ProjectilePerception.shieldBlocks(true, new Vec3(0, 0, 1), new Vec3(0, 1, 5), "minecraft:dragon_fireball", false), "shield does not stop a dragon fireball's cloud");
		check(ProjectilePerception.damaging(false, -1, true, "minecraft:fireball"), "fire resistance does not prevent ghast explosion");
		Vec3 gravity = new Vec3(0, -0.0784D, 0);
		check(Double.isNaN(ProjectilePerception.impactSeconds(new Vec3(0.2D, 0.1D, 0), Vec3.ZERO, player, gravity, false, 0.25D)), "floor arrow ignored with grounded gravity");
		check(Double.isNaN(ProjectilePerception.impactSeconds(new Vec3(0, 0.1D, 1.5D), Vec3.ZERO, player, new Vec3(0, -0.0784D, 0.216D), false, 0.25D)), "walking into a grounded arrow is not incoming flight");
		check(!ProjectilePerception.flying(true, new Vec3(0, 0, -1)), "embedded arrow or trident excluded before prediction");
		check(!ProjectilePerception.flying(false, new Vec3(0, 0, -0.09D)), "slow own flight excluded");
		check(ProjectilePerception.flying(false, new Vec3(0, 0, -0.11D)), "moving projectile retained");
		check(ProjectilePerception.impactSeconds(new Vec3(0, 1, 5), new Vec3(0, 0, -2), player, gravity, false, 0.1D) == impact(new Vec3(0, 1, 5), new Vec3(0, 0, -2), player, false), "ground gravity does not inflate predicted approach");
		check(Double.isFinite(ProjectilePerception.impactSeconds(new Vec3(0, 1, 5), new Vec3(0, 0, -2), player, new Vec3(0, -0.0784D, 0.216D), false, 0.1D)), "real arrow detected while walking");
		check(ProjectilePerception.shieldBlocks(true, new Vec3(0, 0, 1), new Vec3(0, 1, 5), "minecraft:arrow", false), "active frontal shield blocks arrow");
		check(!ProjectilePerception.shieldBlocks(true, new Vec3(0, 0, 1), new Vec3(0, 1, -5), "minecraft:arrow", false), "shield cannot block from behind");
		check(!ProjectilePerception.shieldBlocks(false, new Vec3(0, 0, 1), new Vec3(0, 1, 5), "minecraft:arrow", false), "equipped inactive shield is insufficient");
		check(!ProjectilePerception.shieldBlocks(true, new Vec3(0, 0, 1), new Vec3(0, 1, 5), "minecraft:fireball", false), "shield does not promise immunity to ghast explosion");
		check(!ProjectilePerception.shieldBlocks(true, new Vec3(0, 0, 1), new Vec3(0, 1, 5), "minecraft:arrow", true), "piercing arrow bypasses active frontal shield");
		AABB wall = new AABB(-1, -1, 2, 1, 3, 3).inflate(1.0E-7D);
		for (boolean fireball : List.of(false, true)) {
			check(Double.isNaN(ProjectilePerception.impactSeconds(new Vec3(0, 1, 5), new Vec3(0, 0, -2), player, Vec3.ZERO, fireball, 0.1D,
					(from, to) -> wall.clip(from, to).isEmpty() && !wall.contains(from))), "visible projectile blocked by wall has no impact prediction");
			check(Double.isFinite(ProjectilePerception.impactSeconds(new Vec3(0, 1, 5), new Vec3(0, 0, -2), player, Vec3.ZERO, fireball, 0.1D,
					(from, to) -> true)), "unblocked visible flight retains impact prediction");
		}
		check(Double.isNaN(ProjectilePerception.impactSeconds(new Vec3(0, 1, 5), new Vec3(0, 0, -2), player, new Vec3(0, 0, 0.216D), false, 0.1D,
				(from, to) -> wall.clip(from, to).isEmpty() && !wall.contains(from))), "moving player cannot shift arrow flight through a wall");
		AABB behindPlayer = new AABB(-1, -1, -3, 1, 3, -2);
		check(Double.isFinite(ProjectilePerception.impactSeconds(new Vec3(0, 1, 5), new Vec3(0, 0, -2), player, Vec3.ZERO, false, 0.1D,
				(from, to) -> behindPlayer.clip(from, to).isEmpty())), "terrain after body impact cannot hide incoming arrow");
		return assertions;
	}
	private static double impact(Vec3 p, Vec3 v, AABB b, boolean fireball) { return ProjectilePerception.impactSeconds(p, v, b, Vec3.ZERO, fireball, 0.1D); }
	private static void check(boolean value, String label) { assertions++; if (!value) throw new AssertionError(label); }
}
