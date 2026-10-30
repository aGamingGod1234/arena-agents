package dev.agaminggod.arenaagents.server.runtime;

import com.google.gson.JsonObject;
import dev.agaminggod.arenaagents.agent.AgentDomainException;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputState;
import dev.agaminggod.arenaagents.server.runtime.input.ControlSequence;
import dev.agaminggod.arenaagents.server.runtime.transaction.UseConfirmation;
import java.util.List;
import java.util.Objects;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.Shapes;

/** Contract checks execute the same geometry, input and evidence rules used by live actions. */
public final class ToolContractTruthVerification {
	private static int assertions;
	private static final AgentInputState INPUT = new AgentInputState(1.0F, 1.0F, true, true, true, true, true,
			180.0F, -30.0F, 8, InteractionHand.OFF_HAND);

	private ToolContractTruthVerification() { }

	public static void main(String[] args) {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		System.out.println("PASS: " + verify() + " tool contract assertions");
	}

	public static int verify() {
		assertions = 0;
		verifyPlacementDestination();
		verifyInteractionFaces();
		verifyControlAimGate();
		verifyEveryControlCondition();
		verifyFoodAndUseEvidence();
		return assertions;
	}

	private static void verifyPlacementDestination() {
		for (BlockPos destination : List.of(BlockPos.ZERO, new BlockPos(-23, -60, 41),
				new BlockPos(29_999_990, 319, -29_999_990))) {
			for (Direction face : Direction.values()) {
				BlockPos support = ServerActionExecutor.placementSupport(destination, face);
				check(support.relative(face).equals(destination), "clicked " + face + " support places at the exact destination");
				check(!support.equals(destination), "support is not the destination for " + face);
				Vec3 hit = ServerActionExecutor.placementLookTarget(support, face);
				check(ServerActionExecutor.isValidPlacementHit(support, hit), "placement aim is on its own support for " + face);
				Vec3 offset = hit.subtract(Vec3.atCenterOf(support));
				check(Math.abs(offset.dot(new Vec3(face.getStepX(), face.getStepY(), face.getStepZ())) - 0.499D) < 1.0E-7D,
						"placement aim is the requested face for " + face);
				check(BlockPlacementAttemptPolicy.chooseFace(face, candidate -> candidate == face) == face,
						"the requested supported face is retained");
				check(BlockPlacementAttemptPolicy.chooseFace(face, candidate -> candidate != face) == null,
						"other supports never substitute a model-chosen face");
			}
		}
		check(ServerActionExecutor.placementSupport(new BlockPos(0, 65, 0), Direction.UP).equals(new BlockPos(0, 64, 0)),
				"up clicks y-1 and fills y");
	}

	private static void verifyInteractionFaces() {
		BlockPos position = new BlockPos(-3, 64, 12);
		JsonObject derived = new JsonObject();
		for (var shape : List.of(Shapes.block(), Shapes.box(0.0625D, 0, 0.0625D, 0.9375D, 0.875D, 0.9375D),
				Shapes.box(0, 0, 0, 1, 0.5D, 1))) {
			var bounds = shape.bounds();
			for (Direction face : Direction.values()) {
				Vec3 hit = ServerActionExecutor.blockInteractionHitLocation(position, face, derived, shape)
						.subtract(Vec3.atLowerCornerOf(position));
				check(hit.x >= bounds.minX && hit.x <= bounds.maxX && hit.y >= bounds.minY && hit.y <= bounds.maxY
						&& hit.z >= bounds.minZ && hit.z <= bounds.maxZ, "derived hit belongs to actual outline");
				double axis = switch (face.getAxis()) { case X -> hit.x; case Y -> hit.y; case Z -> hit.z; };
				double expected = face.getAxisDirection() == Direction.AxisDirection.POSITIVE
						? switch (face.getAxis()) { case X -> bounds.maxX; case Y -> bounds.maxY; case Z -> bounds.maxZ; }
						: switch (face.getAxis()) { case X -> bounds.minX; case Y -> bounds.minY; case Z -> bounds.minZ; };
				check(axis == expected, "derived hit is the requested shape face " + face);
			}
		}
		JsonObject explicit = new JsonObject();
		explicit.addProperty("hitX", 0.125D);
		explicit.addProperty("hitY", 0.25D);
		explicit.addProperty("hitZ", 0.75D);
		check(ServerActionExecutor.blockInteractionHitLocation(position, Direction.UP, explicit, Shapes.block())
				.equals(new Vec3(-2.875D, 64.25D, 12.75D)), "explicit hit coordinates are block-relative");
		try {
			ServerActionExecutor.blockInteractionHitLocation(position, Direction.UP, derived, Shapes.empty());
			throw new AssertionError("empty shape accepted");
		} catch (AgentDomainException expected) {
			check("TARGET_OBSTRUCTED".equals(expected.code()), "missing interaction outline fails honestly");
		}
		for (var hand : List.of("main", "off")) {
			JsonObject arguments = new JsonObject();
			arguments.addProperty("hand", hand);
			check(ServerActionExecutor.hand(arguments) == (hand.equals("main") ? InteractionHand.MAIN_HAND : InteractionHand.OFF_HAND),
					"explicit hand is preserved");
		}
	}

	private static void verifyControlAimGate() {
		for (float startYaw : new float[] {-179, -90, 0, 90, 179}) {
			float yaw = startYaw;
			float pitch = 60;
			int turning = 0;
			boolean arrived = false;
			while (!arrived && turning < 20) {
				var tick = ServerActionExecutor.controlTick(yaw, pitch, INPUT, false, turning);
				var state = tick.input();
				arrived = tick.counts();
				if (!arrived) {
					check(state.forward() == 0 && state.strafe() == 0 && !state.jump() && !state.sprint()
							&& !state.attack() && !state.use(), "movement and clicks wait for the authored aim");
					check(state.sneak() && state.selectedSlot() == INPUT.selectedSlot() && state.hand() == INPUT.hand(),
							"turning retains sneak, selected slot and hand");
					turning++;
				} else check(state.equals(INPUT), "arrival applies the full authored frame");
				yaw = state.yaw();
				pitch = state.pitch();
			}
			check(arrived, "the player-speed turn settles");
		}
		var instant = ServerActionExecutor.controlTick(0, 60, INPUT, true, 0);
		check(instant.counts() && instant.input().equals(INPUT), "instantLook applies the exact view and keys immediately");
	}

	private static void verifyEveryControlCondition() {
		for (String condition : List.of("health_below", "food_below", "air_below")) {
			for (int observed : new int[] {9, 10, 11}) {
				var facts = facts(observed, false);
				check(branchStops(condition, 10, facts) == (observed < 10), condition + " is strict below, not below-or-equal");
			}
		}
		for (String condition : List.of("on_fire", "in_water", "on_ground", "horizontal_collision", "hurt", "using_item")) {
			for (boolean observed : new boolean[] {false, true}) {
				for (boolean requested : new boolean[] {false, true}) {
					check(branchStops(condition, requested ? 1 : 0, facts(20, observed)) == (observed == requested),
							condition + " respects both boolean values");
				}
			}
		}
		// Uniform facts cannot tell one field from another, so vary only the tested field and set the rest the other way.
		List<String> numeric = List.of("health_below", "food_below", "air_below");
		for (int tested = 0; tested < numeric.size(); tested++) {
			for (int observed : new int[] {9, 10, 11}) {
				int[] values = {20, 20, 20};
				values[tested] = observed;
				check(branchStops(numeric.get(tested), 10, numericFacts(values)) == (observed < 10),
						numeric.get(tested) + " reads its own field");
			}
			for (int other = 0; other < numeric.size(); other++) {
				if (other == tested) continue;
				int[] values = {20, 20, 20};
				values[other] = 5;
				check(!branchStops(numeric.get(tested), 10, numericFacts(values)),
						numeric.get(tested) + " ignores a low " + numeric.get(other).replace("_below", ""));
			}
		}
		List<String> flags = List.of("on_fire", "in_water", "on_ground", "horizontal_collision", "hurt", "using_item");
		for (int tested = 0; tested < flags.size(); tested++) {
			for (boolean observed : new boolean[] {false, true}) {
				boolean[] values = new boolean[flags.size()];
				java.util.Arrays.fill(values, !observed);
				values[tested] = observed;
				for (boolean requested : new boolean[] {false, true}) {
					check(branchStops(flags.get(tested), requested ? 1 : 0, flagFacts(values)) == (observed == requested),
							flags.get(tested) + " reads its own field");
				}
			}
		}
		var frame = new ControlSequence.Frame(INPUT, 5, List.of(
				new ControlSequence.Branch("health_below", 10, 1), new ControlSequence.Branch("on_fire", 1, 2)));
		var firstWins = new ControlSequence(List.of(frame, new ControlSequence.Frame(INPUT, 2, List.of())), 20);
		check(firstWins.next(facts(5, true)).frameIndex() == 1, "the first matching branch wins");
		var timed = new ControlSequence(List.of(new ControlSequence.Frame(INPUT, 200, List.of())), 2000);
		for (int tick = 0; tick < 200; tick++) check(timed.next(facts(20, false)).input().equals(INPUT), "all 200 authored ticks execute");
		check(timed.next(facts(20, false)).status() == ControlSequence.Status.COMPLETED, "the frame ends after its exact tick count");
		check(timed.next(facts(20, false)).input() == null, "a terminal frame emits no more keys");
	}

	private static boolean branchStops(String condition, double value, ControlSequence.Facts facts) {
		var sequence = new ControlSequence(List.of(new ControlSequence.Frame(INPUT, 3,
				List.of(new ControlSequence.Branch(condition, value, 1)))), 3);
		return sequence.next(facts).status() == ControlSequence.Status.BRANCH_STOPPED;
	}

	private static ControlSequence.Facts numericFacts(int[] values) {
		return new ControlSequence.Facts(values[0], values[1], values[2], false, false, false, false, false, false);
	}

	private static ControlSequence.Facts flagFacts(boolean[] values) {
		return new ControlSequence.Facts(20, 20, 300, values[0], values[1], values[2], values[3], values[4], values[5]);
	}

	private static ControlSequence.Facts facts(int number, boolean flag) {
		return new ControlSequence.Facts(number, number, number, flag, flag, flag, flag, flag, flag);
	}

	private static void verifyFoodAndUseEvidence() {
		String refused = ServerActionExecutor.fullHungerRefusal("minecraft:apple", false, 20);
		check(refused.contains("Nothing consumed") && refused.contains("20/20"), "full food gives an explicit no-consumption diagnostic");
		check(ServerActionExecutor.fullHungerRefusal("minecraft:golden_apple", true, 20) == null, "always-edible food remains usable at full food");
		check(ServerActionExecutor.fullHungerRefusal("minecraft:apple", true, 19) == null, "hungry ordinary food remains usable");
		check(ServerActionExecutor.useFeedback("input", refused, false).contains("Nothing consumed"), "input is not consumption evidence");
		check(Objects.equals("input", ServerActionExecutor.useFeedback("input", refused, true)), "observed use prevents false refusal");
		check(!UseConfirmation.initial().observeUsing(false).confirmed(), "release without start cannot confirm use");
		check(!UseConfirmation.initial().observeUsing(true).confirmed(), "start without release cannot confirm use");
		check(UseConfirmation.initial().observeUsing(true).observeUsing(false).confirmed(), "observed start then release confirms held use");
	}

	private static void check(boolean condition, String label) {
		if (!condition) throw new AssertionError(label);
		assertions++;
	}
}
