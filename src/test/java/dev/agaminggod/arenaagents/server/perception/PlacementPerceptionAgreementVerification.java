package dev.agaminggod.arenaagents.server.perception;

import dev.agaminggod.arenaagents.server.runtime.controller.AcquiredGeometry;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.Holder;
import net.minecraft.core.component.DataComponentMap;
import net.minecraft.core.component.DataComponents;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.SnowLayerBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.block.state.properties.SlabType;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.Vec3;

/**
 * The placeable faces an observation lists for a block are exactly the faces placement accepts for the same held item
 * (PR #77 follow-up): the click's own placement context decides, not a generic replaceable or sturdy-face rule.
 */
public final class PlacementPerceptionAgreementVerification {
	private static final java.util.concurrent.atomic.AtomicInteger UNSAFE_ENTITY_IDS = new java.util.concurrent.atomic.AtomicInteger(200_000);
	private static int checks;

	private PlacementPerceptionAgreementVerification() { }

	public static int verify() {
		checks = 0;
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		Map<Holder.Reference<Item>, DataComponentMap> originals = new IdentityHashMap<>();
		try {
			for (Item item : new Item[] {Items.COBBLESTONE, Items.SNOW, Items.OAK_SLAB}) bind(originals, item);
			agreement();
			bodyClearance();
		} finally {
			restore(originals);
		}
		return checks;
	}

	private record Case(String name, BlockState support, Item held, boolean placeable) { }

	private static void agreement() {
		BlockState snow = Blocks.SNOW.defaultBlockState();
		BlockState bottomSlab = Blocks.OAK_SLAB.defaultBlockState();
		List<Case> cases = List.of(
				new Case("one snow layer is replaced by a cobblestone click", snow.setValue(SnowLayerBlock.LAYERS, 1), Items.COBBLESTONE, false),
				new Case("two snow layers hold a cobblestone placed on top", snow.setValue(SnowLayerBlock.LAYERS, 2), Items.COBBLESTONE, true),
				new Case("two snow layers take another layer from a snow item instead", snow.setValue(SnowLayerBlock.LAYERS, 2), Items.SNOW, false),
				new Case("eight snow layers are clicked like a block", snow.setValue(SnowLayerBlock.LAYERS, 8), Items.COBBLESTONE, true),
				new Case("grass is replaced by the click", Blocks.SHORT_GRASS.defaultBlockState(), Items.COBBLESTONE, false),
				new Case("a bottom slab's top holds a cobblestone", bottomSlab, Items.COBBLESTONE, true),
				new Case("an oak slab clicked on a bottom oak slab merges into it", bottomSlab, Items.OAK_SLAB, false),
				new Case("a top slab's top holds an oak slab", bottomSlab.setValue(BlockStateProperties.SLAB_TYPE, SlabType.TOP), Items.OAK_SLAB, true),
				new Case("a fence top holds a cobblestone", Blocks.OAK_FENCE.defaultBlockState(), Items.COBBLESTONE, true),
				new Case("a crafting table is sneak-clicked to place on it", Blocks.CRAFTING_TABLE.defaultBlockState(), Items.COBBLESTONE, true),
				new Case("with no block item held, a cobblestone stands in: two snow layers hold it", snow.setValue(SnowLayerBlock.LAYERS, 2), Items.AIR, true),
				new Case("with no block item held, grass is still replaced", Blocks.SHORT_GRASS.defaultBlockState(), Items.AIR, false));
		BlockPos support = new BlockPos(0, 64, 0);
		BlockPos destination = support.above();
		for (Case entry : cases) {
			Fixture fixture = fixture();
			fixture.level.states.put(support, entry.support());
			fixture.player.hand = entry.held() == Items.AIR ? ItemStack.EMPTY : new ItemStack(entry.held());
			ItemStack basis = ServerObservationCollector.placementBasis(fixture.player);
			boolean perceived = ServerObservationCollector.placeableFaces(fixture.player, support, entry.support(), fixture.terrain(),
					new AcquiredGeometry(fixture.level, fixture.level::getBlockState), basis).contains(Direction.UP);
			boolean placed = placementFace(fixture.player, destination, Direction.UP) != null;
			check(perceived == entry.placeable(), "perception: " + entry.name());
			// Placement with no block item held places nothing; the stand-in judges the faces for a typical full block.
			if (entry.held() != Items.AIR) check(placed == perceived, "placement agrees with perception: " + entry.name());
		}
		Fixture empty = fixture();
		empty.player.hand = ItemStack.EMPTY;
		check(ServerObservationCollector.placementBasis(empty.player).is(Items.COBBLESTONE),
				"an empty hand is judged for a cobblestone stand-in");
		empty.player.hand = new ItemStack(Items.OAK_SLAB);
		check(ServerObservationCollector.placementBasis(empty.player) == empty.player.hand, "a held block item is judged for itself");
		// A face the agent cannot see is not listed, and placement refuses it too.
		Fixture hidden = fixture();
		hidden.level.states.put(support, Blocks.STONE.defaultBlockState());
		hidden.level.states.put(new BlockPos(0, 66, 1), Blocks.STONE.defaultBlockState());
		hidden.level.states.put(new BlockPos(0, 65, 1), Blocks.STONE.defaultBlockState());
		hidden.player.hand = new ItemStack(Items.COBBLESTONE);
		boolean perceived = ServerObservationCollector.placeableFaces(hidden.player, support, Blocks.STONE.defaultBlockState(), hidden.terrain(),
				new AcquiredGeometry(hidden.level, hidden.level::getBlockState), hidden.player.hand).contains(Direction.UP);
		check(!perceived && placementFace(hidden.player, destination, Direction.UP) == null,
				"a top face hidden behind blocks is neither listed nor placed against");
	}

	private static void bodyClearance() {
		BlockPos support = new BlockPos(1, 64, 0);
		for (int variant = 0; variant < 3; variant++) {
			Fixture f = fixture();
			double x = variant == 0 ? 0.5 : 0.85, y = variant == 2 ? 65.5 : 65;
			set(f.player, "position", new Vec3(x, y, 0.5));
			set(f.player, "bb", new net.minecraft.world.phys.AABB(x - 0.3, y, 0.2, x + 0.3, y + 1.8, 0.8));
			f.level.states.put(support, Blocks.STONE.defaultBlockState());
			f.player.hand = new ItemStack(variant == 2 ? Items.OAK_SLAB : Items.COBBLESTONE);
			boolean offered = ServerObservationCollector.placeableFaces(f.player, support, Blocks.STONE.defaultBlockState(), f.terrain(),
					new AcquiredGeometry(f.level, f.level::getBlockState), f.player.hand).contains(Direction.UP);
			check(offered == (variant != 1), "adjacent full block, overlapping full block, and clear slab use actual collision shapes: " + variant);
		}
	}

	private static Direction placementFace(ServerPlayer player, BlockPos destination, Direction face) {
		try {
			Method method = dev.agaminggod.arenaagents.server.runtime.ServerActionExecutor.class
					.getDeclaredMethod("placementFace", ServerPlayer.class, BlockPos.class, Direction.class);
			method.setAccessible(true);
			return (Direction) method.invoke(null, player, destination, face);
		} catch (ReflectiveOperationException failure) {
			throw new AssertionError("placementFace is not reachable", failure);
		}
	}

	private record Fixture(FixtureLevel level, FixturePlayer player) {
		dev.agaminggod.arenaagents.server.perception.SeenTerrain.Reader<BlockState> terrain() {
			return new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), new SeenTerrain.Source<>() {
				@Override public BlockState live(int x, int y, int z) { return level.getBlockState(new BlockPos(x, y, z)); }
				@Override public boolean sees(int x, int y, int z) { return true; }
			}, 1L, null);
		}
	}

	/** A player standing two blocks south of the support, eye 1.62 above its feet at y=65. */
	private static Fixture fixture() {
		FixtureLevel level = allocate(FixtureLevel.class);
		level.states = new HashMap<>();
		FixturePlayer player = allocate(FixturePlayer.class);
		player.fixtureLevel = level;
		player.hand = ItemStack.EMPTY;
		player.inventory = new net.minecraft.world.entity.player.Inventory(null, new net.minecraft.world.entity.EntityEquipment());
		set(player, "bb", new net.minecraft.world.phys.AABB(0.2, 65, 2.2, 0.8, 66.8, 2.8));
		set(player, "position", new Vec3(0.5D, 65.0D, 2.5D));
		set(player, "eyeHeight", 1.62F);
		return new Fixture(level, player);
	}

	private static final class FixtureLevel extends ServerLevel {
		// 26.3 entities take their ID from the level, and ServerLevel asks its (absent) chunk source.
		private int fixtureEntityIds = 100_000;
		@Override public int getNextEntityId() { return ++fixtureEntityIds; }
		Map<BlockPos, BlockState> states;
		private FixtureLevel() { super(null, null, null, null, null, null, false, 0L, List.of(), false); }
		@Override public BlockState getBlockState(BlockPos position) { return states.getOrDefault(position, Blocks.AIR.defaultBlockState()); }
		@Override public FluidState getFluidState(BlockPos position) { return getBlockState(position).getFluidState(); }
		@Override public net.minecraft.world.level.block.entity.BlockEntity getBlockEntity(BlockPos position) { return null; }
		@Override public int getHeight() { return 384; }
		@Override public int getMinY() { return -64; }
	}

	private static final class FixturePlayer extends ServerPlayer {
		FixtureLevel fixtureLevel;
		ItemStack hand;
		net.minecraft.world.entity.player.Inventory inventory;
		@Override public net.minecraft.world.entity.player.Inventory getInventory() { return inventory; }
		boolean shift;
		private FixturePlayer() { super(null, null, null, null); }
		@Override public ServerLevel level() { return fixtureLevel; }
		@Override public ItemStack getMainHandItem() { return hand; }
		@Override public ItemStack getOffhandItem() { return ItemStack.EMPTY; }
		@Override public ItemStack getItemBySlot(EquipmentSlot slot) { return slot == EquipmentSlot.MAINHAND ? hand : ItemStack.EMPTY; }
		@Override public double blockInteractionRange() { return 4.5D; }
		@Override public boolean isShiftKeyDown() { return shift; }
		@Override public void setShiftKeyDown(boolean down) { shift = down; }
	}

	private static <T> T allocate(Class<T> type) {
		try {
			Field field = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
			field.setAccessible(true);
			Object allocated = ((sun.misc.Unsafe) field.get(null)).allocateInstance(type); if (allocated instanceof net.minecraft.world.entity.Entity entity) entity.setId(UNSAFE_ENTITY_IDS.incrementAndGet()); return type.cast(allocated); // 26.3 assigns entity IDs in the constructor.
		} catch (ReflectiveOperationException failure) { throw new AssertionError(failure); }
	}

	private static void set(Entity entity, String name, Object value) {
		try {
			Field field = Entity.class.getDeclaredField(name);
			field.setAccessible(true);
			field.set(entity, value);
		} catch (ReflectiveOperationException failure) { throw new AssertionError(failure); }
	}

	private static void bind(Map<Holder.Reference<Item>, DataComponentMap> originals, Item item) {
		Holder.Reference<Item> holder = item.builtInRegistryHolder();
		DataComponentMap original = holder.areComponentsBound() ? holder.components() : null;
		originals.put(holder, original);
		DataComponentMap.Builder components = DataComponentMap.builder();
		if (original != null) components.addAll(original);
		components.set(DataComponents.MAX_STACK_SIZE, 64);
		holder.bindComponents(components.build());
	}

	private static void restore(Map<Holder.Reference<Item>, DataComponentMap> originals) {
		try {
			Field components = Holder.Reference.class.getDeclaredField("components");
			components.setAccessible(true);
			for (Map.Entry<Holder.Reference<Item>, DataComponentMap> entry : originals.entrySet()) components.set(entry.getKey(), entry.getValue());
		} catch (ReflectiveOperationException failure) { throw new AssertionError(failure); }
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		checks++;
	}
}
