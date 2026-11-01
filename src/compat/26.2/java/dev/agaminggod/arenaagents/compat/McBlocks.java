package dev.agaminggod.arenaagents.compat;

import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;

/** Vanilla blocks whose name differs between 26.x drops (26.2 grouped coloured and weathering blocks into families). */
public final class McBlocks {
	public static final Block CUT_COPPER = Blocks.CUT_COPPER.weathering().unaffected();
	public static final Block COPPER_BLOCK = Blocks.COPPER_BLOCK.weathering().unaffected();
	public static final Block YELLOW_GLAZED_TERRACOTTA = Blocks.GLAZED_TERRACOTTA.yellow();
	public static final Block CYAN_STAINED_GLASS = Blocks.STAINED_GLASS.cyan();
	public static final Block WHITE_CONCRETE = Blocks.CONCRETE.white();
	public static final Block LIGHT_GRAY_CONCRETE = Blocks.CONCRETE.lightGray();
	public static final Block RED_CONCRETE = Blocks.CONCRETE.red();
	public static final Block BLUE_CONCRETE = Blocks.CONCRETE.blue();
	public static final Block CYAN_CONCRETE = Blocks.CONCRETE.cyan();
	public static final Block MAGENTA_CONCRETE = Blocks.CONCRETE.magenta();

	public static final Block WHITE_WOOL = Blocks.WOOL.white();
	public static final Block WHITE_CARPET = Blocks.CARPET.white();
	public static final Block RED_BED = Blocks.BED.red();
	public static final Block ORANGE_TERRACOTTA = Blocks.DYED_TERRACOTTA.orange();
	public static final Block WAXED_CUT_COPPER = Blocks.CUT_COPPER.waxed().unaffected();

	private McBlocks() {
	}
}
