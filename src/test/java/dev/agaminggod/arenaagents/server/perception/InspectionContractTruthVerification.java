package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonObject;
import com.google.gson.JsonArray;
import it.unimi.dsi.fastutil.longs.LongArrayList;
import dev.agaminggod.arenaagents.agent.AgentDomainException;
import dev.agaminggod.arenaagents.agent.AgentId;
import dev.agaminggod.arenaagents.server.runtime.controller.AcquiredGeometry;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.core.RegistryAccess;
import net.minecraft.core.component.DataComponentMap;
import net.minecraft.core.component.DataComponents;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.dedicated.DedicatedServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityDimensions;
import net.minecraft.world.entity.EntityEquipment;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.ai.attributes.Attribute;
import net.minecraft.world.entity.ai.attributes.AttributeInstance;
import net.minecraft.world.entity.ai.attributes.AttributeModifier;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.entity.player.Abilities;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.Items;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.damagesource.DamageType;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

/** Executes focused inspection admission and current-mechanics production paths. */
public final class InspectionContractTruthVerification {
	private static int assertions;
	private InspectionContractTruthVerification() { }

	public static int verify() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		assertions = 0;
		try (AirComponents ignored = new AirComponents()) {
			Field field = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
			field.setAccessible(true);
			var unsafe = (sun.misc.Unsafe) field.get(null);
			FixturePlayer player = (FixturePlayer) unsafe.allocateInstance(FixturePlayer.class);
			player.setId(1025); // 26.3 assigns entity IDs in the constructor, which Unsafe allocation skips.
			FixtureLevel level = (FixtureLevel) unsafe.allocateInstance(FixtureLevel.class);
			level.world = new SparseWorld();
			level.loaded = true;
			player.fixtureLevel = level;
			player.inventory = new Inventory(null, new EntityEquipment());
			player.abilities = new Abilities();
			player.attributes = new HashMap<>();
			set(player, Entity.class, "position", new Vec3(.5D, 64, .5D));
			player.xo = .5D; player.yo = 64; player.zo = .5D;
			set(player, Entity.class, "blockPosition", new BlockPos(0, 64, 0));
			set(player, Entity.class, "bb", new AABB(.2D, 64, .2D, .8D, 65.8D, .8D));
			set(player, Entity.class, "eyeHeight", 1.62F);
			set(player, Entity.class, "dimensions", EntityDimensions.scalable(.6F, 1.8F));
			var collector = (ServerObservationCollector) unsafe.allocateInstance(ServerObservationCollector.class);
			Method inspect = ServerObservationCollector.class.getDeclaredMethod("inspectionSection", ServerPlayer.class,
					JsonObject.class, String.class, int.class, int.class);
			inspect.setAccessible(true);
			verifyItemAdmission(collector, inspect, player);
			verifyBlockAdmission(collector, inspect, player);
			verifyMechanics(unsafe, player);
			verifyAcquiredDetailGeometry();
			verifyEventPagingBoundaries();
			verifyStreamedPlacementFaces(player);
			verifyEffectProducer(player);
			verifyHazardMemoryProducer(player);
			verifyLastDamageProducer(player);
			return assertions;
		} catch (ReflectiveOperationException failure) {
			throw new AssertionError("could not execute inspection contract fixture", failure);
		}
	}

	public static void main(String[] args) {
		System.out.println("PASS: " + verify() + " inspection contract truth assertions");
	}

	private static void verifyItemAdmission(Object collector, Method inspect, FixturePlayer player) throws ReflectiveOperationException {
		int size = player.inventory.getContainerSize();
		for (int slot : new int[] {-1, size}) {
			JsonObject query = new JsonObject();
			query.addProperty("slot", slot);
			refusal(collector, inspect, player, query, "item", "INVALID_INSPECTION");
		}
		for (int slot : new int[] {0, size - 1}) {
			JsonObject query = new JsonObject();
			query.addProperty("slot", slot);
			JsonObject result = section(collector, inspect, player, query, "item");
			check(result.getAsJsonObject("item").get("slot").getAsInt() == slot, "item returns the exact requested legal slot");
			check(result.getAsJsonObject("item").get("count").getAsInt() == 0, "empty item inspection does not invent a stack");
			check(!result.has("tooltipPage") && !result.has("pages") && !result.has("map"), "empty item has no content pages");
		}
		check(player.inventory.isEmpty(), "read-only item inspection leaves inventory unchanged");
	}

	private static void verifyBlockAdmission(Object collector, Method inspect, FixturePlayer player) throws ReflectiveOperationException {
		FixtureLevel level = player.fixtureLevel;
		BlockPos target = new BlockPos(3, 65, 0);
		level.world.states.put(target, Blocks.DIAMOND_ORE.defaultBlockState());
		JsonObject query = coordinates(target);
		face(player, target);
		level.loaded = false;
		int clips = level.clips;
		refusal(collector, inspect, player, query, "block", "TARGET_NOT_VISIBLE");
		check(level.clips == clips, "unloaded block is refused before clipping hidden terrain");
		level.loaded = true;
		set(player, Entity.class, "yRot", 90F);
		player.yRotO = 90F; player.yHeadRot = 90F; player.yHeadRotO = 90F;
		refusal(collector, inspect, player, query, "block", "TARGET_NOT_VISIBLE");
		face(player, target);
		for (int y = 64; y <= 67; y++) for (int z = -2; z <= 2; z++) {
			level.world.states.put(new BlockPos(1, y, z), Blocks.STONE.defaultBlockState());
		}
		refusal(collector, inspect, player, query, "block", "TARGET_NOT_VISIBLE");
		check(level.blockEntityReads == 0, "rejected block detail never reads block entity contents");
		level.world.states.clear();
		BlockPos far = new BlockPos(10, 65, 0);
		level.world.states.put(far, Blocks.DIAMOND_ORE.defaultBlockState());
		face(player, far);
		check(ObservationVisibility.canSeeBlock(level, player, far), "range-control target really is currently visible");
		refusal(collector, inspect, player, coordinates(far), "block", "TARGET_OUT_OF_RANGE");
		check(level.blockEntityReads == 0, "out-of-range detail never reads block entity contents");
		level.world.states.put(target, Blocks.DIAMOND_ORE.defaultBlockState());
		face(player, target);
		JsonObject accepted = section(collector, inspect, player, query, "block").getAsJsonObject("block");
		equal("minecraft:diamond_ore", accepted.get("blockId").getAsString(), "currently visible in-range block detail returns actual identity");
		check(accepted.getAsJsonArray("bounds").size() == 1 && !accepted.get("boundsTruncated").getAsBoolean(), "visible ordinary block reports complete native outline");
		check(level.world.getBlockState(target).is(Blocks.DIAMOND_ORE), "focused block detail does not mutate its target");
		SeenTerrain.forget(player);
	}

	private static void verifyMechanics(sun.misc.Unsafe unsafe, FixturePlayer player) throws ReflectiveOperationException {
		MinecraftServer server = (MinecraftServer) unsafe.allocateInstance(DedicatedServer.class);
		Method getter = MinecraftServer.class.getMethod("tickRateManager");
		Class<?> managerType = getter.getReturnType();
		Object manager = unsafe.allocateInstance(managerType);
		// Configure the constructor-free manager without broadcasting to an absent player list.
		Class<?> rateOwner = managerType;
		while (rateOwner != null) {
			try { set(manager, rateOwner, "tickrate", 17.25F); break; }
			catch (NoSuchFieldException missing) { rateOwner = rateOwner.getSuperclass(); }
		}
		if (rateOwner == null) throw new AssertionError("tick rate fixture field is unavailable");
		for (Field field : MinecraftServer.class.getDeclaredFields()) {
			if (field.getType() == managerType) {
				field.setAccessible(true);
				field.set(server, manager);
			}
		}
		player.fixtureLevel.server = server;
		AttributeInstance movement = new AttributeInstance(Attributes.MOVEMENT_SPEED, ignored -> { });
		movement.setBaseValue(.17D);
		movement.addTransientModifier(new AttributeModifier(Identifier.parse("test:inspection"), .03D, AttributeModifier.Operation.ADD_VALUE));
		player.attributes.put(Attributes.MOVEMENT_SPEED, movement);
		player.abilities.mayfly = true;
		player.abilities.flying = true;
		player.abilities.mayBuild = false;
		player.abilities.instabuild = true;
		player.abilities.setWalkingSpeed(.13F);
		player.abilities.setFlyingSpeed(.08F);
		JsonObject mechanics = PlayerKnowledgeInspection.mechanics(player);
		equal(net.minecraft.SharedConstants.getCurrentVersion().name(), mechanics.get("minecraftVersion").getAsString(), "installed version");
		equal(net.minecraft.SharedConstants.getProtocolVersion(), mechanics.get("protocolVersion").getAsInt(), "installed protocol");
		equal(20, mechanics.get("nominalTicksPerSecond").getAsInt(), "nominal tick rate");
		equal(17.25F, mechanics.get("configuredTicksPerSecond").getAsFloat(), "configured tick rate is current server rate");
		equal(4.5D, mechanics.get("blockInteractionRange").getAsDouble(), "current block interaction range");
		equal(3D, mechanics.get("entityInteractionRange").getAsDouble(), "current entity interaction range");
		equal(player.getEyeHeight(), mechanics.get("eyeHeight").getAsFloat(), "current eye height");
		equal(player.getBbWidth(), mechanics.get("boundingBoxWidth").getAsFloat(), "current box width");
		equal(player.getBbHeight(), mechanics.get("boundingBoxHeight").getAsFloat(), "current box height");
		check(mechanics.getAsJsonArray("attributes").size() == 1, "missing attributes remain unknown instead of fabricated defaults");
		JsonObject attribute = mechanics.getAsJsonArray("attributes").get(0).getAsJsonObject();
		equal("minecraft:movement_speed", attribute.get("id").getAsString(), "attribute identity");
		equal(movement.getBaseValue(), attribute.get("baseValue").getAsDouble(), "base attribute value");
		equal(movement.getValue(), attribute.get("currentValue").getAsDouble(), "modified current attribute value");
		check(attribute.get("baseValue").getAsDouble() != attribute.get("currentValue").getAsDouble(), "fixture distinguishes base and current attributes");
		JsonObject abilities = mechanics.getAsJsonObject("abilities");
		check(abilities.get("mayFly").getAsBoolean() && abilities.get("flying").getAsBoolean(), "current permitted and active flight abilities");
		check(!abilities.get("mayBuild").getAsBoolean() && abilities.get("instantBuild").getAsBoolean(), "current build abilities");
		equal(.13F, abilities.get("walkingSpeed").getAsFloat(), "current ability walking speed");
		equal(.08F, abilities.get("flyingSpeed").getAsFloat(), "current ability flying speed");
		movement.setBaseValue(.11D);
		player.abilities.flying = false;
		JsonObject changed = PlayerKnowledgeInspection.mechanics(player);
		equal(movement.getValue(), changed.getAsJsonArray("attributes").get(0).getAsJsonObject().get("currentValue").getAsDouble(), "next read reflects changed attributes");
		check(!changed.getAsJsonObject("abilities").get("flying").getAsBoolean(), "next read reflects changed abilities");
		check(player.inventory.isEmpty() && player.fixtureLevel.world.states.size() == 2, "mechanics performs no inventory or terrain mutation");
	}

	private static void verifyAcquiredDetailGeometry() {
		SparseWorld world = new SparseWorld();
		BlockPos at = new BlockPos(3, 65, 0);
		Map<BlockPos, BlockState> acquired = new HashMap<>();
		BlockState water = Blocks.WATER.defaultBlockState();
		acquired.put(at, water);
		world.states.put(at, water);
		var geometry = new AcquiredGeometry(world, acquired::get);
		JsonObject before = new JsonObject();
		ObservationDetails.block(before, at, water, geometry);
		check(before.getAsJsonObject("fluid").get("height").isJsonNull(), "unseen fluid-height dependency remains unknown");
		world.states.put(at.above(), water);
		JsonObject hiddenChange = new JsonObject();
		ObservationDetails.block(hiddenChange, at, water, geometry);
		equal(before, hiddenChange, "changing unseen water above cannot change detail geometry");
		acquired.put(at.above(), water);
		JsonObject observedChange = new JsonObject();
		ObservationDetails.block(observedChange, at, water, geometry);
		equal(1F, observedChange.getAsJsonObject("fluid").get("height").getAsFloat(), "observed water above admits its actual full height");
		acquired.put(at.above(), Blocks.AIR.defaultBlockState());
		JsonObject observedAir = new JsonObject();
		ObservationDetails.block(observedAir, at, water, geometry);
		check(observedAir.getAsJsonObject("fluid").get("height").getAsFloat() < 1F, "observed air above admits lower vanilla fluid height");
		BlockState moving = Blocks.MOVING_PISTON.defaultBlockState();
		JsonObject piston = new JsonObject();
		ObservationDetails.block(piston, at, moving, geometry);
		check(piston.getAsJsonArray("bounds").isEmpty() && !piston.get("boundsTruncated").getAsBoolean(), "independent empty moving-piston outline remains complete");
		check(world.blockEntityReads == 0, "acquired outline never reads live hidden block entity data");
		JsonObject ordinary = new JsonObject();
		ObservationDetails.block(ordinary, at, Blocks.STONE.defaultBlockState(), geometry);
		check(ordinary.getAsJsonArray("bounds").size() == 1 && !ordinary.get("boundsTruncated").getAsBoolean(), "independent visible full-cube outline remains complete");
	}

	private static void verifyEventPagingBoundaries() {
		var stream = new PlayerObservationEvents.Stream();
		for (int index = 1; index <= 140; index++) stream.text("system_message", "message " + index, index, "minecraft:overworld");
		JsonObject boundary = stream.page(12, 0, 32);
		check(!boundary.getAsJsonObject("coverage").get("gap").getAsBoolean(), "afterSequence immediately before earliest retained event has no history gap");
		check(stream.page(11, 0, 32).getAsJsonObject("coverage").get("gap").getAsBoolean(), "afterSequence one event before retention boundary reports history gap");
		JsonObject tail = stream.page(138, 0, 32);
		check(tail.getAsJsonObject("coverage").get("total").getAsInt() == 2, "afterSequence returns only newer delivered events");
		check(tail.getAsJsonArray("entries").get(0).getAsJsonObject().get("sequence").getAsInt() == 139, "first returned event is strictly newer than afterSequence");
		check(!tail.getAsJsonObject("coverage").get("gap").getAsBoolean(), "retained newer events do not report an eviction gap");
		tail.getAsJsonArray("entries").get(0).getAsJsonObject().addProperty("text", "changed by caller");
		check(stream.page(138, 0, 32).getAsJsonArray("entries").get(0).getAsJsonObject().get("text").getAsString().equals("message 139"), "page result does not expose mutable event ownership");
		check(stream.page(138, 1, 1).getAsJsonArray("entries").get(0).getAsJsonObject().get("sequence").getAsInt() == 140, "event page offsets apply after sequence filtering");
		check(stream.page(140, 0, 32).getAsJsonArray("entries").isEmpty(), "latest sequence returns no old events");
	}

	private static void verifyStreamedPlacementFaces(FixturePlayer player) throws ReflectiveOperationException {
		FixtureLevel level = player.fixtureLevel;
		BlockPos support = new BlockPos(3, 65, 0);
		BlockPos hidden = support.east();
		level.world.states.clear();
		level.world.states.put(support, Blocks.STONE.defaultBlockState());
		face(player, support);
		Method emitter = ServerObservationCollector.class.getDeclaredMethod("blocks", ServerLevel.class, ServerPlayer.class,
				List.class, ObservationVisibility.Frame.class, LongArrayList.class);
		emitter.setAccessible(true);
		List<BlockObservationOrdering.Candidate> candidates = List.of(new BlockObservationOrdering.Candidate(3, 1, 0, "minecraft:stone"));
		JsonObject baseline = null;
		for (BlockState hiddenState : new BlockState[] {Blocks.AIR.defaultBlockState(), Blocks.STONE.defaultBlockState(), Blocks.LAVA.defaultBlockState()}) {
			SeenTerrain.forget(player);
			level.world.states.put(hidden, hiddenState);
			var visibility = ObservationVisibility.frame(level, player);
			check(visibility.canSeeBlock(support) && !visibility.seesCell(hidden), "counterfactual support is visible while its far destination is unseen");
			JsonArray rows = (JsonArray) emitter.invoke(null, level, player, candidates, visibility, new LongArrayList());
			check(rows.size() == 1, "actual streamed collector emits the visible support");
			JsonObject row = rows.get(0).getAsJsonObject();
			check(!hasFace(row, "east"), "unseen destination is never advertised as placeable");
			check(hasFace(row, "west"), "observed empty destination keeps its supported placement face");
			if (baseline == null) baseline = row.deepCopy();
			else equal(baseline, row, "unseen destination identity cannot change actual streamed block facts");
		}
		SeenTerrain.forget(player);
		level.world.states.clear();
		BlockPos far = new BlockPos(6, 65, 0);
		level.world.states.put(far, Blocks.STONE.defaultBlockState());
		set(player, Entity.class, "position", new Vec3(.6D, 64, .5D));
		set(player, Entity.class, "bb", new AABB(.3D, 64, .2D, .9D, 65.8D, .8D));
		player.xo = .6D;
		face(player, far);
		check(!player.isWithinBlockInteractionRange(far, 0D) && player.isWithinBlockInteractionRange(far, 1D),
				"range-control support lies outside vanilla reach but inside old padded metadata reach");
		JsonArray farRows = (JsonArray) emitter.invoke(null, level, player,
				List.of(new BlockObservationOrdering.Candidate(6, 1, 0, "minecraft:stone")),
				ObservationVisibility.frame(level, player), new LongArrayList());
		check(farRows.size() == 1, "out-of-reach support is nevertheless visible in actual streamed collector");
		check(farRows.get(0).getAsJsonObject().getAsJsonArray("placeableFaces").isEmpty(),
				"currently out-of-reach support advertises no placement faces");
		SeenTerrain.forget(player);
	}

	private static boolean hasFace(JsonObject row, String face) {
		return row.getAsJsonArray("placeableFaces").asList().stream().anyMatch(value -> value.getAsString().equals(face));
	}

	private static void verifyEffectProducer(FixturePlayer player) throws ReflectiveOperationException {
		MobEffectInstance finite = new MobEffectInstance(MobEffects.FIRE_RESISTANCE, 40, 2);
		MobEffectInstance infinite = new MobEffectInstance(MobEffects.HASTE, -1, 1);
		var effects = new HashMap<>(Map.of(MobEffects.FIRE_RESISTANCE, finite, MobEffects.HASTE, infinite));
		set(player, LivingEntity.class, "activeEffects", effects);
		Method producer = ServerObservationCollector.class.getDeclaredMethod("effects", ServerPlayer.class);
		producer.setAccessible(true);
		JsonArray produced = (JsonArray) producer.invoke(null, player);
		check(produced.size() == 2, "actual effect producer reads current native active effects");
		JsonObject finiteFact = effect(produced, "minecraft:fire_resistance");
		equal(40, finiteFact.get("duration").getAsInt(), "finite effect duration remains native ticks, without seconds conversion");
		equal(2, finiteFact.get("amplifier").getAsInt(), "native effect amplifier");
		check(infinite.isInfiniteDuration(), "native instance confirms negative-one infinite duration");
		equal(-1, effect(produced, "minecraft:haste").get("duration").getAsInt(), "producer preserves infinite duration sentinel");
		check(finite.getDuration() == 40 && infinite.getDuration() == -1, "effect inspection does not advance native durations");
		effects.clear();
		check(((JsonArray) producer.invoke(null, player)).isEmpty(), "current absence of native effects produces no effect facts");
	}

	private static JsonObject effect(JsonArray effects, String id) {
		return effects.asList().stream().map(value -> value.getAsJsonObject())
				.filter(value -> value.get("effectId").getAsString().equals(id)).findFirst().orElseThrow();
	}

	private static void verifyHazardMemoryProducer(FixturePlayer player) throws ReflectiveOperationException {
		FixtureLevel level = player.fixtureLevel;
		set(level, Level.class, "dimension", Level.OVERWORLD);
		set(player, Entity.class, "position", new Vec3(.5D, 64.5D, .5D));
		set(player, Entity.class, "bb", new AABB(.2D, 64.5D, .2D, .8D, 66.3D, .8D));
		player.xo = .5D; player.yo = 64.5D; player.zo = .5D;
		BlockPos boundary = new BlockPos(4, 64, 0);
		level.world.states.clear(); level.world.states.put(boundary, Blocks.LAVA.defaultBlockState());
		level.clock = 0;
		face(player, boundary);
		var visibility = ObservationVisibility.frame(level, player);
		check(visibility.seesCell(boundary), "four-metre boundary lava is actually visible to the player");
		HazardFacts producer = new HazardFacts();
		AgentId id = new AgentId(java.util.UUID.randomUUID());
		JsonObject current = new JsonObject();
		producer.rememberLava(id, player, visibility, lavaRows(boundary), current);
		check(!current.has("lavaSeen"), "currently sampled lava is not duplicated as remembered unseen lava");
		face(player, new BlockPos(-4, 64, 0));
		level.clock = 20;
		JsonObject oneSecond = remember(producer, id, player);
		equal("(4,64,0) 1s ago", oneSecond.getAsJsonArray("lavaSeen").get(0).getAsString(), "exact four-metre lava remains remembered with tick-to-second age");
		level.clock = 600;
		check(remember(producer, id, player).getAsJsonArray("lavaSeen").size() == 1, "lava memory retains the exact thirty-second boundary");
		level.clock = 601;
		check(!remember(producer, id, player).has("lavaSeen"), "lava memory expires beyond thirty seconds");
		producer = new HazardFacts();
		level.clock = 0;
		set(player, Entity.class, "position", new Vec3(.499D, 64.5D, .5D));
		player.xo = .499D;
		face(player, boundary);
		producer.rememberLava(id, player, ObservationVisibility.frame(level, player), lavaRows(boundary), new JsonObject());
		face(player, new BlockPos(-4, 64, 0));
		check(!remember(producer, id, player).has("lavaSeen"), "lava just outside four metres is not acquired into hazard memory");
		set(player, Entity.class, "position", new Vec3(.5D, 64.5D, .5D)); player.xo = .5D;
		producer = new HazardFacts();
		List<BlockPos> targets = new java.util.ArrayList<>();
		for (int x = -3; x <= 3 && targets.size() < 19; x++) for (int z = -3; z <= 3 && targets.size() < 19; z++) {
			if (x * x + z * z <= 16 && (x != 0 || z != 0)) targets.add(new BlockPos(x, 64, z));
		}
		for (int index = 0; index < targets.size(); index++) {
			BlockPos target = targets.get(index);
			level.world.states.clear(); level.world.states.put(target, Blocks.LAVA.defaultBlockState());
			level.clock = index;
			face(player, target);
			visibility = ObservationVisibility.frame(level, player);
			check(visibility.seesCell(target), "retention input is a real visible lava cell " + target);
			producer.rememberLava(id, player, visibility, lavaRows(target), new JsonObject());
		}
		Field memoriesField = HazardFacts.class.getDeclaredField("memories"); memoriesField.setAccessible(true);
		Object memory = ((Map<?, ?>) memoriesField.get(producer)).get(id);
		Field cellsField = memory.getClass().getDeclaredField("lavaSeenAt"); cellsField.setAccessible(true);
		Map<?, ?> cells = (Map<?, ?>) cellsField.get(memory);
		check(cells.size() == 16, "actual lava acquisition caps retained history at sixteen cells");
		check(!cells.containsKey(targets.get(0).asLong()) && cells.containsKey(targets.get(18).asLong()), "actual lava retention evicts oldest sightings and preserves newest");
		BlockPos last = targets.get(18);
		face(player, new BlockPos(-last.getX(), 64, -last.getZ()));
		check(!ObservationVisibility.frame(level, player).seesCell(last), "last sampled lava is actually out of view before memory reporting");
		level.clock = 20;
		JsonObject page = remember(producer, id, player);
		check(page.getAsJsonArray("lavaSeen").size() == 3, "actual lava producer reports at most three remembered nearby cells");
		List<BlockPos> expected = targets.subList(3, 19).stream().sorted(java.util.Comparator
				.comparingDouble(at -> (double) at.getX() * at.getX() + at.getZ() * at.getZ())).toList();
		String nearest = page.getAsJsonArray("lavaSeen").get(0).getAsString();
		BlockPos first = expected.get(0);
		check(nearest.startsWith("(" + first.getX() + ",64," + first.getZ() + ")"), "actual remembered lava output orders nearer cells first");
		set(level, Level.class, "dimension", Level.NETHER);
		check(!remember(producer, id, player).has("lavaSeen"), "dimension changes reset actual lava memory");
		set(level, Level.class, "dimension", Level.OVERWORLD);
		level.world.states.clear(); level.world.states.put(boundary, Blocks.LAVA.defaultBlockState());
		face(player, boundary);
		producer.rememberLava(id, player, ObservationVisibility.frame(level, player), lavaRows(boundary), new JsonObject());
		set(player, Entity.class, "id", 4001);
		check(!remember(producer, id, player).has("lavaSeen"), "new body identity resets actual lava memory");
	}

	private static LongArrayList lavaRows(BlockPos at) { return new LongArrayList(new long[] {at.asLong()}); }
	private static JsonObject remember(HazardFacts producer, AgentId id, FixturePlayer player) {
		JsonObject result = new JsonObject();
		producer.rememberLava(id, player, ObservationVisibility.frame(player.fixtureLevel, player), new LongArrayList(), result);
		return result;
	}

	private static void verifyLastDamageProducer(FixturePlayer player) throws ReflectiveOperationException {
		FixtureLevel level = player.fixtureLevel;
		level.world.states.clear();
		level.clock = 100;
		DamageSource lava = new DamageSource(Holder.direct(new DamageType("lava", .1F)));
		set(player, LivingEntity.class, "lastDamageSource", lava);
		set(player, LivingEntity.class, "lastDamageStamp", 100L);
		var producer = new HazardFacts();
		AgentId id = new AgentId(java.util.UUID.randomUUID());
		JsonObject facts = new JsonObject();
		producer.addPlayerFacts(id, player, ObservationVisibility.frame(level, player), facts);
		equal("lava", facts.get("hurtBy").getAsString(), "hazard producer reads actual native last damage source");
		set(player, LivingEntity.class, "lastDamageSource", new DamageSource(Holder.direct(new DamageType("on_fire", .1F))));
		JsonObject changed = new JsonObject();
		producer.addPlayerFacts(id, player, ObservationVisibility.frame(level, player), changed);
		equal("on_fire", changed.get("hurtBy").getAsString(), "hazard producer reflects new native last damage cause");
		level.clock = 140;
		JsonObject boundary = new JsonObject();
		producer.addPlayerFacts(id, player, ObservationVisibility.frame(level, player), boundary);
		check(boundary.has("hurtBy"), "native last-damage retention includes forty ticks");
		level.clock = 141;
		JsonObject expired = new JsonObject();
		producer.addPlayerFacts(id, player, ObservationVisibility.frame(level, player), expired);
		check(!expired.has("hurtBy"), "expired native last damage is omitted rather than fabricated");
	}

	private static JsonObject coordinates(BlockPos at) {
		JsonObject query = new JsonObject();
		query.addProperty("x", at.getX()); query.addProperty("y", at.getY()); query.addProperty("z", at.getZ());
		return query;
	}
	private static void face(FixturePlayer player, BlockPos at) throws ReflectiveOperationException {
		Vec3 delta = Vec3.atCenterOf(at).subtract(player.getEyePosition());
		float yaw = (float) Math.toDegrees(Math.atan2(-delta.x, delta.z));
		float pitch = (float) Math.toDegrees(Math.atan2(-delta.y, Math.hypot(delta.x, delta.z)));
		set(player, Entity.class, "yRot", yaw);
		set(player, Entity.class, "xRot", pitch);
		player.yRotO = yaw; player.xRotO = pitch;
		player.yHeadRot = yaw; player.yHeadRotO = yaw;
	}
	private static JsonObject section(Object collector, Method inspect, FixturePlayer player, JsonObject query, String section) throws ReflectiveOperationException {
		return (JsonObject) inspect.invoke(collector, player, query, section, 0, 16);
	}
	private static void refusal(Object collector, Method inspect, FixturePlayer player, JsonObject query, String section, String code) throws ReflectiveOperationException {
		try { section(collector, inspect, player, query, section); throw new AssertionError("expected inspection refusal " + code); }
		catch (InvocationTargetException failure) {
			check(failure.getCause() instanceof AgentDomainException domain && code.equals(domain.code()), "inspection rejects with " + code + ": " + failure.getCause());
		}
	}
	private static void set(Object target, Class<?> owner, String name, Object value) throws ReflectiveOperationException {
		Field field = owner.getDeclaredField(name); field.setAccessible(true); field.set(target, value);
	}
	private static void equal(Object expected, Object actual, String label) { check(Objects.equals(expected, actual), label + ": expected " + expected + ", got " + actual); }
	private static void check(boolean condition, String label) { assertions++; if (!condition) throw new AssertionError(label); }

	private static final class FixturePlayer extends ServerPlayer {
		FixtureLevel fixtureLevel;
		Inventory inventory;
		Abilities abilities;
		Map<Holder<Attribute>, AttributeInstance> attributes;
		FixturePlayer() { super(null, null, null, null); }
		@Override public ServerLevel level() { return fixtureLevel; }
		@Override public Inventory getInventory() { return inventory; }
		@Override public Abilities getAbilities() { return abilities; }
		@Override public AttributeInstance getAttribute(Holder<Attribute> type) { return attributes.get(type); }
		@Override public RegistryAccess registryAccess() { return RegistryAccess.EMPTY; }
		@Override public ItemStack getMainHandItem() { return ItemStack.EMPTY; }
		@Override public boolean isDescending() { return false; }
		@Override public boolean isInLava() { return false; }
		@Override public boolean isOnFire() { return false; }
		@Override public double blockInteractionRange() { return 4.5D; }
		@Override public double entityInteractionRange() { return 3D; }
	}
	private static final class FixtureLevel extends ServerLevel {
		// 26.3 entities take their ID from the level, and ServerLevel asks its (absent) chunk source.
		private int fixtureEntityIds = 100_000;
		@Override public int getNextEntityId() { return ++fixtureEntityIds; }
		SparseWorld world;
		MinecraftServer server;
		boolean loaded;
		int clips, blockEntityReads;
		long clock;
		FixtureLevel() { super(null, null, null, null, null, null, false, 0L, List.of(), false); }
		@Override public <T extends Entity> List<T> getEntitiesOfClass(Class<T> type, AABB area, java.util.function.Predicate<? super T> predicate) { return List.of(); }
		@Override public MinecraftServer getServer() { return server; }
		@Override public long getGameTime() { return clock; }
		@Override public boolean hasChunk(int x, int z) { return loaded; }
		@Override public boolean hasChunkAt(BlockPos at) { return loaded; }
		@Override public BlockState getBlockState(BlockPos at) { return world.getBlockState(at); }
		@Override public FluidState getFluidState(BlockPos at) { return world.getFluidState(at); }
		@Override public BlockEntity getBlockEntity(BlockPos at) { blockEntityReads++; return null; }
		@Override public BlockHitResult clip(ClipContext context) { clips++; return world.clip(context); }
		@Override public int getMinY() { return -64; }
		@Override public int getHeight() { return 384; }
	}
	private static final class SparseWorld implements BlockGetter {
		final Map<BlockPos, BlockState> states = new HashMap<>();
		int blockEntityReads;
		@Override public BlockEntity getBlockEntity(BlockPos at) { blockEntityReads++; return null; }
		@Override public BlockState getBlockState(BlockPos at) { return states.getOrDefault(at, Blocks.AIR.defaultBlockState()); }
		@Override public FluidState getFluidState(BlockPos at) { return getBlockState(at).getFluidState(); }
		@Override public int getMinY() { return -64; }
		@Override public int getHeight() { return 384; }
	}

	private static final class AirComponents implements AutoCloseable {
		private final Holder.Reference<Item> holder = Items.AIR.builtInRegistryHolder();
		private final DataComponentMap original;
		private AirComponents() {
			original = holder.areComponentsBound() ? holder.components() : null;
			var components = DataComponentMap.builder();
			if (original != null) components.addAll(original);
			components.set(DataComponents.MAX_STACK_SIZE, 64);
			components.set(DataComponents.ITEM_NAME, Component.literal("Air"));
			holder.bindComponents(components.build());
		}
		@Override public void close() {
			try {
				Field components = Holder.Reference.class.getDeclaredField("components");
				components.setAccessible(true);
				components.set(holder, original);
			} catch (ReflectiveOperationException failure) {
				throw new AssertionError("could not restore temporary air item components", failure);
			}
		}
	}
}
