package dev.agaminggod.arenaagents.server.runtime.controller;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/**
 * mine_vein's choices over known block ids: what belongs to the tree or vein, where the body stands, what it reaches,
 * and what it never breaks. Before mine_vein a tree cost one model call per log (plus a select_tool); the measured
 * gather of 8 logs took 182-222 s. The fixtures count the blocks one mine_vein call plans and reaches.
 */
public final class VeinPlanVerification {
	private static int assertions;
	private static final double RANGE = 4.5D;

	private VeinPlanVerification() {
	}

	public static void main(String[] arguments) {
		System.out.println("PASS: " + verify() + " vein plan assertions");
	}

	public static int verify() {
		assertions = 0;
		verifyFamilies();
		verifyTree();
		verifyTallTree();
		verifyVein();
		return assertions;
	}

	private static void verifyFamilies() {
		check("tree:minecraft:oak_log".equals(VeinPlan.family("minecraft:oak_log")), "an oak log is a tree of its own species");
		check(!VeinPlan.family("minecraft:oak_log").equals(VeinPlan.family("minecraft:birch_log")), "a birch beside an oak is another tree");
		check(VeinPlan.kind(VeinPlan.family("minecraft:crimson_stem")) == VeinPlan.Kind.TREE, "a huge fungus stem is felled like a tree");
		check(VeinPlan.family("minecraft:stripped_oak_log") == null, "stripped logs are placed by players, never a tree");
		check(VeinPlan.family("minecraft:deepslate_iron_ore").equals(VeinPlan.family("minecraft:iron_ore")),
				"deepslate iron ore mines with the iron ore of the same vein");
		check(!VeinPlan.family("minecraft:iron_ore").equals(VeinPlan.family("minecraft:copper_ore")), "copper beside iron is another vein");
		check(VeinPlan.kind(VeinPlan.family("minecraft:ancient_debris")) == VeinPlan.Kind.VEIN, "ancient debris is mined as a vein");
		check(VeinPlan.family("minecraft:stone") == null && VeinPlan.family("minecraft:oak_leaves") == null, "stone and leaves are neither");
		check(VeinPlan.leaves("minecraft:oak_leaves") && !VeinPlan.leaves("minecraft:oak_log"), "leaves are what is cut to reach a branch");
	}

	/** A 6-log oak with a corner branch, a birch two blocks away; the body stands two blocks from the trunk. */
	private static void verifyTree() {
		Map<BlockPos, String> world = new HashMap<>();
		BlockPos base = new BlockPos(0, 64, 0);
		for (int y = 0; y < 5; y++) world.put(base.above(y), "minecraft:oak_log");
		BlockPos branch = new BlockPos(1, 68, 1);
		world.put(branch, "minecraft:oak_log");
		for (int y = 0; y < 5; y++) world.put(new BlockPos(3, 64 + y, 0), "minecraft:birch_log");
		for (int dx = -1; dx <= 1; dx++) for (int dz = -1; dz <= 1; dz++) if (dx != 0 || dz != 0) world.put(new BlockPos(dx, 67, dz), "minecraft:oak_leaves");
		world.put(new BlockPos(1, 68, 1), "minecraft:oak_log");
		List<BlockPos> logs = VeinPlan.component(List.of(new BlockPos(0, 66, 0)), VeinPlan.family("minecraft:oak_log"), world::get, 33);
		check(logs.size() == 6 && logs.contains(branch), "the corner branch belongs to the tree (26 neighbours): " + logs);
		check(logs.stream().noneMatch(at -> at.getX() == 3), "the birch two blocks away is never part of the oak");
		check(logs.getFirst().equals(new BlockPos(0, 66, 0)), "the block the model chose is first");
		Vec3 feet = new Vec3(-1.5D, 64.0D, 0.5D);
		check(VeinPlan.trunkBase(logs, feet).equals(base), "the trunk base is the lowest log");
		BlockPos stance = VeinPlan.stance(base, feet, at -> !world.containsKey(at) && at.getY() >= 64, at -> at.getY() == 63);
		check(new BlockPos(-1, 64, 0).equals(stance), "the stance is the open side of the trunk nearest the body: " + stance);
		check(VeinPlan.outOfReach(logs, RANGE, VeinPlan.eyeAt(stance), VeinPlan.columnEye(base)).isEmpty(),
				"every log of a 6-log oak is reached from beside the trunk or inside its column");
		check(!VeinPlan.outOfReach(logs, RANGE, VeinPlan.eyeAt(new BlockPos(-4, 64, 0))).isEmpty(),
				"from four blocks away the top of the tree is out of reach: the body must stand beside it");
		check(VeinPlan.stance(base, feet, at -> false, at -> true) == null, "no seen open side: no stance");
		check(VeinPlan.stance(base, feet, at -> true, at -> false) == null, "no seen solid floor: no stance");
		List<BlockPos> order = new ArrayList<>(logs);
		order.sort(VeinPlan.order(VeinPlan.Kind.TREE, VeinPlan.columnEye(base)));
		check(order.getFirst().equals(base) && order.get(1).equals(base.above()), "a tree is cut bottom up: " + order);
		for (int index = 1; index < order.size(); index++) check(order.get(index - 1).getY() <= order.get(index).getY(), "each next log is no lower");
		// Measured on this fixture: one mine_vein call plans every log; before, each log was its own mine call.
		check(logs.size() == 6, "one call plans the 6 breaks that took 6 mine calls (7 with the select_tool)");
		// A 2x2 trunk: the base column nearest the body is entered.
		List<BlockPos> wide = List.of(new BlockPos(0, 64, 0), new BlockPos(1, 64, 0), new BlockPos(0, 64, 1), new BlockPos(1, 64, 1), new BlockPos(0, 65, 0));
		check(VeinPlan.trunkBase(wide, new Vec3(2.5D, 64.0D, 1.5D)).equals(new BlockPos(1, 64, 1)), "a 2x2 trunk is entered at the column beside the body");
	}

	/** Column reach: standing in the trunk's cut base column, logs up to six above the feet are cut; the seventh is not. */
	private static void verifyTallTree() {
		BlockPos base = new BlockPos(10, 70, 10);
		Vec3 column = VeinPlan.columnEye(base);
		check(VeinPlan.reachable(column, base.above(6), RANGE), "the log six above the feet is cut looking straight up");
		check(!VeinPlan.reachable(column, base.above(7), RANGE), "the log seven above the feet is out of reach");
		List<BlockPos> seven = new ArrayList<>(), eight = new ArrayList<>();
		for (int y = 0; y < 8; y++) {
			if (y < 7) seven.add(base.above(y));
			eight.add(base.above(y));
		}
		BlockPos stance = base.west();
		check(VeinPlan.outOfReach(seven, RANGE, VeinPlan.eyeAt(stance), column).isEmpty(), "a 7-log trunk is felled whole");
		List<BlockPos> floating = VeinPlan.outOfReach(eight, RANGE, VeinPlan.eyeAt(stance), column);
		check(floating.equals(List.of(base.above(7))), "an 8-log trunk is refused: its seen top log would float: " + floating);
	}

	/** An iron vein around the body's feet: nothing under the body is broken, the rest is cut nearest first. */
	private static void verifyVein() {
		Map<BlockPos, String> world = new HashMap<>();
		BlockPos[] ores = { new BlockPos(1, 64, 0), new BlockPos(2, 64, 0), new BlockPos(2, 65, 1), new BlockPos(0, 63, 0), new BlockPos(1, 63, 0) };
		for (BlockPos ore : ores) world.put(ore, ore.getY() == 63 ? "minecraft:deepslate_iron_ore" : "minecraft:iron_ore");
		world.put(new BlockPos(3, 64, 0), "minecraft:coal_ore");
		List<BlockPos> vein = VeinPlan.component(List.of(ores[0]), VeinPlan.family("minecraft:iron_ore"), world::get, VeinPlan.SEARCH_LIMIT);
		check(vein.size() == 5, "the vein joins its deepslate half and its corner block: " + vein);
		check(vein.stream().noneMatch(at -> at.getX() == 3), "the coal beside it is another vein");
		AABB body = new AABB(0.2D, 64.0D, 0.2D, 0.8D, 65.8D, 0.8D);
		check(VeinPlan.underBody(body, new BlockPos(0, 63, 0)), "the ore the body stands on is never broken");
		check(!VeinPlan.underBody(body, new BlockPos(1, 63, 0)), "an ore beside the support is not under the body");
		check(!VeinPlan.underBody(body, new BlockPos(1, 64, 0)) && !VeinPlan.underBody(body, new BlockPos(0, 66, 0)),
				"ores at the feet's side or over the head are not under it");
		AABB edge = new AABB(0.8D, 64.0D, 0.2D, 1.4D, 65.8D, 0.8D);
		check(VeinPlan.underBody(edge, new BlockPos(1, 63, 0)) && VeinPlan.underBody(edge, new BlockPos(0, 63, 0)),
				"straddling two blocks, both supports are kept");
		Vec3 eye = new Vec3(0.5D, 65.62D, 0.5D);
		List<BlockPos> order = new ArrayList<>(vein);
		order.removeIf(at -> VeinPlan.underBody(body, at));
		order.sort(VeinPlan.order(VeinPlan.Kind.VEIN, eye));
		check(order.getFirst().equals(new BlockPos(1, 64, 0)), "the nearest ore is cut first: " + order);
		check(order.size() == 4 && order.stream().allMatch(at -> VeinPlan.reachable(eye, at, RANGE)),
				"the four ores not under the body are all in reach from where it stands");
		List<BlockPos> capped = VeinPlan.component(List.of(ores[0]), VeinPlan.family("minecraft:iron_ore"), world::get, 3);
		check(capped.size() == 3, "the search stops at its limit: " + capped);
	}

	private static void check(boolean value, String reason) {
		if (!value) throw new AssertionError(reason);
		assertions++;
	}
}
