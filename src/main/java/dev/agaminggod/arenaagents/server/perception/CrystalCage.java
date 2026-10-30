package dev.agaminggod.arenaagents.server.perception;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.boss.enderdragon.EndCrystal;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.phys.Vec3;

/**
 * The iron-bar cage EndSpikeFeature builds round the crystal of a guarded spike: bars on the 5x5 ring two blocks out
 * from the bedrock row (crystal y - 1) up to crystal y + 2, and over the whole 5x5 top at y + 2. The side walls are
 * solid panes to arrows; the top is a grid of bars with holes about 0.9 blocks square. End runs 2026-10-21 lost 297
 * arrows in these walls and 20-30 minutes a game on the two caged crystals.
 */
public final class CrystalCage {
	/** IronBarsBlock: strength 5 and a pickaxe for drops, so a bare hand breaks at a hundredth of the speed (25 s). */
	private static final String BREAK_TIME = "an iron pickaxe breaks each in about 1.3 s, a bare hand in about 25 s";
	private static final int MAX_OPENINGS = 6;
	private final BlockPos crystal;
	private final List<BlockPos> openings;

	private CrystalCage(BlockPos crystal, List<BlockPos> openings) {
		this.crystal = crystal;
		this.openings = List.copyOf(openings);
	}

	/** The cage round a crystal in the world, or null when the crystal stands open. */
	public static CrystalCage of(Level level, EndCrystal crystal) {
		return find(cell -> level.getBlockState(cell).is(Blocks.IRON_BARS), crystal.blockPosition());
	}

	/** A cage while more than half its cells hold bars; the missing cells beside or above the crystal are its openings. */
	static CrystalCage find(Predicate<BlockPos> ironBars, BlockPos crystal) {
		List<BlockPos> cells = cells(crystal);
		int bars = 0;
		List<BlockPos> open = new ArrayList<>();
		for (BlockPos cell : cells) {
			if (ironBars.test(cell)) bars++;
			// The bedrock-level ring sits below the crystal's body: a gap there opens no line to it.
			else if (cell.getY() >= crystal.getY()) open.add(cell);
		}
		return bars * 2 > cells.size() ? new CrystalCage(crystal, open) : null;
	}

	/** Every cell the spike feature fills with bars. */
	static List<BlockPos> cells(BlockPos crystal) {
		List<BlockPos> cells = new ArrayList<>();
		for (int dx = -2; dx <= 2; dx++) for (int dz = -2; dz <= 2; dz++) for (int dy = -1; dy <= 2; dy++) {
			if (Math.abs(dx) == 2 || Math.abs(dz) == 2 || dy == 2) cells.add(crystal.offset(dx, dy, dz));
		}
		return cells;
	}

	public List<BlockPos> openings() {
		return openings;
	}

	/** The wall facing a point: the unit step (x or z) from the crystal toward it. */
	BlockPos facing(Vec3 from) {
		double dx = from.x - (crystal.getX() + 0.5D), dz = from.z - (crystal.getZ() + 0.5D);
		return Math.abs(dx) >= Math.abs(dz) ? new BlockPos(dx >= 0 ? 1 : -1, 0, 0) : new BlockPos(0, 0, dz >= 0 ? 1 : -1);
	}

	/**
	 * What makes the crystal hittable, in vanilla terms, from where the player stands: the cage's extent, the two wall bars
	 * at its height on the player's side and the cell beside them a player stands in to break them (with how far above
	 * the player's feet that is), the open top grid, and the blast at that spot.
	 */
	public String advice(ServerPlayer player, double blastAtWall) {
		BlockPos step = facing(player.position());
		BlockPos low = crystal.offset(step.getX() * 2, 0, step.getZ() * 2), high = low.above();
		BlockPos stand = crystal.offset(step.getX() * 3, 0, step.getZ() * 3);
		int above = stand.getY() - (int) Math.floor(player.getY() + 1.0E-6D);
		StringBuilder text = new StringBuilder(String.format(Locale.ROOT,
				"It is caged: iron bars 2 blocks out on every side from y=%d to y=%d (x %d..%d, z %d..%d) and a barred top at y=%d. Arrows stick in the side walls from anywhere; the top is a grid of bars with holes about 0.9 blocks wide that arrows pass from above.",
				crystal.getY() - 1, crystal.getY() + 2, crystal.getX() - 2, crystal.getX() + 2, crystal.getZ() - 2, crystal.getZ() + 2, crystal.getY() + 2));
		if (!openings.isEmpty()) {
			text.append(" Open cells now: ");
			for (int i = 0; i < Math.min(MAX_OPENINGS, openings.size()); i++) {
				BlockPos cell = openings.get(i);
				text.append(i == 0 ? "" : "; ").append(cell.getX()).append(',').append(cell.getY()).append(',').append(cell.getZ());
			}
			if (openings.size() > MAX_OPENINGS) text.append("; +").append(openings.size() - MAX_OPENINGS).append(" more");
			text.append('.');
		}
		text.append(String.format(Locale.ROOT,
				" On your side the wall bars at its height are %d,%d,%d and %d,%d,%d (%s); standing at %d,%d,%d (feet y=%d, %s) puts both in reach. Once they are broken, arrows reach it through that gap from the ground on that side; the bars beside them widen the gap against arrow scatter, and a pillar left standing in front of it catches low arrows.",
				low.getX(), low.getY(), low.getZ(), high.getX(), high.getY(), high.getZ(), BREAK_TIME,
				stand.getX(), stand.getY(), stand.getZ(), stand.getY(),
				above > 0 ? above + " blocks above your feet" : above == 0 ? "your feet's height" : -above + " blocks below your feet"));
		if (blastAtWall > 0.0D) text.append(String.format(Locale.ROOT,
				" Broken from that spot, its blast would deal you about %.0f after your armour and blow up ordinary blocks round it.", blastAtWall));
		return text.toString();
	}

	/** Where a player stands to break the facing wall bars: feet at the crystal's height, one block outside the wall. */
	public Vec3 standSpot(Vec3 from) {
		BlockPos step = facing(from);
		return Vec3.atBottomCenterOf(crystal.offset(step.getX() * 3, 0, step.getZ() * 3));
	}
}
