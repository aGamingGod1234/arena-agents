package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.server.perception.SeenTerrain;
import dev.agaminggod.arenaagents.agent.AgentDomainException;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputState;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputStates;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

/** A model-selected enclosure, built with visible vanilla clicks. Never selects a fight or a site. */
public final class ServerShelterController implements ServerController {
	public interface Environment {
		Vec3 aim(ServerPlayer body, BlockPos at, Direction face);
		String place(ServerPlayer body, BlockPos at, Direction face);
		ServerController clear(ServerPlayer body, BlockPos at, boolean sneak, long timeoutMs);
	}

	public record Cell(BlockPos at, Direction face, boolean jump) { }

	/** Four boundary faces enclose a one-cell interior; outer diagonal cells do not add a boundary. */
	public static List<Cell> plan(BlockPos center, Direction opening, boolean roof) {
		return plan(center, opening, roof, true);
	}

	/** Without the sill the opening is a two-high doorway (fight_until roof:true adds a lintel over it from outside). */
	public static List<Cell> plan(BlockPos center, Direction opening, boolean roof, boolean sill) {
		if (opening == null || opening.getAxis() == Direction.Axis.Y) throw new IllegalArgumentException("Opening must be horizontal");
		List<Cell> cells = new ArrayList<>();
		for (Direction side : new Direction[] {opening.getOpposite(), opening.getCounterClockWise(), opening.getClockWise()})
			for (int y=0;y<2;y++) cells.add(new Cell(center.relative(side).above(y), Direction.UP, false));
		if (sill) cells.add(new Cell(center.relative(opening), Direction.UP, false));
		if (roof) {
			cells.add(new Cell(center.relative(opening.getOpposite()).above(2), Direction.UP, true));
			cells.add(new Cell(center.above(2), opening, false));
		}
		return List.copyOf(cells);
	}

	/** What the body has seen at a cell: a full block, replaceable space, something else, or nothing yet. */
	public enum Seen { SOLID, OPEN, OTHER, UNKNOWN }

	/**
	 * Support for a ground-level wall or sill cell whose seen support below is open, as a player pillars up from a
	 * lower floor: one or two blocks below it (max 2), lowest first, or one placement against a seen solid side face.
	 * Empty when the cell is supported, unseen, or no seen support exists (the placement then refuses as before).
	 */
	public static List<Cell> support(BlockPos center, BlockPos at, java.util.function.Function<BlockPos, Seen> seen) {
		BlockPos below = at.below();
		if (seen.apply(below) != Seen.OPEN) return List.of();
		Seen two = seen.apply(below.below());
		if (two == Seen.SOLID) return List.of(new Cell(below, Direction.UP, false));
		if (two == Seen.OPEN && seen.apply(below.below(2)) == Seen.SOLID)
			return List.of(new Cell(below.below(), Direction.UP, false), new Cell(below, Direction.UP, false));
		for (Direction side : Direction.Plane.HORIZONTAL) {
			BlockPos next = at.relative(side);
			if (!next.equals(center) && seen.apply(next) == Seen.SOLID) return List.of(new Cell(at, side.getOpposite(), false));
		}
		return List.of();
	}

	private final BlockPos center;
	private final Direction opening;
	private final List<Cell> cells;
	private final long deadline;
	private final Environment environment;
	private final CombatInputLease input = new CombatInputLease();
	private ServerNavigationController approach;
	private boolean building, checkedCeiling, crouched;
	private int index, placed, cleared, supports, cellTicks, clearAimTicks;
	private final java.util.Set<BlockPos> supportChecked = new java.util.HashSet<>();
	private BlockPos clearingAt;
	private ServerController clearing;
	private String refusal = "Support not yet visible";

	public ServerShelterController(BlockPos center, Direction opening, boolean roof, long timeoutMs, long now, Environment environment) {
		this(center, opening, roof, true, timeoutMs, now, environment);
	}

	public ServerShelterController(BlockPos center, Direction opening, boolean roof, boolean sill, long timeoutMs, long now, Environment environment) {
		this.center = center;
		this.opening = opening;
		this.cells = new ArrayList<>(plan(center, opening, roof, sill));
		this.deadline = now + timeoutMs;
		this.environment = environment;
	}

	/** Held through the approach, jump placements and the obstruction-clearing child. */
	public ServerShelterController crouched(boolean crouched) {
		this.crouched = crouched;
		return this;
	}

	@Override
	public TickResult tick(ServerPlayer player, long now) {
		if (now >= deadline) return finish(player, "SHELTER_TIMEOUT", "Time limit reached", true);
		if (!player.isAlive()) return finish(player, "AGENT_DEAD", "Body died while building", false);
		if (!HazardExits.fireResistant(player) && HazardExits.contact(player) == HazardExits.Contact.LAVA)
			return finish(player, "IN_LAVA", "Construction cannot continue in damaging lava", false);
		BlockPos flame = touchingFire(player);
		if (flame != null && !flame.equals(clearingAt)) {
			if (approach != null) { approach.cancel(player); approach = null; }
			if (clearing != null) clearing.cancel(player);
			clearing = null; clearingAt = flame; clearAimTicks = 0;
		}
		if (clearingAt != null) return clearTick(player, now);
		// Navigation gets to the cell; ordinary crouched input centres the body inside its narrow walls.
		BlockState floor = SeenTerrain.of(player).known(center.getX(), center.getY()-1, center.getZ());
		if (player.blockPosition().equals(center) && player.onGround() && Math.abs(player.getY()-center.getY())<0.2D
				&& floor != null && floor.isCollisionShapeFullBlock(player.level(), center.below())
				&& (Math.abs(player.getX()-center.getX()-0.5D)>0.12D || Math.abs(player.getZ()-center.getZ()-0.5D)>0.12D)) {
			if (approach != null) { approach.cancel(player); approach = null; }
			float[] keys = BrinkGuard.keysToward(player.getYRot(), center.getX()+0.5D-player.getX(), center.getZ()+0.5D-player.getZ());
			input.apply(player, new AgentInputState(keys[0],keys[1],false,true,false,false,false,
					player.getYRot(),player.getXRot(),player.getInventory().getSelectedSlot(),InteractionHand.MAIN_HAND));
			return TickResult.running(progress());
		}
		if (!building) {
			Vec3 target = Vec3.atBottomCenterOf(center);
			if (player.position().distanceToSqr(target) > 0.04D) {
				// Centering outranks navigation; give up its keys while navigation owns the approach.
				input.release();
				if (approach == null) approach = new ServerNavigationController(target, 0.35D, false, now, Math.max(1, deadline - now), false).crouched(crouched);
				TickResult result = approach.tick(player, now);
				if (result.state() == State.RUNNING) return result;
				approach.cancel(player);
				approach = null;
				if (result.state() != State.SUCCEEDED) return finish(player, result.reasonCode(), result.message(), false);
				return TickResult.running(progress());
			}
			building = true;
		}
		if (Math.abs(player.getX() - center.getX() - 0.5D) > 0.65D || Math.abs(player.getZ() - center.getZ() - 0.5D) > 0.65D
				|| player.getY() < center.getY() - 0.2D) {
			if (player.position().distanceToSqr(Vec3.atBottomCenterOf(center)) > 16.0D)
				return finish(player, "SHELTER_DISPLACED", "Body was pushed beyond the local construction site; partial walls remain", false);
			// A shove before the walls close is still a construction task: return over acquired safe terrain.
			input.release(); building = false; cellTicks = 0;
			return TickResult.running(progress());
		}
		if (index == cells.size()) {
			BlockPos window = center.relative(opening).above();
			BlockState state = SeenTerrain.of(player).known(window.getX(), window.getY(), window.getZ());
			if (state == null) {
				input.release(); ServerLookController.turnToward(player, Vec3.atCenterOf(window));
				return TickResult.running(progress());
			}
			if (!state.getFluidState().isEmpty()) return finish(player, "SHELTER_BLOCKED", "Window " + describe(player, window, state) + " contains fluid", false);
			if (!state.isAir()) { clearingAt = window; clearAimTicks = 0; return clearTick(player, now); }
			input.release();
			if (!ServerLookController.turnToward(player, Vec3.atCenterOf(window))) return TickResult.running(progress());
			return TickResult.succeeded("SHELTER_BUILT", facts() + "; stay inside, fight through the " + opening.getSerializedName() + " eye-height window above the sill with pursue:false");
		}
		Cell cell = cells.get(index);
		if (cell.jump() && !checkedCeiling) {
			// The cap is scaffolding for a NEW ceiling, not a repair requirement. Once the ceiling exists,
			// it hides this cap and prevents jumping; inspect the visible underside instead of rebuilding it.
			BlockPos roof = center.above(2);
			input.release();
			if (!ServerLookController.turnToward(player, Vec3.atCenterOf(roof))) return TickResult.running(progress());
			BlockState ceiling = SeenTerrain.of(player).known(roof.getX(), roof.getY(), roof.getZ());
			checkedCeiling = true;
			if (ceiling != null && ceiling.isCollisionShapeFullBlock(player.level(), roof)) {
				index++; cellTicks = 0;
				return TickResult.running(progress());
			}
		}
		SeenTerrain.Reader<BlockState> seen = SeenTerrain.of(player);
		BlockPos at = cell.at();
		// Only inspect blocks in the body's acquired terrain, never hidden level contents.
		BlockState known = seen.known(at.getX(), at.getY(), at.getZ());
		if (known != null && known.isCollisionShapeFullBlock(player.level(), at)) {
			index++; cellTicks = 0;
			return TickResult.running(progress());
		}
		if (known != null && !known.canBeReplaced()) {
			clearingAt = at; clearAimTicks = 0;
			return clearTick(player, now);
		}
		// Re-checked each tick until seen support is found; each ground cell gets at most one insertion.
		if (cell.face() == Direction.UP && !cell.jump() && at.getY() == center.getY() && !supportChecked.contains(at)) {
			List<Cell> extra = support(center, at, p -> {
				BlockState state = seen.known(p.getX(), p.getY(), p.getZ());
				return state == null ? Seen.UNKNOWN : state.isCollisionShapeFullBlock(player.level(), p) ? Seen.SOLID
						: state.canBeReplaced() ? Seen.OPEN : Seen.OTHER;
			});
			if (!extra.isEmpty()) {
				supportChecked.add(at);
				if (extra.getLast().at().equals(at)) cells.set(index, extra.getLast());
				else { cells.addAll(index, extra); supports += extra.size(); }
				cellTicks = 0;
				return TickResult.running(progress());
			}
		}
		if (++cellTicks > 80) return finish(player, crouched ? "SNEAK_SHELTER_BLOCKED" : "SHELTER_BLOCKED",
				"Could not repair " + describe(player, at, known) + (crouched ? " while holding sneak:true; construction handed back crouched: " : ": ") + refusal, false);
		Vec3 aim = Vec3.atCenterOf(at.relative(cell.face().getOpposite())).add(cell.face().getStepX() * 0.499D, cell.face().getStepY() * 0.499D, cell.face().getStepZ() * 0.499D);
		try { aim = environment.aim(player, at, cell.face()); }
		catch (AgentDomainException blocked) { refusal = blocked.code() + ": " + blocked.getMessage(); }
		boolean jump = cell.jump() && cellTicks % 20 < 10;
		AgentInputState look = AgentInputStates.lookingAt(player, aim, 0, 0, jump, crouched, false, false, false, InteractionHand.MAIN_HAND);
		float yaw = AgentInputStates.turnYaw(player.getYRot(), look.yaw());
		float pitch = AgentInputStates.turnPitch(player.getXRot(), look.pitch());
		input.apply(player, new AgentInputState(0, 0, jump, crouched, false, false, false, yaw, pitch,
				player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
		if (Math.abs(AgentInputStates.shortestAngleDelta(yaw, look.yaw())) > 1 || Math.abs(pitch - look.pitch()) > 1)
			return TickResult.running(progress());
		if (!cell.jump() && !player.onGround()) return TickResult.running(progress());
		try {
			String why = environment.place(player, at, cell.face());
			if (why == null) { placed++; index++; cellTicks = 0; }
			else refusal = why;
		} catch (AgentDomainException blocked) {
			refusal = blocked.code() + ": " + blocked.getMessage();
			if (List.of("ITEM_NOT_FOUND", "PROTECTION_DENIED", "TARGET_OCCUPIED").contains(blocked.code()))
				return finish(player, blocked.code(), "Could not repair " + describe(player, at, known) + ": " + refusal, false);
		}
		return TickResult.running(progress());
	}

	private BlockPos touchingFire(ServerPlayer player) {
		var box = player.getBoundingBox(); var seen = SeenTerrain.of(player);
		for (int x=(int)Math.floor(box.minX+1e-5);x<=(int)Math.floor(box.maxX-1e-5);x++)
			for (int y=(int)Math.floor(box.minY+1e-5);y<=(int)Math.floor(box.maxY-1e-5);y++)
				for (int z=(int)Math.floor(box.minZ+1e-5);z<=(int)Math.floor(box.maxZ-1e-5);z++)
					if (TravelBuilder.fire(seen.known(x,y,z))) return new BlockPos(x,y,z);
		return null;
	}

	private TickResult clearTick(ServerPlayer player, long now) {
		input.release();
		BlockState current = SeenTerrain.of(player).known(clearingAt.getX(), clearingAt.getY(), clearingAt.getZ());
		if (!TravelBuilder.fire(current) && (Math.abs(player.getX()-center.getX()-0.5D)>0.65D || Math.abs(player.getZ()-center.getZ()-0.5D)>0.65D)) {
			if (clearing != null) clearing.cancel(player);
			clearing = null; clearingAt = null; building = false;
			return TickResult.running(progress());
		}
		if (clearing == null) {
			BlockState state = SeenTerrain.of(player).known(clearingAt.getX(), clearingAt.getY(), clearingAt.getZ());
			if (state != null && state.isAir()) { clearingAt = null; return TickResult.running(progress()); }
			if (state != null && state.hasBlockEntity()) return finish(player, "SHELTER_BLOCKED", "Not clearing block entity " + describe(player, clearingAt, state), false);
			Vec3 aim = dev.agaminggod.arenaagents.server.runtime.TargetSightline.block(player.level(),
					net.minecraft.world.phys.shapes.CollisionContext.of(player), player.getEyePosition(), clearingAt, player.blockInteractionRange(), null);
			if (++clearAimTicks > 80) return finish(player, crouched ? "SNEAK_SHELTER_BLOCKED" : "SHELTER_BLOCKED",
					"Cannot reach obstruction " + describe(player, clearingAt, state) + (crouched ? " while holding sneak:true; construction handed back crouched: " : ": ") + refusal, false);
			if (!ServerLookController.turnToward(player, aim == null ? Vec3.atCenterOf(clearingAt) : aim)) return TickResult.running(progress());
			if (state != null) {
				int slot = ServerDigController.toolSlot(player, state);
				if (slot == -2 || slot == -3) return finish(player, slot == -2 ? "NO_TOOL" : "TOOL_WORN", "Clearing " + clearingAt.toShortString() + " needs a usable hotbar tool", false);
				if (slot >= 0) player.getInventory().setSelectedSlot(slot);
			}
			try { clearing = environment.clear(player, clearingAt, crouched, Math.min(60_000L, Math.max(1L, deadline-now))); }
			catch (AgentDomainException blocked) {
				refusal = blocked.code() + ": " + blocked.getMessage();
				if (blocked.code().equals("TARGET_NOT_VISIBLE")) return TickResult.running(progress());
				return finish(player, blocked.code(), "Cannot clear " + describe(player, clearingAt, state) + ": " + refusal, false);
			}
		}
		TickResult step = clearing.tick(player, now);
		if (step.state() == State.RUNNING) return TickResult.running(progress());
		clearing.cancel(player); clearing = null;
		BlockState state = SeenTerrain.of(player).known(clearingAt.getX(),clearingAt.getY(),clearingAt.getZ());
		if (step.state() == State.SUCCEEDED || state != null && state.isAir()) {
			if (step.state() == State.SUCCEEDED) cleared++;
			clearingAt = null; cellTicks = 0;
			return TickResult.running(progress());
		}
		if (step.reasonCode().equals("ON_FIRE")) { clearingAt = null; return TickResult.running(progress()); }
		return finish(player, step.reasonCode(), step.message(), false);
	}

	private static String describe(ServerPlayer player, BlockPos at, BlockState state) {
		return (state == null ? "unknown cell" : net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString())
				+ " at " + at.toShortString();
	}

	private double progress() { return (double) index / cells.size(); }
	private String facts() { return "Shelter interior=" + center.toShortString() + "; opening=" + opening.getSerializedName()
			+ "; placed=" + placed + "; cleared=" + cleared + (supports > 0 ? "; supports=" + supports : "") + "; completed=" + index + "/" + cells.size(); }
	private TickResult finish(ServerPlayer player, String code, String message, boolean timeout) {
		cancel(player);
		return timeout ? TickResult.timedOut(code, facts() + "; " + message, progress()) : TickResult.failed(code, facts() + "; " + message, progress());
	}
	@Override
	public void cancel(ServerPlayer player) {
		if (approach != null) approach.cancel(player);
		if (clearing != null) clearing.cancel(player);
		input.release();
	}
}
