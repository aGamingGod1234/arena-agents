package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.client.navigation.WalkabilityView;
import dev.agaminggod.arenaagents.server.perception.SeenTerrain;
import java.util.HashMap;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;

/**
 * Hazard on the shared seen-terrain memory (fight review r3, hazard adoption): one memory for fight, flee and hazard, so
 * a cell one consumer perceived is what the other remembers, hidden changes stay hidden, the no-ray shortcut holds,
 * ages carry over and "seen" means the eye.
 */
public final class SeenHazardAdoptionVerification {
	private static int assertions;

	private SeenHazardAdoptionVerification() {
	}

	public static void main(String[] args) {
		System.out.println("PASS: " + verify() + " shared hazard terrain assertions");
	}

	private static final class World implements BlockGetter, SeenTerrain.Source<BlockState> {
		final Map<BlockPos, BlockState> states = new HashMap<>();
		boolean sight;
		boolean touch;
		int rays;
		int liveReads;

		@Override
		public BlockEntity getBlockEntity(BlockPos position) {
			return null;
		}

		@Override
		public BlockState getBlockState(BlockPos position) {
			return states.getOrDefault(position, position.getY() <= 64 ? Blocks.STONE.defaultBlockState() : Blocks.AIR.defaultBlockState());
		}

		@Override
		public FluidState getFluidState(BlockPos position) {
			return getBlockState(position).getFluidState();
		}

		@Override
		public int getHeight() {
			return 384;
		}

		@Override
		public int getMinY() {
			return -64;
		}

		@Override
		public BlockState live(int x, int y, int z) {
			liveReads++;
			return getBlockState(new BlockPos(x, y, z));
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

	public static int verify() {
		assertions = 0;
		World world = new World();
		SeenTerrain.Memory<BlockState> memory = new SeenTerrain.Memory<>();
		BlockPos pool = new BlockPos(2, 65, 0);
		world.states.put(pool, Blocks.LAVA.defaultBlockState());

		// Fight/flee perceive the lava first; hazard reads it hidden later: remembered, with its age, never live.
		world.sight = true;
		new SeenTerrain.Reader<>(memory, world, 0L, null).known(2, 65, 0);
		world.sight = false;
		world.states.put(pool, Blocks.AIR.defaultBlockState());
		// (Block tags are not bound in core checks, so the lava class itself is HazardExits.classify's own test; here the
		// remembered state and the solid/open classes carry the proof.)
		SeenTerrain.Reader<BlockState> later = new SeenTerrain.Reader<>(memory, world, 60L, null);
		HazardExits.Cells hazard = SeenHazardTerrain.over(later, world);
		check(hazard.at(2, 65, 0) != HazardExits.Cell.UNKNOWN && later.known(2, 65, 0).is(Blocks.LAVA),
				"lava fight saw is known to hazard as the lava it saw, though it drained out of sight");
		check(hazard.secondsSinceSeen(2, 65, 0) == 3, "with the age since fight saw it (3 s)");
		check(SeenHazardTerrain.over(new SeenTerrain.Reader<>(memory, world, 201L, null), world).at(2, 65, 0) == HazardExits.Cell.UNKNOWN,
				"10 s after anyone saw it, it is unknown to hazard too");
		BlockPos wall = new BlockPos(4, 65, 0);
		world.states.put(wall, Blocks.STONE.defaultBlockState());
		world.sight = true;
		new SeenTerrain.Reader<>(memory, world, 70L, null).known(4, 65, 0);
		world.sight = false;
		world.states.put(wall, Blocks.AIR.defaultBlockState());
		check(SeenHazardTerrain.over(new SeenTerrain.Reader<>(memory, world, 90L, null), world).at(4, 65, 0) == HazardExits.Cell.SOLID,
				"a wall fight saw, mined out of sight, is still SOLID to hazard (remembered state reclassified, not live)");

		// The reverse: hazard sees a floor; the fight's navigation class of it, hidden later, is the remembered one.
		SeenTerrain.Memory<BlockState> shared = new SeenTerrain.Memory<>();
		BlockPos floor = new BlockPos(-3, 64, 0);
		world.sight = true;
		check(SeenHazardTerrain.over(new SeenTerrain.Reader<>(shared, world, 0L, null), world).at(-3, 64, 0) == HazardExits.Cell.SOLID,
				"hazard sees the floor");
		world.sight = false;
		world.states.put(floor, Blocks.AIR.defaultBlockState());
		BlockState remembered = new SeenTerrain.Reader<>(shared, world, 40L, null).known(-3, 64, 0);
		check(remembered != null && MinecraftNavigationWorld.classifyCell(remembered, remembered.getCollisionShape(world, floor), false)
				== WalkabilityView.Cell.SAFE_SUPPORT, "fight reads the floor hazard saw as support, though it was mined out of sight");

		// No ray for a cell neither remembered nor now of the asked kind (hazard's is() shortcut on the shared memory).
		world.rays = 0;
		world.sight = true;
		HazardExits.Cells fresh = SeenHazardTerrain.over(new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), world, 0L, null), world);
		check(!fresh.is(5, 65, 0, HazardExits.Cell.LAVA) && world.rays == 0, "asking whether open air is lava casts no ray");
		check(fresh.is(5, 64, 0, HazardExits.Cell.SOLID) && world.rays == 1, "asking whether a block is solid casts one");
		check(fresh.secondsSinceSeen(5, 64, 0) == 0, "and a cell seen now has no age");

		// "seen" means the eye: lava the body touches but does not see is known, yet not eye-seen.
		SeenTerrain.Memory<BlockState> touched = new SeenTerrain.Memory<>();
		world.states.put(pool, Blocks.LAVA.defaultBlockState());
		world.sight = false;
		world.touch = true;
		SeenTerrain.Reader<BlockState> body = new SeenTerrain.Reader<>(touched, world, 0L, null);
		check(body.seesNow(2, 65, 0) && !body.eyeSeesNow(2, 65, 0), "touched lava is perceived but not seen by the eye");
		world.touch = false;
		world.sight = true;
		check(new SeenTerrain.Reader<>(touched, world, 1L, null).eyeSeesNow(2, 65, 0), "lava in view is seen by the eye");

		// A shore walked before falling into a deep lake remains a landing even well above the body's current y.
		SeenTerrain.Memory<BlockState> shore = new SeenTerrain.Memory<>();
		world.sight = false;
		world.touch = true;
		SeenTerrain.Reader<BlockState> walked = new SeenTerrain.Reader<>(shore, world, 0L, null);
		for (int y = 64; y <= 66; y++) walked.known(-6, y, 0);
		world.touch = false;
		world.rays = 0;
		world.states.put(new BlockPos(-6, 64, 0), Blocks.AIR.defaultBlockState());
		HazardExits.Exit landing = HazardExits.recallLanding(SeenHazardTerrain.over(new SeenTerrain.Reader<>(shore, world, 240L, null), world),
				new net.minecraft.world.phys.Vec3(0.5D, 55.0D, 0.5D), -90.0F);
		check(landing != null && landing.up() == 10 && landing.seenAgoS() == 12 && landing.unseen(),
				"walked shore survives 12 s behind and above the sunk body, labelled as remembered with an unknown route");
		check(world.rays == 0, "recalling the shore needs no live sight or hidden world inference");
		world.liveReads = 0;
		SeenTerrain.Reader<BlockState> submerged = new SeenTerrain.Reader<>(shore, world, 240L, null);
		HazardExits.Cells opaque = SeenHazardTerrain.over(submerged, world, true);
		check(opaque.is(-6, 64, 0, HazardExits.Cell.SOLID) && opaque.secondsSinceSeen(-6, 64, 0) == 12,
				"opaque lava reads a hidden changed floor as the saved floor with its age");
		check(!opaque.is(15, 64, 0, HazardExits.Cell.SOLID), "opaque lava cannot learn an untouched hidden floor");
		check(world.liveReads == 0 && world.rays == 0, "opaque hazard reads make no impossible world reads or sight rays");
		check(HazardExits.recallLanding(SeenHazardTerrain.over(new SeenTerrain.Reader<>(shore, world, 601L, null), world),
				new net.minecraft.world.phys.Vec3(0.5D, 55.0D, 0.5D), -90.0F) == null, "walked landing expires after 30 s");
		world.touch = true;
		HazardExits.Cells felt = SeenHazardTerrain.over(new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), world, 601L, null), world, true);
		check(felt.at(-6, 64, 0) == HazardExits.Cell.OPEN && felt.secondsSinceSeen(-6, 64, 0) == 0,
				"current body contact remains live even while the eye is in opaque lava");
		SeenTerrain.Memory<BlockState> changed = new SeenTerrain.Memory<>();
		world.states.put(new BlockPos(-6, 64, 0), Blocks.STONE.defaultBlockState());
		SeenTerrain.Reader<BlockState> initial = new SeenTerrain.Reader<>(changed, world, 620L, null);
		for (int y = 64; y <= 66; y++) initial.known(-6, y, 0);
		HazardExits.Cells initialLandings = SeenHazardTerrain.over(initial, world, true);
		boolean wasLanding = initialLandings.rememberedPositions().length == 1;
		world.states.put(new BlockPos(-6, 64, 0), Blocks.AIR.defaultBlockState());
		SeenTerrain.Reader<BlockState> updated = new SeenTerrain.Reader<>(changed, world, 621L, null);
		updated.known(-6, 64, 0);
		check(wasLanding && SeenHazardTerrain.over(updated, world, true).rememberedPositions().length == 0,
				"a newly perceived floor change invalidates saved landing geometry without keeping a stale destination");
		SeenTerrain.Reader<BlockState> current = new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), world, 622L, null);
		world.states.put(new BlockPos(-6, 64, 0), Blocks.STONE.defaultBlockState());
		for (int y = 64; y <= 66; y++) current.known(-6, y, 0);
		check(current.recalledAge(-6, 65, 0) == 0, "a landing perceived this tick is not labelled remembered 1s");
		HazardExits.Exit currentLanding = HazardExits.recallLanding(SeenHazardTerrain.over(current, world, true),
				new net.minecraft.world.phys.Vec3(0.5D, 55.0D, 0.5D), -90.0F);
		check(currentLanding != null && currentLanding.seenAgoS() == 0,
				"recall preserves the zero age of all three landing cells perceived this tick");
		return assertions + SeenPreparationContractVerification.verify();
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
