package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.agaminggod.arenaagents.server.perception.SightedFeatures.Cell;
import dev.agaminggod.arenaagents.server.perception.SightedFeatures.Sample;
import dev.agaminggod.arenaagents.server.perception.SightedFeatures.Sighting;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.ToDoubleFunction;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

/** Structure, cave and ore-vein sightings: only seen blocks count, and dug tunnels or houses are not caves. */
public final class SightedFeaturesVerification {
	private static final java.util.concurrent.atomic.AtomicInteger UNSAFE_ENTITY_IDS = new java.util.concurrent.atomic.AtomicInteger(200_000);
	private static int checks;
	private static final ToDoubleFunction<Cell> FROM_ORIGIN = cell -> Math.sqrt((double) cell.x() * cell.x() + (double) cell.y() * cell.y() + (double) cell.z() * cell.z());

	private SightedFeaturesVerification() { }

	public static int verify() {
		checks = 0;
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		oreFamilies();
		veinsCountOnlySeenOre();
		cavesNeedRoomRoofAndNaturalWalls();
		canopyIsNotACaveRoof();
		structureLabels();
		onlyBuiltBlocksIdentifyStructures();
		sightedRecomputeIsThrottled();
		announcements();
		rendering();
		attention();
		naturalTerrain();
		farSightKinds();
		farSightClusters();
		farSightGeometry();
		surveyRequests();
		seenPartsOnly();
		stableClusterKeys();
		surveysAcknowledge();
		fogRange();
		structureSizeFromSeenBlocks();
		structureNamingBoundary();
		perTickBudgets();
		denseSectionsAreReadThrough();
		neighbourEditsExposeBlocks();
		neighbourEditsKeepScanProgress();
		cachedSurveyReusesSightLines();
		return checks;
	}

	private static void oreFamilies() {
		check("minecraft:iron_ore".equals(SightedFeatures.oreFamily("minecraft:deepslate_iron_ore")), "deepslate iron joins the iron family");
		check("minecraft:nether_gold_ore".equals(SightedFeatures.oreFamily("minecraft:nether_gold_ore")), "nether gold keeps its id");
		check("minecraft:ancient_debris".equals(SightedFeatures.oreFamily("minecraft:ancient_debris")), "ancient debris is an ore");
		check(SightedFeatures.oreFamily("minecraft:stone") == null && SightedFeatures.oreFamily("minecraft:deepslate") == null, "stone is not ore");
	}

	private static void veinsCountOnlySeenOre() {
		Map<Cell, String> world = new HashMap<>();
		// One iron vein of six blocks (one diagonal, one deepslate) and a separate coal vein.
		List<Cell> iron = List.of(new Cell(3, 0, 0), new Cell(4, 0, 0), new Cell(5, 1, 0), new Cell(4, 0, 1), new Cell(5, 0, 1), new Cell(6, 0, 1));
		iron.forEach(cell -> world.put(cell, "minecraft:iron_ore"));
		world.put(new Cell(6, 0, 1), "minecraft:deepslate_iron_ore");
		world.put(new Cell(0, 0, 8), "minecraft:coal_ore");
		world.put(new Cell(0, 1, 8), "minecraft:coal_ore");
		Set<Cell> visible = new HashSet<>(List.of(new Cell(3, 0, 0), new Cell(4, 0, 0), new Cell(5, 1, 0), new Cell(0, 0, 8)));
		List<Sighting> veins = SightedFeatures.veins(List.of(new Cell(4, 0, 0), new Cell(0, 0, 8)),
				cell -> world.getOrDefault(cell, "minecraft:stone"), visible::contains, FROM_ORIGIN);
		check(veins.size() == 2, "two veins from two seeds");
		Sighting ironVein = veins.getFirst();
		check(ironVein.count() == 3, "only the three seen iron blocks count, not the three hidden ones: " + ironVein.count());
		check(ironVein.cell().equals(new Cell(3, 0, 0)) && "minecraft:iron_ore".equals(ironVein.label()), "the vein is reported at its nearest seen block");
		check(veins.get(1).count() == 1, "the hidden coal neighbour is not counted");

		List<Cell> seeds = new ArrayList<>();
		for (int index = 0; index < 8; index++) {
			Cell cell = new Cell(index * 4, 0, 0);
			world.put(cell, "minecraft:copper_ore");
			seeds.add(cell);
		}
		check(SightedFeatures.veins(seeds, cell -> world.getOrDefault(cell, "minecraft:stone"), cell -> true, FROM_ORIGIN).size()
				== SightedFeatures.MAX_VEINS, "vein rows are capped");
	}

	/** An irregular natural cave: a rough blob around (cx, cy, cz), as carvers leave it. */
	private static boolean blob(Cell cell, int cx, int cy, int cz) {
		int dx = cell.x() - cx, dy = cell.y() - cy, dz = cell.z() - cz;
		return dx * dx + dy * dy * 2 + dz * dz <= 7 + Math.floorMod(cell.x() * 7 + cell.z() * 13 + cell.y() * 5, 4);
	}

	private static void canopyIsNotACaveRoof() {
		BlockState air = Blocks.AIR.defaultBlockState(), stone = Blocks.STONE.defaultBlockState();
		// Live run: a dark forest floor under huge mushroom caps and dark oak was reported as a cave twice; the model
		// walked to each and found trees. The first blocking block above the air decides.
		for (Block canopy : List.of(Blocks.RED_MUSHROOM_BLOCK, Blocks.BROWN_MUSHROOM_BLOCK, Blocks.MUSHROOM_STEM, Blocks.DARK_OAK_LOG,
				Blocks.DARK_OAK_LEAVES, Blocks.JUNGLE_LEAVES, Blocks.NETHER_WART_BLOCK, Blocks.BAMBOO)) {
			BlockState state = canopy.defaultBlockState();
			check(!SightedFeatures.terrainRoof(64, 80, y -> y == 70 ? state : y > 70 ? stone : air), canopy + " over open ground is not a cave roof");
		}
		check(SightedFeatures.terrainRoof(64, 80, y -> y >= 68 ? stone : air), "a stone roof is a cave roof");
		check(SightedFeatures.terrainRoof(64, 80, y -> y == 66 ? Blocks.CAVE_VINES.defaultBlockState() : y == 67 ? Blocks.GLOW_LICHEN.defaultBlockState()
				: y == 68 ? Blocks.WATER.defaultBlockState() : y >= 69 ? Blocks.DIRT.defaultBlockState() : air), "hanging plants and water are looked past to the terrain roof");
		check(!SightedFeatures.terrainRoof(64, 80, y -> y == 66 ? Blocks.VINE.defaultBlockState() : y == 67 ? Blocks.OAK_LEAVES.defaultBlockState() : air),
				"vines under leaves are still a canopy");
		check(SightedFeatures.terrainRoof(64, 80, y -> air), "open air up to the roof height or scan limit counts as a tall cavern");
		check(!SightedFeatures.terrainRoof(64, 80, y -> null), "an unloaded column is not judged a roof");
	}

	private static void cavesNeedRoomRoofAndNaturalWalls() {
		Map<Cell, String> world = new HashMap<>();
		// A dug 1x2 tunnel along +x: the open cell in front of its end wall is not a cave.
		for (int x = 0; x < 12; x++) {
			world.put(new Cell(x, 0, 0), "air");
			world.put(new Cell(x, 1, 0), "air");
		}
		List<Sighting> tunnel = SightedFeatures.caves(List.of(new Cell(11, 0, 0)), cell -> true, cell -> true,
				cell -> "air".equals(world.get(cell)), cell -> !"minecraft:oak_planks".equals(world.get(cell)), FROM_ORIGIN);
		check(tunnel.isEmpty(), "a dug tunnel is not a cave");

		// Review finding: a dug 3x3 tunnel held 45 roofed air cells in the box and passed as a cave.
		Set<Cell> wide = new HashSet<>();
		for (int x = 20; x <= 60; x++) for (int y = 0; y <= 2; y++) for (int z = -1; z <= 1; z++) wide.add(new Cell(x, y, z));
		check(SightedFeatures.caves(List.of(new Cell(40, 1, 0)), cell -> true, cell -> true, wide::contains, cell -> true, FROM_ORIGIN).isEmpty(),
				"a dug 3x3 tunnel (straight faces) is not a cave");
		Set<Cell> dugRoom = new HashSet<>();
		for (int x = 38; x <= 42; x++) for (int y = 0; y <= 3; y++) for (int z = -2; z <= 2; z++) dugRoom.add(new Cell(x, y, z));
		check(SightedFeatures.caves(List.of(new Cell(40, 1, 0)), cell -> true, cell -> true, dugRoom::contains, cell -> true, FROM_ORIGIN).isEmpty(),
				"a dug rectangular room is not a cave");
		// Review finding: air behind a wall counted. A sealed pocket beside a small dug nook adds nothing.
		Set<Cell> nook = new HashSet<>(List.of(new Cell(40, 0, 0), new Cell(40, 1, 0)));
		Set<Cell> withPocket = new HashSet<>(nook);
		// Sealed pockets on both sides, behind one-block walls: 50 air cells the old count included.
		for (int x : new int[] {38, 42}) for (int y = -1; y <= 3; y++) for (int z = -2; z <= 2; z++) withPocket.add(new Cell(x, y, z));
		check(SightedFeatures.caves(List.of(new Cell(40, 1, 0)), cell -> true, cell -> true, withPocket::contains, cell -> true, FROM_ORIGIN).isEmpty(),
				"air sealed behind a wall is not counted toward a cave");

		// A natural cave 40 blocks away is a cave when roofed, and not when open to the sky.
		Cell inside = new Cell(40, 1, 0);
		java.util.function.Predicate<Cell> cave = cell -> blob(cell, 40, 1, 0);
		List<Sighting> rows = SightedFeatures.caves(List.of(inside, new Cell(41, 1, 1)), cell -> true, cell -> true, cave, cell -> true, FROM_ORIGIN);
		check(rows.size() == 1, "two openings of one cave make one row");
		check(rows.getFirst().count() >= SightedFeatures.CAVE_MIN_AIR, "the row carries its open-air count: " + rows.getFirst().count());
		check(SightedFeatures.caves(List.of(inside), cell -> false, cell -> true, cave, cell -> true, FROM_ORIGIN).isEmpty(),
				"an unroofed hollow (valley, ravine floor) is not reported as a cave");
		check(SightedFeatures.caves(List.of(inside), cell -> cell.x() == 40, cell -> true, cave, cell -> true, FROM_ORIGIN).isEmpty(),
				"a ledge over open air (a hillside overhang) is not a cave");
		check(SightedFeatures.caves(List.of(inside), cell -> true, cell -> true, cave, cell -> false, FROM_ORIGIN).isEmpty(),
				"a roofed room with built walls is a building, not a cave");
		check(SightedFeatures.caves(List.of(inside, new Cell(39, 1, 1), new Cell(41, 2, -1)), cell -> true, cell -> true, cave, cell -> true, FROM_ORIGIN).size() == 1,
				"openings across one cave stay one row");
		check(SightedFeatures.caves(List.of(inside), cell -> true, cell -> false, cave, cell -> true, FROM_ORIGIN).isEmpty(),
				"a sky-lit opening is not a cave");
		check(!SightedFeatures.caveSpace(true, SightedFeatures.CAVE_MIN_AIR - 1, 100, 100), "too little air is not a cave");

		List<Cell> many = new ArrayList<>();
		for (int x = 2; x < 64; x += 12) many.add(new Cell(x, 1, 1));
		// A long winding natural passage of rough cross-section.
		java.util.function.Predicate<Cell> passage = cell -> cell.x() >= 0 && cell.x() < 64 && blob(cell, cell.x(), 1, 1);
		check(SightedFeatures.caves(many, cell -> true, cell -> true, passage, cell -> true, FROM_ORIGIN).size()
				== SightedFeatures.MAX_CAVES, "cave rows are capped");
	}

	/** Review decision: structures read as a player names them, and buried treasure (never visible) is never reported. */
	private static void structureLabels() {
		String[][] expected = {
				{"minecraft:village_plains", "village"}, {"minecraft:village_snowy", "village"}, {"minecraft:shipwreck_beached", "shipwreck"},
				{"minecraft:desert_pyramid", "desert temple"}, {"minecraft:jungle_pyramid", "jungle temple"}, {"minecraft:swamp_hut", "witch hut"},
				{"minecraft:igloo", "igloo"}, {"minecraft:ruined_portal_nether", "ruined portal"}, {"minecraft:mineshaft_mesa", "mineshaft"},
				{"minecraft:stronghold", "stronghold"}, {"minecraft:monument", "ocean monument"}, {"minecraft:mansion", "woodland mansion"},
				{"minecraft:pillager_outpost", "pillager outpost"}, {"minecraft:trail_ruins", "trail ruins"},
				{"minecraft:trial_chambers", "trial chambers"}, {"minecraft:ancient_city", "ancient city"},
				{"minecraft:fortress", "nether fortress"}, {"minecraft:bastion_remnant", "bastion"}, {"minecraft:end_city", "end city"},
				{"minecraft:ocean_ruin_warm", "ocean ruins"}};
		for (String[] pair : expected) check(pair[1].equals(SightedFeatures.structureLabel(pair[0])), pair[0] + " reads as " + pair[1]);
		check(SightedFeatures.structureLabel("minecraft:buried_treasure") == null, "buried treasure is never reported");
		check("sky tower".equals(SightedFeatures.structureLabel("mymod:sky_tower")), "a datapack structure reads as its name");
	}

	/**
	 * Review finding: natural blocks inside a structure piece's box (a desert temple's sandstone seen from a cave below)
	 * reported the structure though nothing built was visible. Only built blocks identify one now.
	 */
	private static void onlyBuiltBlocksIdentifyStructures() {
		for (var block : List.of(Blocks.SANDSTONE, Blocks.RED_SANDSTONE, Blocks.TERRACOTTA, Blocks.DYED_TERRACOTTA.orange(), Blocks.OAK_LOG,
				Blocks.OAK_LEAVES, Blocks.VINE, Blocks.SHORT_GRASS, Blocks.SNOW_BLOCK, Blocks.PACKED_ICE, Blocks.BLUE_ICE, Blocks.OBSIDIAN,
				Blocks.MAGMA_BLOCK, Blocks.SCULK, Blocks.CRIMSON_NYLIUM, Blocks.STONE, Blocks.DEEPSLATE, Blocks.WATER, Blocks.IRON_ORE,
				Blocks.SMOOTH_BASALT, Blocks.RAW_IRON_BLOCK, Blocks.COBWEB, Blocks.GRAVEL, Blocks.SAND)) {
			check(!SightedFeatures.built(block.defaultBlockState(), "desert temple"), block + " is terrain, not building");
		}
		for (var block : List.of(Blocks.CUT_SANDSTONE, Blocks.CHISELED_SANDSTONE, Blocks.SANDSTONE_STAIRS, Blocks.OAK_PLANKS,
				Blocks.SPRUCE_FENCE, Blocks.STONE_BRICKS, Blocks.MOSSY_COBBLESTONE, Blocks.PRISMARINE_BRICKS, Blocks.DARK_PRISMARINE,
				Blocks.NETHER_BRICKS, Blocks.POLISHED_BLACKSTONE_BRICKS, Blocks.GILDED_BLACKSTONE, Blocks.PURPUR_BLOCK,
				Blocks.END_STONE_BRICKS, Blocks.DEEPSLATE_TILES, Blocks.TUFF_BRICKS, Blocks.CUT_COPPER.waxed().unaffected(), Blocks.MUD_BRICKS,
				Blocks.CHEST, Blocks.RAIL, Blocks.GLASS_PANE, Blocks.WOOL.white(), Blocks.CRYING_OBSIDIAN, Blocks.HAY_BLOCK)) {
			check(SightedFeatures.built(block.defaultBlockState(), "village"), block + " shows building");
		}
		check(SightedFeatures.built(Blocks.OBSIDIAN.defaultBlockState(), "ruined portal"), "a ruined portal is known by its obsidian frame");
		check(SightedFeatures.built(Blocks.SNOW_BLOCK.defaultBlockState(), "igloo"), "an igloo is known by its snow dome");
	}

	/** Review finding: the sight cache keyed on the exact view rarely hit, so every observation recomputed the rows. */
	private static void sightedRecomputeIsThrottled() {
		ServerObservationCollector.SightedMemo memo = new ServerObservationCollector.SightedMemo("minecraft:overworld", 100L, Sample.EMPTY);
		check(ServerObservationCollector.sightedDue(null, "minecraft:overworld", 100L), "the first sample is computed");
		check(!ServerObservationCollector.sightedDue(memo, "minecraft:overworld", 109L), "within 10 ticks the rows are reused");
		check(ServerObservationCollector.sightedDue(memo, "minecraft:overworld", 110L), "after 10 ticks they are recomputed");
		check(ServerObservationCollector.sightedDue(memo, "minecraft:the_nether", 101L), "a dimension change recomputes at once");
		int recomputes = 0;
		ServerObservationCollector.SightedMemo current = null;
		for (long tick = 0; tick < 200; tick++) {
			if (ServerObservationCollector.sightedDue(current, "minecraft:overworld", tick)) {
				recomputes++;
				current = new ServerObservationCollector.SightedMemo("minecraft:overworld", tick, Sample.EMPTY);
			}
		}
		check(recomputes == 20, "an observation every tick for 10 s recomputes 20 times, not 200: " + recomputes);
		check(ServerObservationCollector.quantize(64.62D, ServerObservationCollector.LANDMARK_EYE_QUANTUM) == 64.5D
				&& ServerObservationCollector.quantize(64.70D, ServerObservationCollector.LANDMARK_EYE_QUANTUM) == 64.5D,
				"eye positions within a quarter block share a landmark key");
		check(ServerObservationCollector.quantize(91.0D, ServerObservationCollector.LANDMARK_VIEW_QUANTUM_DEGREES)
				== ServerObservationCollector.quantize(93.5D, ServerObservationCollector.LANDMARK_VIEW_QUANTUM_DEGREES),
				"a 2.5 degree head movement reuses the sight rays");
		stillAgentKeepsItsRows();
	}

	/** An idle agent's heartbeats (every 10 ticks or more) would recompute identical rows; a still pose keeps them. */
	private static void stillAgentKeepsItsRows() {
		String overworld = "minecraft:overworld";
		ServerObservationCollector.StillPose pose = new ServerObservationCollector.StillPose(null, null, 10.5D, 65.62D, -3.5D, 90.0F, 5.0F);
		ServerObservationCollector.SightedMemo settled = new ServerObservationCollector.SightedMemo(overworld, 100L, Sample.EMPTY, pose, true);
		check(!ServerObservationCollector.sightedDue(settled, overworld, 109L, pose), "inside the recompute interval nothing changes");
		check(!ServerObservationCollector.sightedDue(settled, overworld, 110L, pose), "a still agent keeps its rows past 10 ticks");
		check(!ServerObservationCollector.sightedDue(settled, overworld, 199L, pose), "and up to the still bound");
		check(ServerObservationCollector.sightedDue(settled, overworld, 100L + ServerObservationCollector.SIGHTED_STILL_TICKS, pose),
				"the still bound ends the reuse");
		ServerObservationCollector.StillPose turned = new ServerObservationCollector.StillPose(null, null, 10.5D, 65.62D, -3.5D, 90.5F, 5.0F);
		check(ServerObservationCollector.sightedDue(settled, overworld, 110L, turned), "any change of view recomputes after the interval");
		ServerObservationCollector.StillPose moved = new ServerObservationCollector.StillPose(null, null, 10.51D, 65.62D, -3.5D, 90.0F, 5.0F);
		check(ServerObservationCollector.sightedDue(settled, overworld, 110L, moved), "any step recomputes after the interval");
		check(!ServerObservationCollector.sightedDue(settled, overworld, 105L, moved), "the 10 tick interval still holds for a moving agent");
		ServerObservationCollector.SightedMemo unsettled = new ServerObservationCollector.SightedMemo(overworld, 100L, Sample.EMPTY, pose, false);
		check(ServerObservationCollector.sightedDue(unsettled, overworld, 110L, pose), "rows from an unfinished far-sight scan are never reused");
		check(ServerObservationCollector.sightedDue(settled, "minecraft:the_nether", 101L, pose), "a dimension change recomputes at once");
		check(ServerObservationCollector.sightedDue(null, overworld, 100L, pose), "the first sample is computed");
	}

	/** A far-sight row is announced once, rides passive updates for 30 s, and is announced again after a minute away. */
	private static void announcements() {
		SightedFeatures.Announcements seen = new SightedFeatures.Announcements();
		check(seen.see("village", 100) == 100, "first sighting is announced now");
		check(seen.see("village", 400) == 100, "a second glance keeps the first announcement");
		check(seen.see("village", 1_500) == 100, "a steady sighting (glances under a minute apart) is never re-announced");
		long back = 1_500 + SightedFeatures.NEW_STRUCTURE_TICKS + 1;
		check(seen.see("village", back) == back, "seen again after a minute out of sight is announced again");
		for (int index = 0; index < SightedFeatures.MAX_REMEMBERED_STRUCTURES + 5; index++) seen.see("s" + index, 5_000 + index);
		check(seen.size() <= SightedFeatures.MAX_REMEMBERED_STRUCTURES, "the latch is bounded");
	}

	private static FarSight.Row farRow(FarSight.Section section, String key, String label, List<String> blocks, int count, int size, Cell cell) {
		return new FarSight.Row(section, key, label, blocks, count, size, cell, Math.sqrt((double) cell.x() * cell.x() + (double) cell.z() * cell.z()));
	}

	private static void rendering() {
		SightedFeatures.Announcements seen = new SightedFeatures.Announcements();
		check(SightedFeatures.toJson(Sample.EMPTY, Vec3.ZERO, 0.0F, seen, 0L) == null, "nothing seen: no field");
		Sample sample = new Sample(
				List.of(farRow(FarSight.Section.STRUCTURES, "minecraft:shipwreck@1,2", "shipwreck", List.of(), 0, 20, new Cell(0, 60, 40)),
						farRow(FarSight.Section.STRUCTURES, "minecraft:village_plains@9,9", null, List.of("minecraft:oak_planks", "minecraft:cobblestone"), 0, 48, new Cell(0, 70, 150)),
						farRow(FarSight.Section.BUILT, "built@1,2,3", null, List.of("minecraft:oak_planks", "minecraft:glass", "minecraft:torch"), 0, 20, new Cell(-100, 64, 100)),
						farRow(FarSight.Section.BIOMES, "biome:minecraft:desert", "minecraft:desert", List.of(), 0, 0, new Cell(64, 64, 64)),
						farRow(FarSight.Section.POI, "poi:minecraft:nether_portal@1", "minecraft:nether_portal", List.of(), 0, 0, new Cell(10, 64, 120)),
						farRow(FarSight.Section.BLOCKS, "lava@1", "minecraft:lava", List.of(), 12, 0, new Cell(5, 60, 20))),
				List.of(new Sighting("cave@0,0,1", null, new Cell(10, 0, 0), 10.2, 44)),
				List.of(new Sighting("minecraft:iron_ore@1,0,0", "minecraft:deepslate_iron_ore", new Cell(1, 0, 0), 1.2, 5)));
		JsonObject json = SightedFeatures.toJson(sample, new Vec3(0.5D, 0.0D, 0.5D), 0.0F, seen, 1_000L);
		JsonObject near = json.getAsJsonArray("structures").get(0).getAsJsonObject();
		check("shipwreck".equals(near.get("structure").getAsString()) && near.get("new").getAsBoolean(), "a near structure is named and marked new");
		check(near.get("distance").getAsLong() == 40 && near.get("bearing").getAsLong() == 0, "straight ahead at 40 blocks");
		JsonObject far = json.getAsJsonArray("structures").get(1).getAsJsonObject();
		check(!far.has("structure") && far.getAsJsonArray("blocks").size() == 2 && far.get("size").getAsInt() == 48,
				"a far structure gives clues (built blocks seen, size), not a name");
		JsonObject built = json.getAsJsonArray("built").get(0).getAsJsonObject();
		check(built.getAsJsonArray("blocks").size() == 3 && built.get("size").getAsInt() == 20 && built.get("bearing").getAsLong() == 45,
				"a built cluster lists its seen blocks, its size and a bearing (45 degrees to the right)");
		check("minecraft:desert".equals(json.getAsJsonArray("biomes").get(0).getAsJsonObject().get("biome").getAsString()), "biome row");
		check("minecraft:nether_portal".equals(json.getAsJsonArray("poi").get(0).getAsJsonObject().get("blockId").getAsString()), "poi row");
		check(json.getAsJsonArray("blocks").get(0).getAsJsonObject().get("count").getAsInt() == 12, "a lava pool row carries its exposed size");
		JsonObject cave = json.getAsJsonArray("caves").get(0).getAsJsonObject();
		check(cave.get("air").getAsInt() == 44 && cave.get("bearing").getAsLong() == -90, "a cave to the east is 90 degrees off a south-facing view, signed like landmarks");
		JsonObject vein = json.getAsJsonArray("veins").get(0).getAsJsonObject();
		check(vein.get("visible").getAsInt() == 5 && "minecraft:deepslate_iron_ore".equals(vein.get("blockId").getAsString()), "vein row keeps the seen block id and count");

		JsonObject later = SightedFeatures.toJson(sample, Vec3.ZERO, 0.0F, seen, 1_000L + SightedFeatures.RECENT_TICKS);
		check(later.getAsJsonArray("structures").size() == 2 && !later.getAsJsonArray("structures").get(0).getAsJsonObject().has("new"),
				"within 30 s the rows stay in passive updates without the new flag");
		JsonObject steady = SightedFeatures.toJson(sample, Vec3.ZERO, 0.0F, seen, 1_000L + SightedFeatures.RECENT_TICKS + 1);
		check(!steady.has("structures") && !steady.has("built") && !steady.has("biomes") && !steady.has("poi") && !steady.has("blocks"),
				"after 30 s a structure still in view is not re-told on every passive update");
		check(steady.has("caves") && steady.has("veins"), "caves and veins still describe the current view");
		JsonObject survey = SightedFeatures.render(sample, Vec3.ZERO, 0.0F, seen, 1_000L + SightedFeatures.RECENT_TICKS + 2, false,
				Map.of(FarSight.Section.STRUCTURES, 1), java.util.EnumSet.of(FarSight.Section.STRUCTURES, FarSight.Section.BUILT));
		check(survey.getAsJsonArray("structures").size() == 1 && survey.has("built") && !survey.has("caves") && !survey.has("biomes"),
				"a survey shows known rows again, only the asked sections, and honours the per-section limit");
		check(json.toString().length() < 1_100, "every section filled stays compact: " + json.toString().length() + " characters");
	}

	private static void farSightKinds() {
		BlockState planks = Blocks.OAK_PLANKS.defaultBlockState();
		check(FarSight.looksBuilt(planks, 0) && FarSight.looksBuilt(Blocks.GLASS.defaultBlockState(), 0) && FarSight.looksBuilt(Blocks.TORCH.defaultBlockState(), 0),
				"planks, glass and torches look built");
		check(FarSight.looksBuilt(Blocks.NETHERRACK.defaultBlockState(), 0) && !FarSight.looksBuilt(Blocks.NETHERRACK.defaultBlockState(), 1),
				"netherrack is out of place in the overworld, not in the Nether");
		check(FarSight.looksBuilt(Blocks.GRASS_BLOCK.defaultBlockState(), 1) && FarSight.looksBuilt(Blocks.OAK_LOG.defaultBlockState(), 1)
				&& !FarSight.looksBuilt(Blocks.CRIMSON_STEM.defaultBlockState(), 1), "overworld ground and logs are out of place in the Nether; its own stems are not");
		for (Block natural : List.of(Blocks.STONE, Blocks.GRASS_BLOCK, Blocks.SAND, Blocks.OAK_LOG, Blocks.OAK_LEAVES, Blocks.OBSIDIAN, Blocks.MAGMA_BLOCK,
				Blocks.MOSSY_COBBLESTONE, Blocks.MOSS_CARPET, Blocks.PALE_MOSS_CARPET, Blocks.IRON_ORE, Blocks.WATER, Blocks.SMOOTH_BASALT)) {
			check(!FarSight.looksBuilt(natural.defaultBlockState(), 0), natural + " is terrain (boulders and moss carpets included)");
		}
		check(FarSight.kinds(Blocks.LAVA.defaultBlockState(), 0) == FarSight.LAVA, "lava");
		check(FarSight.kinds(Blocks.DEEPSLATE_DIAMOND_ORE.defaultBlockState(), 0) == FarSight.ORE, "ore");
		check(FarSight.kinds(Blocks.SPAWNER.defaultBlockState(), 0) == (FarSight.NOTABLE | FarSight.BUILT), "a spawner is notable and built");
		check((FarSight.kinds(Blocks.BELL.defaultBlockState(), 0) & FarSight.POI) != 0 && (FarSight.kinds(Blocks.NETHER_PORTAL.defaultBlockState(), 0) & FarSight.POI) != 0,
				"bells and portals are points of interest");
		check(FarSight.kinds(Blocks.AIR.defaultBlockState(), 0) == 0 && FarSight.kinds(Blocks.STONE.defaultBlockState(), 0) == 0, "air and stone are nothing");
		BlockState air = Blocks.AIR.defaultBlockState(), stone = Blocks.STONE.defaultBlockState(), lava = Blocks.LAVA.defaultBlockState();
		check(FarSight.faceOpen(stone, air) && FarSight.faceOpen(stone, Blocks.GLASS.defaultBlockState()) && FarSight.faceOpen(stone, Blocks.WATER.defaultBlockState()),
				"a face next to air, glass or water can be seen");
		check(!FarSight.faceOpen(stone, stone) && !FarSight.faceOpen(planks, Blocks.DIRT.defaultBlockState()), "a face against a solid block cannot");
		check(FarSight.faceOpen(lava, air) && !FarSight.faceOpen(lava, lava) && !FarSight.faceOpen(lava, stone), "lava shows only where it meets air");
		check(FarSight.noticeableDistance(FarSight.LARGE_CLUSTER) == FarSight.RANGE && FarSight.noticeableDistance(FarSight.LARGE_CLUSTER - 1) == FarSight.SMALL_SIGHT,
				"big clusters are noticed to full range, small ones only up close");
		check(FarSight.SMALL_SIGHT == 24 && FarSight.NAMED_STRUCTURE_DISTANCE == 64 && FarSight.RANGE == 256, "documented sight distances");
	}

	private static FarSight.Found found(int x, int y, int z) {
		return new FarSight.Found(net.minecraft.core.BlockPos.asLong(x, y, z), Blocks.OAK_PLANKS.defaultBlockState(), FarSight.BUILT, 1);
	}

	private static double horizontal(FarSight.Found entry) {
		double x = net.minecraft.core.BlockPos.getX(entry.position()), z = net.minecraft.core.BlockPos.getZ(entry.position());
		return Math.sqrt(x * x + z * z);
	}

	private static void farSightClusters() {
		List<FarSight.Found> blocks = new ArrayList<>();
		for (int x = 100; x < 105; x++) for (int y = 64; y < 68; y++) blocks.add(found(x, y, 50));
		blocks.add(found(10, 64, 10));
		blocks.add(found(300, 64, 50));
		var clusters = FarSight.cluster(blocks, SightedFeaturesVerification::horizontal);
		check(clusters.size() == 3, "a house and two far-apart torches are three clusters: " + clusters.size());
		check(clusters.get(0).members().size() == 1 && clusters.get(1).members().size() == 20, "nearest cluster first; the house keeps all 20 blocks");
		check(net.minecraft.core.BlockPos.getX(clusters.get(1).members().getFirst().position()) == 100, "members are nearest first");
	}

	private static void farSightGeometry() {
		var box = new net.minecraft.world.level.levelgen.structure.BoundingBox(10, 60, 10, 19, 69, 19);
		check(FarSight.boxDistance(new Vec3(0.0D, 65.0D, 15.0D), box) == 10.0D, "distance to a box is to its nearest face");
		check(FarSight.boxDistance(new Vec3(15.0D, 65.0D, 15.0D), box) == 0.0D, "inside a box is distance 0");
		List<Vec3> points = FarSight.aimPoints(new Vec3(0.0D, 65.0D, 15.0D), box);
		check(points.size() == 3 && points.contains(new Vec3(15.0D, 65.0D, 15.0D)) && points.contains(new Vec3(15.0D, 69.5D, 15.0D))
				&& points.contains(new Vec3(10.5D, 65.0D, 15.0D)), "aim at the centre, the top and the side facing the eye: " + points);
		check(FarSight.aimPoints(new Vec3(30.0D, 65.0D, 30.0D), box).size() == 4, "from a corner both facing sides are aimed at");
	}

	/** Review fix: sizes and noticeability come only from seen blocks; one visible torch in front of a hidden house is small. */
	private static void seenPartsOnly() {
		List<FarSight.Found> house = new ArrayList<>();
		for (int x = 200; x < 205; x++) for (int y = 64; y < 68; y++) for (int z = 0; z < 5; z++) house.add(found(x, y, z));
		var cluster = FarSight.cluster(house, SightedFeaturesVerification::horizontal).getFirst();
		check(cluster.members().size() >= FarSight.LARGE_CLUSTER, "the fixture house has many exposed blocks");
		long torch = cluster.members().getFirst().position();
		FarSight.SeenPart one = FarSight.seenPart(cluster, member -> member.position() == torch, SightedFeaturesVerification::horizontal, 16);
		check(one.count() == 0, "one visible torch at 200 blocks is not reported because of hidden blocks behind it");
		FarSight.SeenPart front = FarSight.seenPart(cluster, member -> net.minecraft.core.BlockPos.getX(member.position()) == 200,
				SightedFeaturesVerification::horizontal, 32);
		check(front.count() >= FarSight.LARGE_CLUSTER && front.horizontalSize() >= 2 && front.horizontalSize() <= 5, "a visible front wall is reported at the size of its seen part: "
				+ front.count() + " seen, size " + front.horizontalSize());
		var near = FarSight.cluster(List.of(found(10, 64, 0), found(10, 65, 0)), SightedFeaturesVerification::horizontal).getFirst();
		check(FarSight.seenPart(near, member -> true, SightedFeaturesVerification::horizontal, 16).count() == 2, "up close one seen block is enough");
		check(FarSight.seenPart(near, member -> false, SightedFeaturesVerification::horizontal, 16).count() == 0, "nothing seen, nothing reported");
	}

	/** Review fix: a cluster keeps one key wherever it is seen from, so walking along a wall does not re-announce it. */
	private static void stableClusterKeys() {
		List<FarSight.Found> wall = new ArrayList<>();
		for (int x = 0; x < 64; x++) wall.add(found(x, 64, 100));
		long fromWest = FarSight.cluster(wall, entry -> Math.abs(net.minecraft.core.BlockPos.getX(entry.position()) - 0)).getFirst().seed();
		long fromEast = FarSight.cluster(wall, entry -> Math.abs(net.minecraft.core.BlockPos.getX(entry.position()) - 63)).getFirst().seed();
		check(fromWest == fromEast, "the seed of a 64-block wall is the same from either end");
		check(!FarSight.rowId("built@" + fromWest).equals(FarSight.rowId("built@" + (fromWest + 1))) && FarSight.rowId("x").length() <= 7,
				"row ids are short and tell clusters apart");
	}

	/** Review fix: a survey marks rows known without starting the 30 s passive window, and only unknown rows are new. */
	private static void surveysAcknowledge() {
		SightedFeatures.Announcements seen = new SightedFeatures.Announcements();
		Sample sample = new Sample(List.of(farRow(FarSight.Section.STRUCTURES, "minecraft:village_plains@1,1", "village", List.of(), 0, 30, new Cell(0, 64, 50))),
				List.of(), List.of());
		JsonObject survey = SightedFeatures.render(sample, Vec3.ZERO, 0.0F, seen, 100L, false, Map.of(), java.util.EnumSet.allOf(FarSight.Section.class));
		JsonObject row = survey.getAsJsonArray("structures").get(0).getAsJsonObject();
		check(row.get("new").getAsBoolean() && row.has("id"), "a survey shows an unknown village as new, with an id");
		check(SightedFeatures.toJson(sample, Vec3.ZERO, 0.0F, seen, 110L) == null, "the next passive update does not repeat a surveyed village");
		JsonObject again = SightedFeatures.render(sample, Vec3.ZERO, 0.0F, seen, 120L, false, Map.of(), java.util.EnumSet.allOf(FarSight.Section.class));
		check(!again.getAsJsonArray("structures").get(0).getAsJsonObject().has("new"), "a second survey does not call it new");
		check(SightedFeatures.toJson(sample, Vec3.ZERO, 0.0F, seen, 120L + SightedFeatures.NEW_STRUCTURE_TICKS + 1).getAsJsonArray("structures")
				.get(0).getAsJsonObject().get("new").getAsBoolean(), "out of sight for a minute, it is announced passively again");
		check(!SightedFeatures.toJson(sample, Vec3.ZERO, 0.0F, new SightedFeatures.Announcements(), 0L).getAsJsonArray("structures").get(0).getAsJsonObject().has("id"),
				"passive rows carry no id");
	}

	/** Review fix: fog limits sight with the eye in water or lava, as the 26.1 client draws it. */
	/** Review fix: a far structure's size is the span of the blocks seen, a sparse lower bound, never its hidden pieces. */
	private static void structureSizeFromSeenBlocks() {
		var hiddenFortressPiece = new net.minecraft.world.level.levelgen.structure.BoundingBox(0, 40, 0, 79, 70, 39);
		List<net.minecraft.core.BlockPos> one = List.of(new net.minecraft.core.BlockPos(30, 60, 20));
		check(hiddenFortressPiece.isInside(one.getFirst()) && FarSight.seenSpan(one) == 1,
				"one seen block of an 80-wide piece is size 1, not the piece's generated bounds");
		check(FarSight.seenSpan(List.of(new net.minecraft.core.BlockPos(10, 60, 5), new net.minecraft.core.BlockPos(22, 75, 9))) == 13,
				"two seen blocks span 13 along x; height does not count");
		check(FarSight.seenSpan(List.of(new net.minecraft.core.BlockPos(-3, 60, -20), new net.minecraft.core.BlockPos(0, 60, 4))) == 25,
				"the wider horizontal axis sets the size, negative coordinates included");
		check(FarSight.seenSpan(List.of()) == 0, "nothing seen, no size");
	}

	/** Runs real generated-piece sight rays and the naming branch, rather than rendering pre-labelled rows. */
	private static void structureNamingBoundary() {
		try {
			var field = sun.misc.Unsafe.class.getDeclaredField("theUnsafe"); field.setAccessible(true);
			var unsafe = (sun.misc.Unsafe) field.get(null);
			var level = (StructureBoundaryLevel) unsafe.allocateInstance(StructureBoundaryLevel.class);
			level.chunks = (StructureBoundaryChunks) unsafe.allocateInstance(StructureBoundaryChunks.class);
			level.chunks.level = level;
			var box = new net.minecraft.world.level.levelgen.structure.BoundingBox(64, 64, 0, 64, 64, 0);
			var piece = (net.minecraft.world.level.levelgen.structure.StructurePiece) unsafe.allocateInstance(
					net.minecraft.world.level.levelgen.structure.PoolElementStructurePiece.class);
			var bounds = net.minecraft.world.level.levelgen.structure.StructurePiece.class.getDeclaredField("boundingBox");
			bounds.setAccessible(true); bounds.set(piece, box);
			var settings = new net.minecraft.world.level.levelgen.structure.Structure.StructureSettings(
					net.minecraft.core.HolderSet.<net.minecraft.world.level.biome.Biome>direct(java.util.List.of()), java.util.Map.of(),
					net.minecraft.world.level.levelgen.GenerationStep.Decoration.SURFACE_STRUCTURES,
					net.minecraft.world.level.levelgen.structure.TerrainAdjustment.NONE);
			var structure = new net.minecraft.world.level.levelgen.structure.structures.DesertPyramidStructure(settings);
			var start = new net.minecraft.world.level.levelgen.structure.StructureStart(structure,
					new net.minecraft.world.level.ChunkPos(4, 0), 0,
					new net.minecraft.world.level.levelgen.structure.pieces.PiecesContainer(java.util.List.of(piece)));
			Class<?> startView = Class.forName(FarSight.class.getName() + "$StartView");
			var constructor = startView.getDeclaredConstructor(net.minecraft.world.level.levelgen.structure.StructureStart.class,
					String.class, String.class, double.class);
			constructor.setAccessible(true);
			Object view = constructor.newInstance(start, "generated-desert-pyramid", "desert pyramid", 64D);
			var rowsMethod = FarSight.class.getDeclaredMethod("structureRows", net.minecraft.server.level.ServerLevel.class,
					FarSight.Sight.class, java.util.List.class, int.class);
			rowsMethod.setAccessible(true);
			for (double distance : new double[]{63.999D, 64D, 64.001D}) {
				Vec3 eye = new Vec3(64.5D - distance, 64.5D, .5D);
				var sight = new FarSight.Sight(level, eye, new Vec3(1, 0, 0), 256D,
						net.minecraft.world.phys.shapes.CollisionContext.empty(), new FarSight.SightCache(), 32);
				@SuppressWarnings("unchecked")
				var rows = (java.util.List<FarSight.Row>) rowsMethod.invoke(null, level, sight, java.util.List.of(view), 4);
				check(rows.size() == 1, "real generated piece remains visible at naming boundary " + distance);
				var row = rows.getFirst();
				check(Math.abs(row.distance() - distance) < 1.0E-9D, "naming uses actual sighted block center distance");
				check(distance <= 64D ? "desert pyramid".equals(row.label()) : row.label() == null,
						"structure name applies through64 inclusive and is withheld beyond64");
				check(distance <= 64D ? row.blocks().isEmpty() : row.blocks().equals(java.util.List.of("minecraft:oak_planks")),
						"far sight retains only the observed building material instead of its generated name");
				check(row.size() == 1, "structure seen size is the one actual ray hit, not hidden generated extent");
			}
			level.obstructed = true;
			var sight = new FarSight.Sight(level, new Vec3(.5D, 64.5D, .5D), new Vec3(1, 0, 0), 256D,
					net.minecraft.world.phys.shapes.CollisionContext.empty(), new FarSight.SightCache(), 32);
			check(((java.util.List<?>) rowsMethod.invoke(null, level, sight, java.util.List.of(view), 4)).isEmpty(),
					"a generated structure behind real terrain supplies neither name nor material facts");
		} catch (ReflectiveOperationException failure) { throw new AssertionError("real structure naming boundary fixture failed", failure); }
	}

	private static final class StructureBoundaryLevel extends net.minecraft.server.level.ServerLevel {
		// 26.3 entities take their ID from the level, and ServerLevel asks its (absent) chunk source.
		private int fixtureEntityIds = 100_000;
		@Override public int getNextEntityId() { return ++fixtureEntityIds; }
		StructureBoundaryChunks chunks;
		boolean obstructed;
		/** Every chunk unloaded: reading a block would make the server load one. */
		boolean unloaded;
		private StructureBoundaryLevel() { super(null, null, null, null, null, null, false, 0L, java.util.List.of(), false); }
		@Override public net.minecraft.server.level.ServerChunkCache getChunkSource() { return chunks; }
		@Override public boolean hasChunkAt(net.minecraft.core.BlockPos position) { return !unloaded; }
		@Override public int getHeight() { return 384; }
		@Override public int getMinY() { return -64; }
		@Override public int getMaxY() { return 320; }
		@Override public net.minecraft.world.level.block.entity.BlockEntity getBlockEntity(net.minecraft.core.BlockPos position) { return null; }
		@Override public BlockState getBlockState(net.minecraft.core.BlockPos position) {
			if (unloaded) throw new AssertionError("far sight read an unloaded chunk's block, which loads it");
			if (position.equals(new net.minecraft.core.BlockPos(64, 64, 0))) return Blocks.OAK_PLANKS.defaultBlockState();
			if (obstructed && position.getX() == 32) return Blocks.STONE.defaultBlockState();
			return Blocks.AIR.defaultBlockState();
		}
		@Override public net.minecraft.world.level.material.FluidState getFluidState(net.minecraft.core.BlockPos position) {
			return getBlockState(position).getFluidState();
		}
	}

	private static final class StructureBoundaryChunks extends net.minecraft.server.level.ServerChunkCache {
		StructureBoundaryLevel level;
		private StructureBoundaryChunks() { super(null, null, null, null, null, null, 0, 0, false, null); }
		@Override public net.minecraft.world.level.chunk.LevelChunk getChunkNow(int x, int z) {
			if (level.unloaded) return null;
			StructureBoundaryChunk chunk = allocate(StructureBoundaryChunk.class);
			chunk.level = level;
			return chunk;
		}
	}

	/** A loaded chunk that reads its blocks from the fixture level. */
	private static final class StructureBoundaryChunk extends net.minecraft.world.level.chunk.LevelChunk {
		StructureBoundaryLevel level;
		private StructureBoundaryChunk() { super((net.minecraft.world.level.Level) null, (net.minecraft.world.level.ChunkPos) null); }
		@Override public BlockState getBlockState(net.minecraft.core.BlockPos position) { return level.getBlockState(position); }
	}

	private static void fogRange() {
		double clear = 1024.0D, nether = 96.0D;
		check(FarSight.sightRange(false, false, false, 0.0F, clear) == FarSight.RANGE, "in air the full range");
		check(FarSight.sightRange(false, false, false, 0.0F, nether) == 96.0D, "the Nether's fog ends at 96 blocks");
		check(FarSight.sightRange(true, false, false, 0.0F, clear) == 1.0D && FarSight.sightRange(true, true, false, 0.0F, clear) == 5.0D,
				"in lava 1 block, 5 with fire resistance");
		check(FarSight.sightRange(false, false, true, FarSight.waterVision(0), clear) == 24.0D, "just under water 24 blocks");
		check(Math.abs(FarSight.sightRange(false, false, true, FarSight.waterVision(100), clear) - 57.6D) < 0.01D, "after 5 s under water about 58 blocks");
		check(FarSight.sightRange(false, false, true, FarSight.waterVision(600), clear) == 96.0D, "after 30 s under water 96 blocks");
		check(FarSight.knownByMaterial("nether fortress", Set.of("minecraft:nether_brick_fence"))
				&& !FarSight.knownByMaterial("nether fortress", Set.of("minecraft:chest"))
				&& !FarSight.knownByMaterial("bastion", Set.of("minecraft:polished_blackstone_bricks")),
				"nether bricks name a fortress at any distance; other materials and structures need 64 blocks");
		FarSight.SightCache cache = new FarSight.SightCache();
		cache.waterVision(true, 0L);
		check(Math.abs(cache.waterVision(true, 100L) - 0.6F) < 0.001F, "the server follows the client's water vision timer");
		check(cache.waterVision(false, 105L) < 0.6F, "leaving the water fades it");
	}

	/** Review fix: passes, surveys and section reads are capped per level per tick, shared by all agents and searches. */
	private static void perTickBudgets() {
		FarSight.LevelIndex index = new FarSight.LevelIndex();
		int passes = 0, surveys = 0;
		for (int agent = 0; agent < 8; agent++) {
			if (index.tryPass(500L, false)) passes++;
			if (index.tryPass(500L, true)) surveys++;
		}
		check(passes == FarSight.PASSES_PER_TICK && surveys == FarSight.SURVEYS_PER_TICK, "8 agents on one tick: 2 passes and 1 survey run");
		check(index.tryPass(501L, false), "the next tick has budget again");
		check(!FarSight.searchable(Blocks.STONE) && !FarSight.searchable(Blocks.WATER) && FarSight.searchable(Blocks.DIAMOND_ORE),
				"terrain is not searchable; ores are");
		try {
			FarSight.surveyRequest(List.of("blocks:minecraft:stone"), List.of(), 4);
			throw new AssertionError("a stone search was accepted");
		} catch (dev.agaminggod.arenaagents.agent.AgentDomainException expected) {
			check("INVALID_INSPECTION".equals(expected.code()), "a survey refuses to search stone");
			check(expected.getMessage().equals("minecraft:stone is bulk terrain, not searchable; observed blocks list exposed terrain"),
					"the refusal says the search is unsupported and where exposed terrain is listed");
		}
		check(FarSight.Request.passive().cachedOnly().clips() == 0, "a survey over budget makes no new sight lines");
	}

	/** Audit fix: a section with more exposed blocks than one read keeps is finished over later reads, not truncated. */
	private static void denseSectionsAreReadThrough() {
		ScanLevel level = ScanLevel.create();
		ScanChunk chunk = level.add(0, 0);
		// 100 exposed planks fill the first cells read; the chest sits after them in read order.
		for (int i = 0; i < 100; i++) chunk.set(i & 15, 0, i >> 4, Blocks.OAK_PLANKS.defaultBlockState());
		chunk.set(8, 10, 8, Blocks.CHEST.defaultBlockState());
		FarSight.LevelIndex index = new FarSight.LevelIndex();
		Vec3 eye = new Vec3(8.5D, 5.5D, 8.5D);
		Gathered first = gather(level, index, eye);
		check(!first.complete() && first.notable().isEmpty(), "a dense section is unfinished after one read and says so");
		Gathered later = first;
		int reads = 1;
		while (!later.complete() && reads++ < 10) later = gather(level, index, eye);
		check(later.complete() && reads <= 3, "repeated bounded reads finish the section: " + reads);
		check(later.notable().size() == 1 && net.minecraft.core.BlockPos.getY(later.notable().getFirst().position()) == 10,
				"the chest after the first 96 exposed blocks is found");
		check(later.built().stream().filter(found -> found.state().is(Blocks.OAK_PLANKS)).count() == 100
				&& later.built().stream().map(FarSight.Found::position).distinct().count() == later.built().size(),
				"every exposed plank is kept once, none twice");
		List<FarSight.Found> matches = new ArrayList<>();
		int searches = 0;
		boolean done = false;
		while (!done && searches++ < 10) {
			matches.clear();
			done = FarSight.search(level, index, eye, Blocks.OAK_PLANKS, matches);
		}
		check(done && searches == 2 && matches.size() == 100 && matches.stream().map(FarSight.Found::position).distinct().count() == 100,
				"a block search past 96 matches resumes and returns each match once: " + searches + " reads, " + matches.size());
		// One tick's shared read budget still caps the work: the 9th section read in a tick waits.
		ScanLevel busy = ScanLevel.create();
		for (int x = 0; x < 3; x++) for (int z = 0; z < 3; z++) {
			ScanChunk dense = busy.add(x, z);
			for (int i = 0; i < 100; i++) dense.set(i & 15, 0, i >> 4, Blocks.OAK_PLANKS.defaultBlockState());
		}
		FarSight.LevelIndex shared = new FarSight.LevelIndex();
		gather(busy, shared, new Vec3(24.5D, 5.5D, 24.5D));
		check(scansThisTick(shared) == FarSight.SECTION_SCANS_PER_TICK, "section reads stay within the per-tick budget");
	}

	/** Audit fix: digging the block that covers an ore in the next section or chunk exposes it to the cached scan. */
	private static void neighbourEditsExposeBlocks() {
		ScanLevel level = ScanLevel.create();
		ScanChunk home = level.add(0, 0);
		ScanChunk east = level.add(1, 0);
		for (int x = 0; x < 16; x++) for (int y = 0; y < 16; y++) for (int z = 0; z < 16; z++) {
			home.set(x, y, z, Blocks.STONE.defaultBlockState());
			east.set(x, y, z, Blocks.STONE.defaultBlockState());
		}
		for (int x = 0; x < 16; x++) for (int z = 0; z < 16; z++) home.set(x, 16, z, Blocks.STONE.defaultBlockState());
		home.set(3, 15, 3, Blocks.IRON_ORE.defaultBlockState());
		home.set(15, 8, 8, Blocks.IRON_ORE.defaultBlockState());
		home.revisions[0] = 0;
		home.revisions[1] = 0;
		east.revisions[0] = 0;
		FarSight.LevelIndex index = new FarSight.LevelIndex();
		Vec3 eye = new Vec3(8.5D, 17.5D, 8.5D);
		check(gather(level, index, eye).ore().isEmpty(), "buried ore is not exposed");
		int resets = index.sectionResets;
		check(gather(level, index, eye).ore().isEmpty() && index.sectionResets == resets, "an unchanged neighbourhood keeps its scans");
		home.set(3, 16, 3, Blocks.AIR.defaultBlockState());
		check(oreAt(gather(level, index, eye), 3, 15, 3), "removing the cover in the section above exposes the ore");
		List<FarSight.Found> searched = new ArrayList<>();
		FarSight.search(level, index, eye, Blocks.IRON_ORE, searched);
		check(searched.size() == 1, "a block search sees the uncovered ore");
		east.set(0, 8, 8, Blocks.AIR.defaultBlockState());
		check(oreAt(gather(level, index, eye), 15, 8, 8), "removing the cover in the next chunk exposes the ore");
		searched.clear();
		FarSight.search(level, index, eye, Blocks.IRON_ORE, searched);
		check(searched.size() == 2, "a block search sees ore uncovered across a chunk border");
		level.chunks.loaded.remove(net.minecraft.world.level.ChunkPos.pack(1, 0));
		check(!oreAt(gather(level, index, eye), 15, 8, 8), "a face toward an unloaded chunk is hidden again");
		ScanChunk reloaded = level.add(1, 0);
		for (int x = 0; x < 16; x++) for (int y = 0; y < 16; y++) for (int z = 0; z < 16; z++) reloaded.set(x, y, z, Blocks.STONE.defaultBlockState());
		reloaded.set(0, 8, 8, Blocks.AIR.defaultBlockState());
		reloaded.revisions[0] = 0;
		check(oreAt(gather(level, index, eye), 15, 8, 8), "a neighbour chunk loading in exposes the ore");
		ScanChunk replaced = level.add(1, 0);
		for (int x = 0; x < 16; x++) for (int y = 0; y < 16; y++) for (int z = 0; z < 16; z++) replaced.set(x, y, z, Blocks.STONE.defaultBlockState());
		replaced.revisions[0] = 0;
		check(!oreAt(gather(level, index, eye), 15, 8, 8), "a replaced neighbour chunk with a reset write count still invalidates the scan");
	}

	/**
	 * Review fix: edits in a neighbouring section that leave the layer touching this section unchanged do not restart
	 * its read, so a busy neighbour cannot keep a dense section from finishing; a change on that layer re-reads only
	 * the blocks along it, including ones already passed.
	 */
	private static void neighbourEditsKeepScanProgress() {
		ScanLevel level = ScanLevel.create();
		ScanChunk home = level.add(0, 0);
		ScanChunk east = level.add(1, 0);
		for (int x = 0; x < 16; x++) for (int y = 0; y < 16; y++) for (int z = 0; z < 16; z++) east.set(x, y, z, Blocks.STONE.defaultBlockState());
		for (int x = 0; x < 16; x++) for (int z = 0; z < 16; z++) home.set(x, 0, z, Blocks.STONE.defaultBlockState());
		// 100 exposed planks on y=1, then a chest; an ore among them is buried until the stone east of it in the next chunk goes.
		for (int i = 0; i < 100; i++) home.set(i & 15, 1, i >> 4, Blocks.OAK_PLANKS.defaultBlockState());
		home.set(15, 1, 2, Blocks.IRON_ORE.defaultBlockState());
		home.set(14, 1, 2, Blocks.STONE.defaultBlockState());
		home.set(15, 2, 2, Blocks.STONE.defaultBlockState());
		home.set(8, 10, 8, Blocks.CHEST.defaultBlockState());
		FarSight.LevelIndex index = new FarSight.LevelIndex();
		Vec3 eye = new Vec3(8.5D, 5.5D, 8.5D);
		Gathered gathered = gather(level, index, eye);
		check(!gathered.complete() && !oreAt(gathered, 15, 1, 2), "the first read passes the buried ore and stops early");
		int passes = 0;
		boolean chest = false;
		while (passes < 20 && !chest) {
			// Every pass digs or refills a block inside the neighbouring chunk, away from the shared face.
			east.set(8, 8, 8, passes++ % 2 == 0 ? Blocks.AIR.defaultBlockState() : Blocks.STONE.defaultBlockState());
			chest = !gather(level, index, eye).notable().isEmpty();
		}
		check(chest && passes == 1, "interior edits next door keep the read going: the chest is found on the next pass, not never (" + passes + ")");
		east.set(0, 1, 2, Blocks.AIR.defaultBlockState());
		gathered = gather(level, index, eye);
		check(oreAt(gathered, 15, 1, 2) && index.faceRereads > 0,
				"uncovering the ore across the chunk border re-reads only that face");
		check(gathered.built().stream().map(FarSight.Found::position).distinct().count() == gathered.built().size()
				&& gathered.built().stream().filter(found -> found.state().is(Blocks.OAK_PLANKS)).count() == 98,
				"re-reading a face keeps each plank once");
		List<FarSight.Found> searched = new ArrayList<>();
		FarSight.search(level, index, eye, Blocks.IRON_ORE, searched);
		check(searched.size() == 1, "a block search sees the uncovered ore");
		east.set(0, 1, 2, Blocks.STONE.defaultBlockState());
		check(!oreAt(gather(level, index, eye), 15, 1, 2), "covering it again hides it");
		searched.clear();
		FarSight.search(level, index, eye, Blocks.IRON_ORE, searched);
		check(searched.isEmpty(), "and the block search drops it too");
	}

	private static boolean oreAt(Gathered gathered, int x, int y, int z) {
		return gathered.ore().stream().anyMatch(found -> found.position() == net.minecraft.core.BlockPos.asLong(x, y, z));
	}

	/** Audit fix: a survey over the tick's cap answers from the agent's cached sight lines instead of nothing. */
	@SuppressWarnings("unchecked")
	private static void cachedSurveyReusesSightLines() {
		try {
			var field = sun.misc.Unsafe.class.getDeclaredField("theUnsafe"); field.setAccessible(true);
			var unsafe = (sun.misc.Unsafe) field.get(null);
			var level = (StructureBoundaryLevel) unsafe.allocateInstance(StructureBoundaryLevel.class);
			level.chunks = (StructureBoundaryChunks) unsafe.allocateInstance(StructureBoundaryChunks.class);
			level.chunks.level = level;
			FarSight.SightCache cache = new FarSight.SightCache();
			Vec3 eye = new Vec3(40.5D, 64.5D, .5D);
			FarSight.Found plank = new FarSight.Found(net.minecraft.core.BlockPos.asLong(64, 64, 0), Blocks.OAK_PLANKS.defaultBlockState(), FarSight.NOTABLE, 0b111111);
			ToDoubleFunction<FarSight.Found> distance = found -> Math.sqrt(eye.distanceToSqr(Vec3.atCenterOf(net.minecraft.core.BlockPos.of(found.position()))));
			var warm = new FarSight.Sight(level, eye, new Vec3(1, 0, 0), 256D, net.minecraft.world.phys.shapes.CollisionContext.empty(), cache, 32);
			check(FarSight.notableRows(warm, List.of(plank), distance, 4).size() == 1 && warm.clips > 0, "the first look casts its sight lines");
			var over = new FarSight.Sight(level, eye, new Vec3(1, 0, 0), 256D, net.minecraft.world.phys.shapes.CollisionContext.empty(), cache, 0);
			List<FarSight.Row> rows = FarSight.notableRows(over, List.of(plank), distance, 4);
			check(rows.size() == 1 && rows.getFirst().key().equals("block@" + plank.position()),
					"a survey with no new sight lines reports the cached sighting: " + rows);
			var fresh = new FarSight.Sight(level, eye, new Vec3(1, 0, 0), 256D, net.minecraft.world.phys.shapes.CollisionContext.empty(),
					new FarSight.SightCache(), 0);
			check(FarSight.notableRows(fresh, List.of(plank), distance, 4).isEmpty() && fresh.clips == 0,
					"without a cached sight line a zero-budget look reports nothing and casts nothing");
			check(over.clips == 0, "the cached answer casts no new sight line");
			Class<?> startView = Class.forName(FarSight.class.getName() + "$StartView");
			var constructor = startView.getDeclaredConstructor(net.minecraft.world.level.levelgen.structure.StructureStart.class, String.class, String.class, double.class);
			constructor.setAccessible(true);
			var box = new net.minecraft.world.level.levelgen.structure.BoundingBox(64, 64, 0, 64, 64, 0);
			var piece = (net.minecraft.world.level.levelgen.structure.StructurePiece) unsafe.allocateInstance(
					net.minecraft.world.level.levelgen.structure.PoolElementStructurePiece.class);
			var bounds = net.minecraft.world.level.levelgen.structure.StructurePiece.class.getDeclaredField("boundingBox");
			bounds.setAccessible(true); bounds.set(piece, box);
			var settings = new net.minecraft.world.level.levelgen.structure.Structure.StructureSettings(
					net.minecraft.core.HolderSet.<net.minecraft.world.level.biome.Biome>direct(List.of()), Map.of(),
					net.minecraft.world.level.levelgen.GenerationStep.Decoration.SURFACE_STRUCTURES,
					net.minecraft.world.level.levelgen.structure.TerrainAdjustment.NONE);
			var start = new net.minecraft.world.level.levelgen.structure.StructureStart(
					new net.minecraft.world.level.levelgen.structure.structures.DesertPyramidStructure(settings),
					new net.minecraft.world.level.ChunkPos(4, 0), 0,
					new net.minecraft.world.level.levelgen.structure.pieces.PiecesContainer(List.of(piece)));
			Object view = constructor.newInstance(start, "cached-pyramid", "desert pyramid", 24D);
			var rowsMethod = FarSight.class.getDeclaredMethod("structureRows", net.minecraft.server.level.ServerLevel.class, FarSight.Sight.class, List.class, int.class);
			rowsMethod.setAccessible(true);
			var structureCache = new FarSight.SightCache();
			var first = new FarSight.Sight(level, eye, new Vec3(1, 0, 0), 256D, net.minecraft.world.phys.shapes.CollisionContext.empty(), structureCache, 32);
			check(((List<FarSight.Row>) rowsMethod.invoke(null, level, first, List.of(view), 4)).size() == 1, "the first survey sees the structure");
			var second = new FarSight.Sight(level, eye, new Vec3(1, 0, 0), 256D, net.minecraft.world.phys.shapes.CollisionContext.empty(), structureCache, 0);
			check(((List<FarSight.Row>) rowsMethod.invoke(null, level, second, List.of(view), 4)).size() == 1 && second.clips == 0,
					"a second survey in the tick reuses the cached structure sighting");
			// Review fix: after the chunks unload, cached answers must not read (and so load) them.
			level.unloaded = true;
			var afterUnload = new FarSight.Sight(level, eye, new Vec3(1, 0, 0), 256D, net.minecraft.world.phys.shapes.CollisionContext.empty(), structureCache, 0);
			check(((List<FarSight.Row>) rowsMethod.invoke(null, level, afterUnload, List.of(view), 4)).isEmpty(),
					"a cached structure sighting in an unloaded chunk is dropped without loading it");
			var blockAfterUnload = new FarSight.Sight(level, eye, new Vec3(1, 0, 0), 256D, net.minecraft.world.phys.shapes.CollisionContext.empty(), cache, 0);
			check(FarSight.notableRows(blockAfterUnload, List.of(plank), distance, 4).isEmpty(),
					"a cached block sighting in an unloaded chunk is dropped without loading it");
			level.unloaded = false;
		} catch (ReflectiveOperationException failure) { throw new AssertionError("cached survey fixture failed", failure); }
	}

	private record Gathered(boolean complete, List<FarSight.Found> built, List<FarSight.Found> notable, List<FarSight.Found> ore) {
	}

	private static Gathered gather(ScanLevel level, FarSight.LevelIndex index, Vec3 eye) {
		level.tick++;
		List<FarSight.Found> built = new ArrayList<>(), lava = new ArrayList<>(), notable = new ArrayList<>(), ore = new ArrayList<>(), poi = new ArrayList<>();
		boolean complete = FarSight.scanAround(level, index, eye, new ArrayList<>(level.chunks.loaded.values()), 0, built, lava, notable, ore, poi, Map.of());
		return new Gathered(complete, built, notable, ore);
	}

	private static int scansThisTick(FarSight.LevelIndex index) {
		try {
			var field = FarSight.LevelIndex.class.getDeclaredField("scansThisTick");
			field.setAccessible(true);
			return field.getInt(index);
		} catch (ReflectiveOperationException failure) { throw new AssertionError(failure); }
	}

	private static <T> T allocate(Class<T> type) {
		try {
			var field = sun.misc.Unsafe.class.getDeclaredField("theUnsafe"); field.setAccessible(true);
			Object allocated = ((sun.misc.Unsafe) field.get(null)).allocateInstance(type); if (allocated instanceof net.minecraft.world.entity.Entity entity) entity.setId(UNSAFE_ENTITY_IDS.incrementAndGet()); return type.cast(allocated); // 26.3 assigns entity IDs in the constructor.
		} catch (ReflectiveOperationException failure) { throw new AssertionError(failure); }
	}

	/** A two-section (y 0 to 31) level of loaded test chunks; constructors are never run. */
	private static final class ScanLevel extends net.minecraft.server.level.ServerLevel {
		// 26.3 entities take their ID from the level, and ServerLevel asks its (absent) chunk source.
		private int fixtureEntityIds = 100_000;
		@Override public int getNextEntityId() { return ++fixtureEntityIds; }
		ScanChunks chunks;
		long tick;
		private ScanLevel() { super(null, null, null, null, null, null, false, 0L, List.of(), false); }

		static ScanLevel create() {
			ScanLevel level = allocate(ScanLevel.class);
			level.chunks = allocate(ScanChunks.class);
			level.chunks.loaded = new HashMap<>();
			return level;
		}

		ScanChunk add(int x, int z) {
			ScanChunk chunk = allocate(ScanChunk.class);
			chunk.position = new net.minecraft.world.level.ChunkPos(x, z);
			chunk.sections = new net.minecraft.world.level.chunk.LevelChunkSection[2];
			chunk.revisions = new long[2];
			for (int i = 0; i < 2; i++) {
				chunk.sections[i] = new net.minecraft.world.level.chunk.LevelChunkSection(new net.minecraft.world.level.chunk.PalettedContainer<>(
						Blocks.AIR.defaultBlockState(), net.minecraft.world.level.chunk.Strategy.createForBlockStates(Block.BLOCK_STATE_REGISTRY)), null);
			}
			chunks.loaded.put(chunk.position.pack(), chunk);
			return chunk;
		}

		@Override public net.minecraft.server.level.ServerChunkCache getChunkSource() { return chunks; }
		@Override public int getHeight() { return 32; }
		@Override public int getMinY() { return 0; }
		@Override public int getMaxY() { return 31; }
		@Override public long getGameTime() { return tick; }
	}

	private static final class ScanChunks extends net.minecraft.server.level.ServerChunkCache {
		Map<Long, ScanChunk> loaded;
		private ScanChunks() { super(null, null, null, null, null, null, 0, 0, false, null); }
		@Override public net.minecraft.world.level.chunk.LevelChunk getChunkNow(int x, int z) { return loaded.get(net.minecraft.world.level.ChunkPos.pack(x, z)); }
	}

	/** A loaded chunk that counts writes per section as the mixin does. */
	private static final class ScanChunk extends net.minecraft.world.level.chunk.LevelChunk implements dev.agaminggod.arenaagents.world.ChunkMutationRevisionAccess {
		net.minecraft.world.level.ChunkPos position;
		net.minecraft.world.level.chunk.LevelChunkSection[] sections;
		long[] revisions;
		private ScanChunk() { super((net.minecraft.world.level.Level) null, (net.minecraft.world.level.ChunkPos) null); }

		void set(int x, int y, int z, BlockState state) {
			sections[y >> 4].setBlockState(x & 15, y & 15, z & 15, state, false);
			revisions[y >> 4]++;
		}

		@Override public net.minecraft.world.level.ChunkPos getPos() { return position; }
		@Override public net.minecraft.world.level.chunk.LevelChunkSection[] getSections() { return sections; }
		@Override public int getMinY() { return 0; }
		@Override public int getHeight() { return 32; }
		@Override public BlockState getBlockState(net.minecraft.core.BlockPos pos) {
			int section = pos.getY() >> 4;
			if (pos.getY() < 0 || section >= sections.length) return Blocks.AIR.defaultBlockState();
			return sections[section].getBlockState(pos.getX() & 15, pos.getY() & 15, pos.getZ() & 15);
		}
		@Override public long arenaagents$sectionMutationRevision(int sectionIndex) { return revisions[sectionIndex]; }
		@Override public boolean arenaagents$changedSinceLoad(net.minecraft.core.BlockPos pos) { return false; }
	}

	private static void surveyRequests() {
		FarSight.Request all = FarSight.surveyRequest(List.of(), List.of(), 4);
		check(all.sections().size() == FarSight.Section.values().length && all.searched().isEmpty() && all.clips() == FarSight.SURVEY_CLIPS,
				"no include means every section");
		FarSight.Request some = FarSight.surveyRequest(List.of("structures", "blocks:minecraft:diamond_ore"), List.of(), 2);
		check(some.sections().equals(java.util.EnumSet.of(FarSight.Section.STRUCTURES, FarSight.Section.BLOCKS))
				&& some.searched().equals(List.of(Blocks.DIAMOND_ORE)), "include picks sections and blocks:<id> searches");
		FarSight.Request less = FarSight.surveyRequest(List.of(), List.of("biomes", "caves"), 4);
		check(!less.wants(FarSight.Section.BIOMES) && !less.wants(FarSight.Section.CAVES) && less.wants(FarSight.Section.BUILT), "exclude drops sections");
		for (var bad : List.of(List.of("mineshafts"), List.of("blocks:minecraft:not_a_block"))) {
			try {
				FarSight.surveyRequest(bad, List.of(), 4);
				throw new AssertionError("survey accepted " + bad);
			} catch (dev.agaminggod.arenaagents.agent.AgentDomainException expected) {
				check("INVALID_INSPECTION".equals(expected.code()), "survey rejects " + bad);
			}
		}
		check(FarSight.Request.passive().clips() == FarSight.PASSIVE_CLIPS && FarSight.PASSIVE_CLIPS < FarSight.SURVEY_CLIPS,
				"passive passes use the smaller line-of-sight budget");
	}

	private static void attention() {
		JsonObject previous = new JsonObject();
		JsonObject current = new JsonObject();
		JsonObject sighted = new JsonObject();
		JsonArray structures = new JsonArray();
		JsonObject row = new JsonObject();
		row.addProperty("structure", "village");
		structures.add(row);
		sighted.add("structures", structures);
		current.add("sighted", sighted);
		check(!AttentionSignalPolicy.newStructureSighted(current), "a known structure does not wake the model");
		check(!AttentionSignalPolicy.changedFacts(previous, current).contains("sighted"), "no attention without a new structure");
		row.addProperty("new", true);
		check(AttentionSignalPolicy.newStructureSighted(current), "a new structure is detected");
		check(AttentionSignalPolicy.changedFacts(previous, current).contains("sighted"), "a new structure requests attention");
		for (String section : List.of("built", "poi", "biomes", "blocks")) {
			JsonObject quiet = new JsonObject();
			JsonObject rows = new JsonObject();
			JsonArray array = new JsonArray();
			JsonObject fresh = new JsonObject();
			fresh.addProperty("new", true);
			array.add(fresh);
			rows.add(section, array);
			quiet.add("sighted", rows);
			boolean wakes = section.equals("built") || section.equals("poi");
			check(AttentionSignalPolicy.newStructureSighted(quiet) == wakes,
					"a new " + section + " row " + (wakes ? "wakes the model" : "rides along without waking it"));
		}
	}

	private static void naturalTerrain() {
		check(SightedFeatures.natural(Blocks.STONE.defaultBlockState()) && SightedFeatures.natural(Blocks.DEEPSLATE.defaultBlockState()), "stone is natural");
		check(SightedFeatures.natural(Blocks.WATER.defaultBlockState()) && SightedFeatures.natural(Blocks.SAND.defaultBlockState()), "water and sand are natural");
		check(SightedFeatures.natural(Blocks.IRON_ORE.defaultBlockState()), "ore is part of a cave wall");
		check(!SightedFeatures.natural(Blocks.OAK_PLANKS.defaultBlockState()) && !SightedFeatures.natural(Blocks.COBBLESTONE.defaultBlockState()),
				"planks and cobblestone are not cave walls");
		check(SightedFeatures.natural(Blocks.SANDSTONE.defaultBlockState()) && SightedFeatures.natural(Blocks.OBSIDIAN.defaultBlockState())
				&& SightedFeatures.natural(Blocks.SNOW_BLOCK.defaultBlockState()) && SightedFeatures.natural(Blocks.MAGMA_BLOCK.defaultBlockState()),
				"sandstone, obsidian, snow and magma line natural caves");
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		checks++;
	}
}
