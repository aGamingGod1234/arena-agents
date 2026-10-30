package dev.agaminggod.arenaagents.server.runtime;

import java.util.HashMap;
import java.util.Map;
import java.util.function.Predicate;
import dev.agaminggod.arenaagents.server.perception.SeenTerrain;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;

/** Wave 2 mine-visibility fixtures: vanilla's crosshair rule for mining, taken from the final-3 benchmark traces. */
public final class BreakSightlineVerification {
	private BreakSightlineVerification() {
	}

	public static int verify() {
		int assertions = 0;
		CollisionContext context = CollisionContext.empty();
		double reach = 4.5D;

		Fixture plants = new Fixture(position -> true);
		BlockPos plant = new BlockPos(1, 0, 0);
		BlockPos behind = new BlockPos(2, 0, 0);
		Vec3 plantEye = new Vec3(0, 0.3, 0.5);
		plants.put(behind, Blocks.STONE.defaultBlockState());
		for (var vegetation : new BlockState[] { Blocks.SHORT_GRASS.defaultBlockState(), Blocks.DANDELION.defaultBlockState(),
				Blocks.TALL_GRASS.defaultBlockState() }) {
			plants.put(plant, vegetation);
			check(BreakSightline.blocker(plants, context, plantEye, behind) != null,
					"vanilla outline rays hit grass and flowers rather than passing through"); assertions++;
			check(BreakSightline.plantToClear(plants, context, plantEye, behind, reach) != null,
					"the first instant-break grass/flower is eligible for physical clearing: " + vegetation); assertions++;
		}
		check(BreakSightline.clearablePlant(plants, plant, Blocks.LEAF_LITTER.defaultBlockState()),
				"run-1 leaf litter is eligible noncolliding instant-break vegetation"); assertions++;

		for (var eligible : new BlockState[] { Blocks.DEAD_BUSH.defaultBlockState(),
				Blocks.FERN.defaultBlockState() }) {
			check(BreakSightline.clearablePlant(plants, plant, eligible), "instant noncolliding vegetation is clearable: " + eligible); assertions++;
		}
		for (var excluded : new BlockState[] { Blocks.OAK_SAPLING.defaultBlockState(), Blocks.SUGAR_CANE.defaultBlockState(), Blocks.SWEET_BERRY_BUSH.defaultBlockState(),
				Blocks.SNOW.defaultBlockState() }) {
			check(!BreakSightline.clearablePlant(plants, plant, excluded), "nonreplaceable saplings, harvestable crops and snow are not implicitly cleared: " + excluded); assertions++;
		}
		for (var tall : new net.minecraft.world.level.block.Block[] { Blocks.LILAC, Blocks.ROSE_BUSH, Blocks.PEONY,
				Blocks.SUNFLOWER, Blocks.TALL_GRASS, Blocks.LARGE_FERN }) {
			Fixture pair = new Fixture(position -> true);
			pair.put(plant, tall.defaultBlockState().setValue(net.minecraft.world.level.block.DoublePlantBlock.HALF,
					net.minecraft.world.level.block.state.properties.DoubleBlockHalf.LOWER));
			pair.put(plant.above(), tall.defaultBlockState().setValue(net.minecraft.world.level.block.DoublePlantBlock.HALF,
					net.minecraft.world.level.block.state.properties.DoubleBlockHalf.UPPER));
			for (int y = 0; y <= 1; y++) {
				pair.put(behind.above(y), Blocks.STONE.defaultBlockState());
				var hit = BreakSightline.plantToClear(pair, context, plantEye.add(0, y, 0), behind.above(y), reach);
				check(hit != null && hit.getBlockPos().equals(plant.above(y)), "clear the ray-hit half without redirecting to its partner: " + tall + " half " + y); assertions++;
			}
		}

		plants.put(plant, Blocks.STONE.defaultBlockState());
		check(BreakSightline.plantToClear(plants, context, plantEye, behind, reach) == null,
				"a solid obstruction is never mined as a substitute for the requested target"); assertions++;
		plants.put(plant, Blocks.SHORT_GRASS.defaultBlockState());
		check(BreakSightline.plantToClear(plants, context, plantEye, behind, 0.2) == null,
				"plant clearing cannot extend vanilla reach"); assertions++;
		check(!BreakSightline.clearablePlant(plants, plant, Blocks.WHEAT.defaultBlockState()),
				"crops are not implicitly harvested to reach a different target"); assertions++;
		plants.put(plant, Blocks.AIR.defaultBlockState());
		check(validPlayerAim(plants, plantEye, BreakSightline.visiblePoint(plants, context, plantEye, behind, reach), behind, reach),
				"after the actual plant is removed the requested block has a vanilla crosshair aim"); assertions++;

		// A/S1-r1: the agent stood east of a two-log trunk and asked for the lower log. The line to its center enters the
		// upper log first, yet the lower log's east face is in plain view, so a player mines it from there.
		Fixture tree = new Fixture(position -> true);
		tree.put(new BlockPos(5, 87, 1), Blocks.OAK_LOG.defaultBlockState());
		tree.put(new BlockPos(5, 88, 1), Blocks.OAK_LOG.defaultBlockState());
		tree.floor(86, 0, 10, -3, 5);
		Vec3 treeEye = new Vec3(6.51D, 88.62D, 1.25D);
		BlockPos lowerLog = new BlockPos(5, 87, 1);
		BlockHitResult treeBlocker = BreakSightline.blocker(tree, context, treeEye, lowerLog);
		check(treeBlocker != null && treeBlocker.getBlockPos().equals(new BlockPos(5, 88, 1)), "the upper log is first on the line to the lower log's center");
		assertions++;

		// Review regressions: a valid outline ray can lie below every fixed face sample, or at the reach boundary.
		Fixture slit = new Fixture(position -> true);
		BlockPos slitTarget = new BlockPos(3, 0, 0);
		slit.put(slitTarget, Blocks.STONE.defaultBlockState());
		slit.put(new BlockPos(1, 1, 0), Blocks.STONE.defaultBlockState());
		slit.floor(-1, -2, 4, -1, 1);
		check(BreakSightline.visiblePoint(slit, context, new Vec3(-0.4D, 1.62D, 0.5D), slitTarget, reach) != null,
				"the narrow strip below the blocker is a valid outline hit");
		assertions++;
		Vec3 slitEye = new Vec3(-0.4D, 1.62D, 0.5D);
		check(validPlayerAim(slit, slitEye, BreakSightline.visiblePoint(slit, context, slitEye, slitTarget, reach), slitTarget, reach),
				"the reproduced sliver aim still hits after Minecraft's player-angle conversion");
		assertions++;
		Fixture edge = new Fixture(position -> true);
		edge.put(slitTarget, Blocks.STONE.defaultBlockState());
		check(BreakSightline.visiblePoint(edge, context, new Vec3(-1.4999D, 0.01D, 0.01D), slitTarget, reach) != null,
				"the nearest face point remains hittable at the reach boundary");
		assertions++;
		for (double width : new double[]{0.0001D, 0.001D, 0.01D, 0.1D}) {
			// The shadow's bottom edge falls at width on the target's west face.
			double eyeY = (3.4D - 1.4D * width) / 2.0D;
			Vec3 eye = new Vec3(-0.4D, eyeY, 0.5D);
			Vec3 aim = BreakSightline.visiblePoint(slit, context, eye, slitTarget, reach);
			check(validAim(slit, eye, aim, slitTarget, reach), "a ray-validated aim exists for exposed strip width " + width);
			assertions++;
		}
		for (Direction.Axis axis : Direction.Axis.values()) {
			Fixture rotated = new Fixture(position -> true);
			BlockPos rotatedTarget = rotate(slitTarget, axis);
			rotated.put(rotatedTarget, Blocks.STONE.defaultBlockState());
			rotated.put(rotate(new BlockPos(1, 1, 0), axis), Blocks.STONE.defaultBlockState());
			Vec3 eye = rotate(new Vec3(-0.4D, 1.62D, 0.5D), axis);
			check(validAim(rotated, eye, BreakSightline.visiblePoint(rotated, context, eye, rotatedTarget, reach), rotatedTarget, reach),
					"outline shadow clipping works along " + axis);
			assertions++;
		}
		Fixture distant = new Fixture(position -> true);
		BlockPos distantTarget = rotate(slitTarget, Direction.Axis.Y).offset(29_000_000, 0, 29_000_000);
		distant.put(distantTarget, Blocks.STONE.defaultBlockState());
		distant.put(rotate(new BlockPos(1, 1, 0), Direction.Axis.Y).offset(29_000_000, 0, 29_000_000), Blocks.STONE.defaultBlockState());
		Vec3 distantEye = rotate(new Vec3(-0.4D, (3.4D - 1.4D * 0.0001D) / 2.0D, 0.5D), Direction.Axis.Y).add(29_000_000, 0, 29_000_000);
		check(validAim(distant, distantEye, BreakSightline.visiblePoint(distant, context, distantEye, distantTarget, reach), distantTarget, reach),
				"exposed regions remain hittable near the world border without area cancellation");
		assertions++;

		Fixture unknownSlab = new Fixture(position -> !position.equals(slitTarget));
		unknownSlab.put(slitTarget, Blocks.STONE_SLAB.defaultBlockState());
		unknownSlab.put(new BlockPos(2, 0, 0), Blocks.STONE.defaultBlockState());
		unknownSlab.put(new BlockPos(0, -1, 0), Blocks.STONE.defaultBlockState());
		check(BreakSightline.standingSpot(unknownSlab, new Vec3(-1.5D, 0.0D, 0.5D), slitTarget, reach, 1.62D) == null,
				"an unknown slab cannot become an invented full-cube standing hint");
		assertions++;
		Fixture knownSlab = new Fixture(position -> true);
		knownSlab.put(slitTarget, Blocks.STONE_SLAB.defaultBlockState());
		knownSlab.put(new BlockPos(2, 0, 0), Blocks.STONE.defaultBlockState());
		knownSlab.put(new BlockPos(0, -1, 0), Blocks.STONE.defaultBlockState());
		check(BreakSightline.visiblePoint(knownSlab, context, new Vec3(0.5D, 1.62D, 0.5D), slitTarget, reach) == null,
				"the actual known bottom slab remains obscured from the invented cube's offered cell");
		assertions++;
		BlockPos slabSpot = BreakSightline.standingSpot(knownSlab, new Vec3(-1.5D, 0.0D, 0.5D), slitTarget, reach, 1.62D);
		check(slabSpot == null || validAim(knownSlab, Vec3.atBottomCenterOf(slabSpot).add(0, 1.62D, 0),
				BreakSightline.visiblePoint(knownSlab, context, Vec3.atBottomCenterOf(slabSpot).add(0, 1.62D, 0), slitTarget, reach), slitTarget, reach),
				"a known partial shape offers only a cell whose actual outline is hittable");
		assertions++;
		Vec3 treeAim = BreakSightline.visiblePoint(tree, context, treeEye, lowerLog, reach);
		check(treeAim != null && !treeAim.equals(Vec3.atCenterOf(lowerLog)), "the partly hidden lower log is visible off center");
		assertions++;
		check(treeAim.y < 88.0D && Math.abs(treeAim.x - 6.0D) < 1.0E-9D, "the aim lands on the lower log's own east face");
		assertions++;

		// A block with nothing in the way is aimed at its center, as before; one beyond reach is not visible.
		Fixture open = new Fixture(position -> true);
		open.floor(64, 0, 16, -3, 3);
		Vec3 openEye = new Vec3(6.5D, 65.62D, 0.5D);
		open.put(new BlockPos(9, 65, 0), Blocks.STONE.defaultBlockState());
		check(Vec3.atCenterOf(new BlockPos(9, 65, 0)).equals(BreakSightline.visiblePoint(open, context, openEye, new BlockPos(9, 65, 0), reach)),
				"a clear block is aimed at its center");
		assertions++;
		open.put(new BlockPos(12, 65, 0), Blocks.STONE.defaultBlockState());
		check(BreakSightline.visiblePoint(open, context, openEye, new BlockPos(12, 65, 0), reach) == null, "a block beyond reach is not visible");
		assertions++;

		// A block walled in on every side shows nothing; the wall block on the line to it is the one named.
		Fixture enclosed = new Fixture(position -> true);
		BlockPos buried = new BlockPos(9, 64, 0);
		enclosed.put(buried, Blocks.IRON_ORE.defaultBlockState());
		for (net.minecraft.core.Direction side : net.minecraft.core.Direction.values()) {
			enclosed.put(buried.relative(side), Blocks.STONE.defaultBlockState());
		}
		check(BreakSightline.visiblePoint(enclosed, context, openEye, buried, reach) == null, "a fully enclosed block is not visible");
		assertions++;
		BlockHitResult wall = BreakSightline.blocker(enclosed, context, openEye, buried);
		check(wall != null && !wall.getBlockPos().equals(buried), "the block first on the line to a hidden target is reported");
		assertions++;

		// A real memory remembers air, then stone appears unseen on the target line. Neither stale air nor the
		// changed live block may be reported until the current crosshair actually sees the obstruction.
		Fixture changed = new Fixture(position -> true);
		BlockPos rememberedCell = new BlockPos(8, 101, -15), hiddenTarget = new BlockPos(10, 100, -15);
		Vec3 changedEye = new Vec3(6.5D, 101.62D, -14.5D);
		boolean[] sees = {true};
		SeenTerrain.Memory<BlockState> memory = new SeenTerrain.Memory<>();
		SeenTerrain.Source<BlockState> source = new SeenTerrain.Source<>() {
			public BlockState live(int x, int y, int z) { return changed.getBlockState(new BlockPos(x, y, z)); }
			public boolean sees(int x, int y, int z) { return sees[0]; }
		};
		check(new SeenTerrain.Reader<>(memory, source, 1L, new LongOpenHashSet()).known(8, 101, -15).isAir(),
				"the future obstruction cell was legitimately remembered as air");
		assertions++;
		sees[0] = false;
		changed.put(hiddenTarget, Blocks.STONE.defaultBlockState());
		for (int y = 99; y <= 104; y++) changed.put(new BlockPos(8, y, -15), Blocks.STONE.defaultBlockState());
		check(new SeenTerrain.Reader<>(memory, source, 2L, new LongOpenHashSet()).known(8, 101, -15).isAir(),
				"the hidden wall change leaves the remembered air unchanged");
		assertions++;
		BlockHitResult away = changed.clip(new ClipContext(changedEye, changedEye.add(-reach, 0, 0),
				ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, context));
		check(BreakSightline.visibleBlocker(changed, context, changedEye, hiddenTarget, away) == null,
				"looking away reveals neither a hidden blocker name nor its true-world coordinate");
		assertions++;
		BlockHitResult toward = changed.clip(new ClipContext(changedEye, Vec3.atCenterOf(hiddenTarget),
				ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, context));
		BlockHitResult observed = BreakSightline.visibleBlocker(changed, context, changedEye, hiddenTarget, toward);
		check(observed != null && observed.getBlockPos().equals(rememberedCell)
				&& changed.getBlockState(observed.getBlockPos()).is(Blocks.STONE),
				"the current eye ray supplies the visible block's position and live stone identity, never stale air");
		assertions++;
		changed.put(rememberedCell, Blocks.COBBLESTONE.defaultBlockState());
		check(BreakSightline.visibleBlocker(changed, context, changedEye, hiddenTarget, away) == null,
				"an unseen replacement remains unnamed even when the cell was known");
		assertions++;
		observed = BreakSightline.visibleBlocker(changed, context, changedEye, hiddenTarget, toward);
		check(observed != null && changed.getBlockState(observed.getBlockPos()).is(Blocks.COBBLESTONE),
				"seeing the replacement now reports cobblestone from the current ray");
		assertions++;
		BlockHitResult unrelated = new BlockHitResult(changedEye, Direction.EAST, new BlockPos(5, 101, -15), false);
		check(BreakSightline.visibleBlocker(changed, context, changedEye, hiddenTarget, unrelated) == null,
				"a different currently visible block is not named as the target's obstruction");
		assertions++;

		Vec3 roundingEye = new Vec3(-1.499120116856488D, 0.5983268943996976D, 0.4938081987292421D);
		Vec3 missed = BreakSightline.visiblePoint(edge, context, roundingEye, slitTarget, reach);
		check(validAim(edge, roundingEye, missed, slitTarget, reach) && !validPlayerAim(edge, roundingEye, missed, slitTarget, reach),
				"the original exact ray hits but the reproduced player-angle ray misses at reach");
		assertions++;
		Vec3 alternate = BreakSightline.visiblePoint(edge, context, roundingEye, slitTarget, reach, missed);
		check(alternate != null && !alternate.equals(missed)
				&& validPlayerAim(edge, roundingEye, alternate, slitTarget, reach),
				"a reach-edge retry chooses a distinct aim that survives player-angle rounding");
		assertions++;

		// A 3x3 wall hides the target from here; seen terrain shows a standing cell beside the wall that sees it.
		Fixture walled = new Fixture(position -> true);
		walled.floor(64, 3, 14, -4, 4);
		BlockPos target = new BlockPos(10, 65, 0);
		walled.put(target, Blocks.STONE.defaultBlockState());
		for (int y = 65; y <= 67; y++) {
			for (int z = -1; z <= 1; z++) walled.put(new BlockPos(9, y, z), Blocks.COBBLESTONE.defaultBlockState());
		}
		Vec3 feet = new Vec3(7.5D, 65.0D, 0.5D);
		Vec3 walledEye = feet.add(0.0D, 1.62D, 0.0D);
		check(BreakSightline.visiblePoint(walled, context, walledEye, target, reach) == null, "the wall hides every part of the target");
		assertions++;
		BlockPos spot = BreakSightline.standingSpot(walled, feet, target, reach, 1.62D);
		check(spot != null && !spot.equals(BlockPos.containing(feet)) && spot.getY() == 65, "a standing cell on the seen floor is offered");
		assertions++;
		check(BreakSightline.visiblePoint(walled, context, Vec3.atBottomCenterOf(spot).add(0.0D, 1.62D, 0.0D), target, reach) != null,
				"the offered cell's eye sees the target");
		assertions++;
		check(walled.getBlockState(spot).isAir() && walled.getBlockState(spot.above()).isAir()
				&& walled.getBlockState(spot.below()).is(Blocks.STONE), "the offered cell has open feet and head room over a floor");
		assertions++;

		// The target was seen earlier, but intervening cells are unknown: no ray may see through those cells.
		Fixture unseen = new Fixture(position -> position.getX() < 9 || position.equals(target));
		unseen.floor(64, 3, 14, -4, 4);
		unseen.put(target, Blocks.STONE.defaultBlockState());
		for (int y = 65; y <= 67; y++) {
			for (int z = -1; z <= 1; z++) unseen.put(new BlockPos(9, y, z), Blocks.COBBLESTONE.defaultBlockState());
		}
		check(BreakSightline.standingSpot(unseen, feet, target, reach, 1.62D) == null, "terrain the player has not seen offers no standing cell");
		assertions++;

		// Bucket targets: a fluid cell has no outline, so its aim is the visible fluid surface that the any-fluid ray meets.
		for (BlockState fluid : new BlockState[]{Blocks.WATER.defaultBlockState(), Blocks.LAVA.defaultBlockState()}) {
			Fixture pool = new Fixture(position -> true);
			pool.floor(63, -3, 6, -3, 3);
			BlockPos fluidCell = new BlockPos(2, 64, 0);
			pool.put(fluidCell, fluid);
			Vec3 poolEye = new Vec3(0.5D, 65.62D, 0.5D);
			Vec3 surface = fluidAim(pool, context, poolEye, fluidCell, reach, Direction.UP);
			check(surface != null && surface.y > 64.0D && surface.y < 65.0D, "a fluidCell's top surface is aimable below a full block: " + fluid);
			assertions++;
			BlockHitResult outline = pool.clip(new ClipContext(poolEye, poolEye.add(surface.subtract(poolEye).scale(1.5D)),
					ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, CollisionContext.empty()));
			check(outline.getType() != HitResult.Type.BLOCK || !outline.getBlockPos().equals(fluidCell),
					"the outline crosshair passes through the fluid, so only the item's own ray can take it: " + fluid);
			assertions++;
			check(fluidAim(pool, context, poolEye, fluidCell, reach, Direction.DOWN) == null,
					"a fluid face turned away from the eye is not aimable: " + fluid);
			assertions++;
			check(validFluidAim(pool, poolEye, surface, fluidCell, reach), "the chosen surface point is the first thing the any-fluid ray meets: " + fluid);
			assertions++;
			pool.put(new BlockPos(1, 65, 0), Blocks.STONE.defaultBlockState());
			pool.put(new BlockPos(1, 64, 0), Blocks.STONE.defaultBlockState());
			check(fluidAim(pool, context, poolEye, fluidCell, reach, Direction.UP) == null,
					"a wall between the eye and the pool hides its surface: " + fluid);
			assertions++;
			// Review r1: the central underwater case remains aimable on all six faces with the full player ray.
			Fixture submerged = new Fixture(position -> true);
			BlockPos around = new BlockPos(0, 64, 0);
			submerged.put(around, fluid);
			Vec3 insideEye = new Vec3(0.5D, 64.5D, 0.5D);
			for (Direction face : Direction.values()) {
				Vec3 aim = fluidAim(submerged, context, insideEye, around, reach, face);
				check(aim != null, "an eye inside the source can aim at its " + face + " face: " + fluid);
				assertions++;
				BlockHitResult inside = playerFluidHit(submerged, insideEye, aim, reach);
				check(inside.getType() == HitResult.Type.BLOCK && inside.getBlockPos().equals(around) && inside.getDirection() == face
						&& inside.isInside(), "vanilla's clip along that aim is an inside hit on the " + face + " face: " + fluid);
				assertions++;
			}
			// Review r2: the short segment sees A, but vanilla's full ray starts its inside sample beyond A.
			BlockPos farther = new BlockPos(2, 64, 0);
			submerged.put(farther, fluid);
			Vec3 boundaryEye = new Vec3(.999D, 64.5D, .5D);
			Vec3 oldAim = boundaryEye.add(.25D, 0, 0);
			BlockHitResult shortHit = submerged.clip(new ClipContext(boundaryEye, oldAim.add(.001D, 0, 0),
					ClipContext.Block.OUTLINE, ClipContext.Fluid.SOURCE_ONLY, context));
			check(shortHit.getBlockPos().equals(around) && shortHit.isInside(), "short boundary ray misleadingly hits A: " + fluid);
			assertions++;
			BlockHitResult fullHit = playerFluidHit(submerged, boundaryEye, oldAim, reach);
			check(fullHit.getBlockPos().equals(farther) && fullHit.getDirection() == Direction.WEST && !fullHit.isInside(),
					"vanilla full boundary ray hits B: " + fluid);
			assertions++;
			check(fluidAim(submerged, context, boundaryEye, around, reach, Direction.WEST) == null,
					"reject a requested A aim that would scoop B: " + fluid);
			assertions++;
			Vec3 safeAim = fluidAim(submerged, context, boundaryEye, around, reach, Direction.EAST);
			check(safeAim != null && playerFluidHit(submerged, boundaryEye, safeAim, reach).getBlockPos().equals(around),
					"another face can still scoop A at the boundary: " + fluid);
			assertions++;
			// Flowing fluid in front does not hide a source: an empty bucket's ray passes it to take the source.
			Fixture spill = new Fixture(position -> true);
			spill.floor(63, -3, 6, -3, 3);
			spill.put(fluidCell, fluid);
			spill.put(new BlockPos(1, 64, 0), fluid.setValue(net.minecraft.world.level.block.LiquidBlock.LEVEL, 2));
			Vec3 lowEye = new Vec3(-0.5D, 64.7D, 0.5D);
			check(fluidAim(spill, context, lowEye, fluidCell, reach, Direction.WEST) != null,
					"a source stays aimable through the flowing fluid in front of it: " + fluid);
			assertions++;
			check(fluidAim(spill, context, lowEye, new BlockPos(1, 64, 0), reach, Direction.WEST) != null,
					"the flowing cell itself is aimable as the first fluid surface: " + fluid);
			assertions++;
			check(fluidAim(pool, context, poolEye, new BlockPos(9, 64, 0), reach, Direction.UP) == null,
					"an air cell has no fluid surface to aim at");
			assertions++;
		}
		assertions += verifyFluidEdges();
		return assertions;
	}

	private static int verifyFluidEdges() {
		int assertions = 0;
		BlockPos target = new BlockPos(0, 64, 0);
		BlockState water = Blocks.WATER.defaultBlockState(), lava = Blocks.LAVA.defaultBlockState();
		BlockState wet = Blocks.OAK_SLAB.defaultBlockState().setValue(net.minecraft.world.level.block.state.properties.BlockStateProperties.WATERLOGGED, true);
		for (BlockState source : new BlockState[]{water, lava}) {
			Fixture edge = new Fixture(pos -> true);
			edge.put(target, source);
			edge.put(target.east(), source);
			Vec3 eye = new Vec3(.9999999D, 64.5D, .001D);
			for (Direction face : new Direction[]{Direction.DOWN, Direction.UP}) {
				Vec3 attempted = eye.add(0, -face.getStepY() * .25D, 0);
				BlockHitResult expected = playerFluidHit(edge, eye, attempted, 4.5D);
				Vec3 aim = fluidAim(edge, CollisionContext.empty(), eye, target, 4.5D, face);
				check((aim != null) == (expected.getBlockPos().equals(target) && expected.getDirection() == face),
						"review r3 vertical boundary agrees with actual Item ray: " + source + " " + face);
				assertions++;
				if (face == Direction.DOWN) {
					check(aim != null, "review r3 DOWN is a valid aim, not a false neighbor rejection: " + source);
					assertions++;
				}
			}
			// Reviewer's full corner grid: sources, flowing neighbors, mixed fluid, waterlogged and solid neighbors.
			for (BlockState neighbor : new BlockState[]{water, lava,
					water.setValue(net.minecraft.world.level.block.LiquidBlock.LEVEL, 2),
					lava.setValue(net.minecraft.world.level.block.LiquidBlock.LEVEL, 2), wet, Blocks.STONE.defaultBlockState()}) {
				for (double gap : new double[]{1E-12, 1E-10, 1E-9, 1E-7, 2E-7, 5E-7, .00001, .0005, .001, .004, .005, .01, .1}) {
					for (double x : new double[]{gap, 1-gap}) for (double z : new double[]{gap, 1-gap}) {
						Fixture world = new Fixture(pos -> true);
						world.put(target, source);
						for (int dx = -2; dx <= 2; dx++) for (int dz = -2; dz <= 2; dz++) {
							if (dx != 0 || dz != 0) world.put(target.offset(dx, 0, dz), neighbor);
						}
						Vec3 corner = new Vec3(x, 64.5D, z);
						for (Direction face : Direction.values()) {
							Vec3 attempted = corner.add(-face.getStepX() * .25D, -face.getStepY() * .25D, -face.getStepZ() * .25D);
							BlockHitResult expected = playerFluidHit(world, corner, attempted, 4.5D);
							boolean valid = expected.getType() == HitResult.Type.BLOCK && expected.getBlockPos().equals(target) && expected.getDirection() == face;
							var player = VanillaFluidRayFixture.player(world, corner, 4.5D);
							try {
								TargetSightline.fluid(player, target, face);
								check(valid, "accepted corner must agree with actual vanilla Item ray");
							} catch (dev.agaminggod.arenaagents.agent.AgentDomainException e) {
								check(!valid && e.code().equals("TARGET_OBSTRUCTED")
										&& e.getMessage().contains("at " + expected.getBlockPos() + " face " + expected.getDirection()),
										"rejected corner must report actual Item hit: " + e.getMessage());
							}
							assertions++;
						}
					}
				}
			}
		}
		Fixture slab = new Fixture(pos -> true);
		slab.put(target, wet);
		Vec3 eye = new Vec3(.5D, 64.7D, .5D), aim = eye.add(0, 0, 1);
		var player = VanillaFluidRayFixture.player(slab, eye, 4.5D);
		player.setXRot(12); player.setYRot(23); player.setYHeadRot(34);
		player.xRotO = 45; player.yRotO = 56; player.yHeadRotO = 67;
		BlockHitResult expected = playerFluidHit(slab, eye, aim, 4.5D);
		BlockHitResult actual = VanillaItemRay.atAim(player, aim, ClipContext.Fluid.SOURCE_ONLY);
		check(expected.getBlockPos().equals(target) && actual.getLocation().equals(expected.getLocation())
				&& actual.getDirection() == expected.getDirection() && !wet.getShape(slab, target).isEmpty(),
				"waterlogged slab uses vanilla source ray and retains its block outline");
		assertions++;
		check(player.getXRot() == 12 && player.getYRot() == 23 && player.getYHeadRot() == 34
				&& player.xRotO == 45 && player.yRotO == 56 && player.yHeadRotO == 67,
				"candidate ray restores current and previous body/head rotation");
		assertions++;
		return assertions;
	}

	/** Known cells hold what was put there, else air; cells outside {@code known} are unknown to the player. */
	private static final class Fixture extends BreakSightline.SeenWorld {
		private final Map<BlockPos, BlockState> states = new HashMap<>();
		private final Predicate<BlockPos> known;

		Fixture(Predicate<BlockPos> known) {
			super(-64, 384);
			this.known = known;
		}

		void put(BlockPos position, BlockState state) {
			states.put(position.immutable(), state);
		}

		void floor(int y, int minX, int maxX, int minZ, int maxZ) {
			for (int x = minX; x <= maxX; x++) {
				for (int z = minZ; z <= maxZ; z++) put(new BlockPos(x, y, z), Blocks.STONE.defaultBlockState());
			}
		}

		@Override
		BlockState knownState(BlockPos position) {
			if (!known.test(position)) return null;
			return states.getOrDefault(position, Blocks.AIR.defaultBlockState());
		}
	}

	private static boolean validAim(Fixture level, Vec3 eye, Vec3 aim, BlockPos target, double reach) {
		if (aim == null) return false;
		return rayHits(level, eye, aim.subtract(eye).normalize(), target, reach);
	}

	private static boolean validFluidAim(Fixture level, Vec3 eye, Vec3 aim, BlockPos target, double reach) {
		BlockHitResult hit = playerFluidHit(level, eye, aim, reach);
		return hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(target) && eye.distanceTo(hit.getLocation()) <= reach;
	}

	private static Vec3 fluidAim(Fixture level, CollisionContext context, Vec3 eye, BlockPos target, double reach, Direction face) {
		try { return TargetSightline.fluid(VanillaFluidRayFixture.player(level, eye, reach), target, face); }
		catch (dev.agaminggod.arenaagents.agent.AgentDomainException e) {
			if (!e.code().equals("TARGET_OBSTRUCTED")) throw e;
			return null;
		}
	}

	private static BlockHitResult playerFluidHit(Fixture level, Vec3 eye, Vec3 aim, double reach) {
		return VanillaFluidRayFixture.hit(level, eye, aim, reach, ClipContext.Fluid.SOURCE_ONLY);
	}

	private static boolean validPlayerAim(Fixture level, Vec3 eye, Vec3 aim, BlockPos target, double reach) {
		if (aim == null) return false;
		Vec3 delta = aim.subtract(eye);
		float yaw = (float) Math.toDegrees(Math.atan2(-delta.x, delta.z));
		float pitch = (float) -Math.toDegrees(Math.atan2(delta.y, Math.sqrt(delta.x * delta.x + delta.z * delta.z)));
		return rayHits(level, eye, Vec3.directionFromRotation(pitch, yaw), target, reach);
	}

	private static boolean rayHits(Fixture level, Vec3 eye, Vec3 direction, BlockPos target, double reach) {
		BlockHitResult hit = level.clip(new ClipContext(eye, eye.add(direction.scale(reach)),
				ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, CollisionContext.empty()));
		return hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(target) && eye.distanceTo(hit.getLocation()) <= reach;
	}

	private static BlockPos rotate(BlockPos point, Direction.Axis axis) {
		return BlockPos.containing(rotate(Vec3.atLowerCornerOf(point), axis));
	}

	private static Vec3 rotate(Vec3 point, Direction.Axis axis) {
		return switch (axis) {
			case X -> point;
			case Y -> new Vec3(point.y, point.x, point.z);
			case Z -> new Vec3(point.z, point.y, point.x);
		};
	}

	private static void check(boolean condition, String label) {
		if (!condition) throw new AssertionError(label);
	}
}
