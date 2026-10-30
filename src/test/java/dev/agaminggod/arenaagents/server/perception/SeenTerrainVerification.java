package dev.agaminggod.arenaagents.server.perception;

import java.util.HashMap;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/**
 * Fight review r3 findings on the shared seen-terrain memory: expired cells are reclaimed even when nobody asks for
 * them again, the last-seen tick follows actual sightings, ground the body walked is remembered (30 s), the foot
 * surface (not a whole cell below it) is touched, and the log of acquired facts says when knowledge moved on.
 */
public final class SeenTerrainVerification {
	private static int assertions;

	private SeenTerrainVerification() {
	}

	public static void main(String[] args) {
		System.out.println("SeenTerrainVerification: " + verify() + " assertions passed");
	}

	public static int verify() {
		assertions = 0;
		verifyPrune();
		verifyLastSighting();
		verifyWalkedFooting();
		verifyFootSurface();
		verifyFactLog();
		verifyInspectionSightline();
		return assertions;
	}

	/** A world of named values; the eye sees {@code sight} and the body touches {@code touch}. */
	private static final class World implements SeenTerrain.Source<String> {
		final Map<Long, String> values = new HashMap<>();
		boolean sight;
		boolean touch;
		int rays;

		@Override
		public String live(int x, int y, int z) {
			return values.getOrDefault(BlockPos.asLong(x, y, z), "air");
		}

		@Override
		public boolean sees(int x, int y, int z) {
			rays++;
			return sight;
		}

		@Override
		public boolean touches(int x, int y, int z) {
			return touch;
		}
	}

	private static SeenTerrain.Reader<String> at(SeenTerrain.Memory<String> memory, World world, long tick) {
		return new SeenTerrain.Reader<>(memory, world, tick, null);
	}

	/** The reviewer's probe: 1,000 cells seen at tick 1, a reader at tick 222 that never asks for them: all gone. */
	private static void verifyPrune() {
		SeenTerrain.Memory<String> memory = new SeenTerrain.Memory<>();
		World world = new World();
		world.sight = true;
		SeenTerrain.Reader<String> first = at(memory, world, 1L);
		for (int x = 0; x < 1000; x++) first.known(x, 64, 0);
		check(memory.size() == 1000, "1,000 cells seen are remembered");
		at(memory, world, 120L);
		check(memory.size() == 1000, "within 10 s nothing is dropped");
		at(memory, world, 222L);
		check(memory.size() == 0, "10 s after they were seen, cells nobody asked for again are reclaimed (r3: 1,000 left)");
		SeenTerrain.Memory<String> fresh = new SeenTerrain.Memory<>();
		at(fresh, world, 0L).known(0, 64, 0);
		at(fresh, world, 0L + SeenTerrain.MEMORY_TICKS + 1L);
		check(fresh.size() == 0, "the first prune of a new memory runs (no sentinel overflow) from tick 0 too");
	}

	/** Visible for 10 s then hidden: still known for 10 s more. Hidden for 10 s: forgotten, without a ray per tick. */
	private static void verifyLastSighting() {
		SeenTerrain.Memory<String> memory = new SeenTerrain.Memory<>();
		World world = new World();
		world.values.put(BlockPos.asLong(3, 64, 0), "lava");
		world.sight = true;
		for (long tick = 21L; tick <= 221L; tick++) {
			check("lava".equals(at(memory, world, tick).known(3, 64, 0)), "in view, the cell reads as it is");
		}
		check(world.rays <= 12, "an unchanged cell in view is checked about once a second, not every tick: " + world.rays);
		world.sight = false;
		SeenTerrain.Reader<String> hidden = at(memory, world, 222L);
		check("lava".equals(hidden.known(3, 64, 0)), "seen until tick 221 and hidden at 222, it is still known (r3: unknown)");
		check(hidden.secondsSinceSeen(3, 64, 0) <= 2, "and its age counts from the last sighting, not the first");
		check("lava".equals(at(memory, world, 221L + SeenTerrain.MEMORY_TICKS - RECHECK).known(3, 64, 0)),
				"it stays known for 10 s after it was last seen");
		check(at(memory, world, 221L + SeenTerrain.MEMORY_TICKS + 1L).known(3, 64, 0) == null, "and is then forgotten");

		SeenTerrain.Memory<String> once = new SeenTerrain.Memory<>();
		world.sight = true;
		at(once, world, 21L).known(3, 64, 0);
		world.sight = false;
		for (long tick = 22L; tick <= 221L; tick++) at(once, world, tick).known(3, 64, 0);
		check(at(once, world, 222L).known(3, 64, 0) == null,
				"seen once at tick 21 and hidden since, asking every tick does not keep it: forgotten after 10 s");
	}

	private static final long RECHECK = SeenTerrain.RECHECK_TICKS;

	/** Ground the body stood on is remembered for 30 s; a glance for 10 s. */
	private static void verifyWalkedFooting() {
		SeenTerrain.Memory<String> memory = new SeenTerrain.Memory<>();
		World world = new World();
		world.values.put(BlockPos.asLong(-1, 63, 0), "stone");
		world.touch = true;
		check("stone".equals(at(memory, world, 0L).known(-1, 63, 0)), "the block under the feet is known by touch");
		world.touch = false;
		check("stone".equals(at(memory, world, SeenTerrain.MEMORY_TICKS + 1L).known(-1, 63, 0)),
				"walked ground behind the body is still known after 10 s");
		check("stone".equals(at(memory, world, SeenTerrain.WALKED_MEMORY_TICKS).known(-1, 63, 0)), "for 30 s");
		check(at(memory, world, SeenTerrain.WALKED_MEMORY_TICKS + 1L).known(-1, 63, 0) == null, "then it is forgotten");
		world.values.put(BlockPos.asLong(-1, 63, 0), "air");
		SeenTerrain.Memory<String> walked = new SeenTerrain.Memory<>();
		world.touch = true;
		at(walked, world, 0L).known(-1, 63, 0);
		world.touch = false;
		world.values.put(BlockPos.asLong(-1, 63, 0), "lava");
		check("air".equals(at(walked, world, 100L).known(-1, 63, 0)), "a change out of sight stays unseen: it reads as walked");
		SeenTerrain.Reader<String> now = at(walked, world, 100L);
		check(!now.eyeSeesNow(-1, 63, 0) && now.remembers(-1, 63, 0), "remembered without being seen now");
	}

	/** Standing, the cells under the foot surface are touched: the slab itself on a bottom slab, not the one below. */
	private static void verifyFootSurface() {
		SeenTerrain.Contact slab = SeenTerrain.Contact.of(new AABB(0.2D, 63.5D, 0.2D, 0.8D, 65.3D, 0.8D), true);
		check(slab.contains(0, 63, 0) && !slab.contains(0, 62, 0), "on a bottom slab the slab is touched, the buried cell below is not");
		check(slab.contains(0, 65, 0) && !slab.contains(0, 66, 0), "the head cell is touched, the one above it is not");
		SeenTerrain.Contact full = SeenTerrain.Contact.of(new AABB(0.2D, 64.0D, 0.2D, 0.8D, 65.8D, 0.8D), true);
		check(full.contains(0, 63, 0) && !full.contains(0, 62, 0), "on a full block the block under the feet is touched");
		SeenTerrain.Contact falling = SeenTerrain.Contact.of(new AABB(0.2D, 64.0D, 0.2D, 0.8D, 65.8D, 0.8D), false);
		check(!falling.contains(0, 63, 0) && falling.contains(0, 64, 0), "falling or swimming nothing below is felt");
		SeenTerrain.Contact edge = SeenTerrain.Contact.of(new AABB(0.7D, 64.0D, 0.2D, 1.3D, 65.8D, 0.8D), true);
		check(edge.contains(1, 63, 0) && edge.contains(0, 63, 0) && !edge.contains(-1, 63, 0),
				"straddling two blocks both are touched, not the cell behind");
	}

	/** Facts acquired after a stamp are listed; the same value seen again is not a new fact. */
	private static void verifyFactLog() {
		SeenTerrain.Memory<String> memory = new SeenTerrain.Memory<>();
		World world = new World();
		world.sight = true;
		at(memory, world, 0L).known(1, 64, 0);
		SeenTerrain.Stamp stamp = memory.stamp();
		long cell = BlockPos.asLong(1, 64, 0);
		long other = BlockPos.asLong(2, 64, 0);
		at(memory, world, 40L).known(1, 64, 0);
		check(!memory.changedSince(stamp, key -> true), "seeing the same value again acquires no new fact");
		world.sight = false;
		world.values.put(cell, "stone");
		at(memory, world, 41L).known(1, 64, 0);
		check(!memory.changedSince(stamp, key -> true), "a change nobody perceived is no new fact");
		world.sight = true;
		at(memory, world, 42L).known(2, 64, 0);
		check(memory.changedSince(stamp, key -> key == other) && !memory.changedSince(stamp, key -> key == cell),
				"a newly seen cell is a new fact about that cell only");
		at(memory, world, 43L).known(1, 64, 0);
		check(memory.changedSince(stamp, key -> key == cell), "the change, once seen, is a new fact");
		check(new SeenTerrain.Memory<String>().changedSince(stamp, key -> false), "a stamp from another memory (a reset) counts as changed");
		at(memory, world, 43L + SeenTerrain.WALKED_MEMORY_TICKS + RECHECK + 1L);
		check(memory.changedSince(stamp, key -> false), "a stamp older than the log keeps counts as changed");
	}

	private static void verifyInspectionSightline() {
		SeenTerrain.Memory<String> memory = new SeenTerrain.Memory<>();
		World world = new World();
		world.sight = true;
		world.values.put(BlockPos.asLong(3, 64, 0), "slab");
		Vec3 eye = new Vec3(0.5D, 65.62D, 0.5D), target = new Vec3(3.5D, 64.5D, 0.5D);
		at(memory, world, 1L).acquireSightline(eye, target);
		check(memory.size() > 1, "focused inspection acquires the open ray cells as well as its target");
		check(world.rays == memory.size() && world.rays == 5, "the inspection reads only its five ray cells, once each");
		check(!at(memory, world, 1L).remembers(2, 64, 1), "inspection does not scan terrain outside its ray");
		world.sight = false;
		world.values.put(BlockPos.asLong(3, 64, 0), "stone");
		SeenTerrain.Reader<String> hidden = at(memory, world, 2L);
		check("slab".equals(hidden.known(3, 64, 0)), "the observed outline is remembered without learning a hidden change");
		check("air".equals(hidden.known(2, 65, 0)), "the observed ray's open cells remain known when hidden");
		SeenTerrain.Memory<String> unseen = new SeenTerrain.Memory<>();
		at(unseen, world, 2L).acquireSightline(eye, target);
		check(unseen.size() == 0, "inspection traversal cannot acquire cells that fail the perception gate");
		check(at(memory, world, SeenTerrain.MEMORY_TICKS + 2L).known(3, 64, 0) == null,
				"inspection facts retain the existing sight memory expiry");
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
