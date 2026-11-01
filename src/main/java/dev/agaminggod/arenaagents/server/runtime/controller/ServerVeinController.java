package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.agent.AgentDomainException;
import dev.agaminggod.arenaagents.server.perception.SeenTerrain;
import dev.agaminggod.arenaagents.server.perception.ThreatPerception;
import dev.agaminggod.arenaagents.server.runtime.InventoryRoom;
import dev.agaminggod.arenaagents.server.runtime.TargetSightline;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputState;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;

/**
 * mine_vein: one model call fells the tree or mines the ore vein a seen block belongs to, at body speed. Each block is
 * an ordinary break_block (its aim, every admission gate, its own tool choice), chosen from what the body perceives
 * ({@link VeinPlan}): a tree is cut from beside the trunk and then from inside its column, a vein from where the body
 * stands. It never breaks a block the body stands on or anything under it, never walks anywhere but to a seen standing
 * cell beside a trunk and one step into the trunk's own column, and stops and hands back on lava seen or heard behind a
 * block or opened by one, damage, a sensed hostile, a full inventory, maxBlocks or the timeout. A tree whose seen logs
 * it cannot all reach (or that has more than maxBlocks) is refused before the first swing, so it never leaves floating
 * logs it knew about. The model chose the block; nothing here picks another tree or vein.
 */
public final class ServerVeinController implements ServerController {
	/** Executor services: one break_block sub-action with its admission gates (throws its refusal). */
	public interface Environment {
		ServerController breakBlock(ServerPlayer body, BlockPos at, long timeoutMs);
	}

	static final double HOSTILE_RANGE = 12.0D;
	static final long BLOCK_TIMEOUT_MS = 15_000L;
	static final int ENTER_TICKS = 40;

	private enum Phase { PLAN, APPROACH, OPEN_COLUMN, ENTER, CUT }

	private final BlockPos target;
	private final int maxBlocks;
	private final long deadline;
	private final long startedAt;
	private final Environment environment;
	private final CombatInputLease input = new CombatInputLease();

	private Phase phase = Phase.PLAN;
	private String family;
	private VeinPlan.Kind kind;
	private String blockName;
	private BlockPos base, stance;
	private boolean column;
	private int enterTicks;
	private float lastHealth = Float.NaN;
	private ServerNavigationController approach;
	private ServerController breaking;
	private BlockPos breakingAt;
	private boolean breakingLeaves;
	private final List<BlockPos> broken = new ArrayList<>();
	private final Set<BlockPos> skipped = new HashSet<>();
	private final java.util.Map<BlockPos, String> skipWhy = new java.util.LinkedHashMap<>();
	private int leaves, planned = 1;

	public ServerVeinController(BlockPos target, int maxBlocks, long timeoutMs, long now, Environment environment) {
		if (maxBlocks < 1 || maxBlocks > VeinPlan.MAX_BLOCKS) throw new IllegalArgumentException("maxBlocks must be 1.." + VeinPlan.MAX_BLOCKS);
		if (timeoutMs <= 0L) throw new IllegalArgumentException("timeoutMs must be positive");
		this.target = target.immutable();
		this.maxBlocks = maxBlocks;
		this.startedAt = now;
		this.deadline = now + timeoutMs;
		this.environment = environment;
	}

	@Override
	public TickResult tick(ServerPlayer player, long now) {
		if (!player.isAlive()) return stop(player, "AGENT_DEAD", "Agent player died", false, now);
		if (Float.isNaN(lastHealth)) lastHealth = player.getHealth();
		if (now >= deadline) return stop(player, "VEIN_TIMEOUT", "timeoutMs ran out", true, now);
		TickResult danger = danger(player, now);
		if (danger != null) return danger;
		if (breaking != null) return breakTick(player, now);
		return switch (phase) {
			case PLAN -> plan(player, now);
			case APPROACH -> approachTick(player, now);
			case OPEN_COLUMN -> openColumn(player, now);
			case ENTER -> enter(player, now);
			case CUT -> cut(player, now);
		};
	}

	@Override
	public void cancel(ServerPlayer player) {
		if (approach != null) approach.cancel(player);
		if (breaking != null) breaking.cancel(player);
		approach = null;
		breaking = null;
		input.release();
	}

	// ---- planning ----

	private TickResult plan(ServerPlayer player, long now) {
		SeenTerrain.Reader<BlockState> seen = SeenTerrain.of(player);
		BlockState state = seen.known(target.getX(), target.getY(), target.getZ());
		family = VeinPlan.family(state == null ? null : blockId(state));
		kind = VeinPlan.kind(family);
		if (kind == null) return fail(player, "INVALID_VEIN_TARGET", (state == null ? "No seen block" : blockId(state))
				+ " at " + cell(target) + " is not a seen log, stem or ore; mine_vein fells a tree or mines an ore vein", now);
		blockName = blockId(state);
		if (kind == VeinPlan.Kind.VEIN) {
			planned = Math.min(maxBlocks, component(player).size());
			phase = Phase.CUT;
			return cut(player, now);
		}
		List<BlockPos> logs = VeinPlan.component(List.of(target), family, at -> known(player, at), maxBlocks + 1);
		if (logs.size() > maxBlocks) return fail(player, "TREE_TOO_BIG", "More than maxBlocks " + maxBlocks + " seen logs belong to this tree;"
				+ " felling part of it would leave floating logs. Not swung; raise maxBlocks (up to " + VeinPlan.MAX_BLOCKS + ") or mine logs one by one", now);
		planned = logs.size();
		base = VeinPlan.trunkBase(logs, player.position());
		BlockPos feet = player.blockPosition();
		boolean beside = feet.getY() == base.getY() && Math.abs(feet.getX() - base.getX()) + Math.abs(feet.getZ() - base.getZ()) == 1
				&& player.onGround();
		stance = beside ? feet : VeinPlan.stance(base, player.position(), at -> open(player, at), at -> floor(player, at));
		if (stance == null) return fail(player, "NO_STANCE", "No seen standing cell beside the trunk base " + cell(base)
				+ " (open feet and head over a solid floor); stand beside the trunk first", now);
		column = floor(player, base.below());
		double range = player.blockInteractionRange();
		List<BlockPos> out = column ? VeinPlan.outOfReach(logs, range, VeinPlan.eyeAt(stance), VeinPlan.columnEye(base))
				: VeinPlan.outOfReach(logs, range, VeinPlan.eyeAt(stance));
		if (!out.isEmpty()) {
			BlockPos high = out.stream().max(java.util.Comparator.comparingInt(BlockPos::getY)).orElseThrow();
			return fail(player, "TREE_OUT_OF_REACH", out.size() + " of " + logs.size() + " seen logs are out of reach from the trunk (highest at "
					+ cell(high) + "); felling would leave them floating. Not swung; pillar up beside the trunk or mine the reachable logs one by one", now);
		}
		phase = feet.equals(stance) ? Phase.OPEN_COLUMN : Phase.APPROACH;
		return TickResult.running(progress());
	}

	private TickResult approachTick(ServerPlayer player, long now) {
		input.release();
		if (approach == null) approach = new ServerNavigationController(Vec3.atBottomCenterOf(stance), 0.35D, false, now, Math.max(1L, deadline - now), false);
		TickResult result = approach.tick(player, now);
		if (result.state() == State.RUNNING) return TickResult.running(progress());
		approach.cancel(player);
		approach = null;
		if (result.state() != State.SUCCEEDED) return fail(player, result.reasonCode(), "Could not reach the standing cell " + cell(stance)
				+ " beside the trunk: " + result.message(), now);
		phase = Phase.OPEN_COLUMN;
		return TickResult.running(progress());
	}

	/** The trunk's two lowest cells, head height first, so the body can step into the column. */
	private TickResult openColumn(ServerPlayer player, long now) {
		if (!column) {
			phase = Phase.CUT;
			return TickResult.running(progress());
		}
		for (BlockPos cell : List.of(base.above(), base)) {
			BlockState state = SeenTerrain.of(player).known(cell.getX(), cell.getY(), cell.getZ());
			if (state == null || open(player, cell)) continue;
			String id = blockId(state);
			if (skipped.contains(cell) || !family.equals(VeinPlan.family(id)) && !VeinPlan.leaves(id)) {
				// Something else stands in the column (a vine, a block): cut from beside the trunk only.
				column = false;
				phase = Phase.CUT;
				return TickResult.running(progress());
			}
			return startBreak(player, cell, VeinPlan.leaves(id), now);
		}
		phase = Phase.ENTER;
		enterTicks = 0;
		return enter(player, now);
	}

	/** One step into the opened column, onto the floor the trunk stood on. */
	private TickResult enter(ServerPlayer player, long now) {
		double dx = base.getX() + 0.5D - player.getX(), dz = base.getZ() + 0.5D - player.getZ();
		if (player.blockPosition().equals(base) && player.onGround() && Math.abs(dx) <= 0.2D && Math.abs(dz) <= 0.2D) {
			input.release();
			phase = Phase.CUT;
			return TickResult.running(progress());
		}
		if (++enterTicks > ENTER_TICKS) {
			input.release();
			// Could not step in: what is in reach from here is still cut.
			column = false;
			phase = Phase.CUT;
			return TickResult.running(progress());
		}
		float[] keys = BrinkGuard.keysToward(player.getYRot(), dx, dz);
		input.apply(player, new AgentInputState(keys[0], keys[1], false, false, false, false, false,
				player.getYRot(), player.getXRot(), player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
		return TickResult.running(progress());
	}

	// ---- cutting ----

	private TickResult cut(ServerPlayer player, long now) {
		input.release();
		if (broken.size() >= maxBlocks) return done(player, "maxBlocks " + maxBlocks + " reached", now);
		Vec3 eye = player.getEyePosition();
		double range = player.blockInteractionRange();
		List<BlockPos> candidates = new ArrayList<>();
		for (BlockPos at : component(player)) {
			if (skipped.contains(at) || broken.contains(at)) continue;
			if (VeinPlan.underBody(player.getBoundingBox(), at)) { skip(at, "under the body"); continue; }
			if (VeinPlan.reachable(eye, at, range)) candidates.add(at);
		}
		candidates.sort(VeinPlan.order(kind, eye));
		for (BlockPos at : candidates) {
			Vec3 aim = TargetSightline.block(player.level(), CollisionContext.of(player), eye, at, range, null);
			if (aim != null) return startBreak(player, at, false, now);
			// Hidden: a player cuts the leaves in front of a branch log.
			BlockPos leaf = kind == VeinPlan.Kind.TREE && leaves < VeinPlan.MAX_LEAVES ? leavesInTheWay(player, eye, at) : null;
			if (leaf != null && !skipped.contains(leaf)) return startBreak(player, leaf, true, now);
			skip(at, "not in sight");
		}
		return done(player, null, now);
	}

	private TickResult startBreak(ServerPlayer player, BlockPos at, boolean leaf, long now) {
		BlockState state = player.level().getBlockState(at);
		if (!leaf) {
			TickResult room = inventoryRoom(player, at, state, now);
			if (room != null) return room;
		}
		try {
			breaking = environment.breakBlock(player, at, Math.max(1L, Math.min(BLOCK_TIMEOUT_MS, deadline - now)));
		} catch (AgentDomainException refused) {
			switch (refused.code()) {
				case "TARGET_NOT_VISIBLE", "UNSEEN_BELOW", "TARGET_CHANGED" -> {
					skip(at, refused.code().equals("UNSEEN_BELOW") ? "the drop under it is unseen" : "not in sight");
					return TickResult.running(progress());
				}
				case "LAVA_BEHIND" -> {
					return stop(player, "LAVA_AHEAD", refused.getMessage(), false, now);
				}
				default -> {
					return stop(player, refused.code(), refused.getMessage(), false, now);
				}
			}
		}
		breakingAt = at;
		breakingLeaves = leaf;
		return breakTick(player, now);
	}

	private TickResult breakTick(ServerPlayer player, long now) {
		TickResult result = breaking.tick(player, now);
		if (result.state() == State.RUNNING) return TickResult.running(progress());
		BlockPos at = breakingAt;
		boolean leaf = breakingLeaves;
		breaking = null;
		breakingAt = null;
		if (result.state() == State.SUCCEEDED) {
			if (leaf) leaves++;
			else broken.add(at);
			String lava = lavaBeside(player, at);
			if (lava != null) return stop(player, "LAVA_OPENED", "Lava " + lava + " beside the opening at " + cell(at), false, now);
			return TickResult.running(progress());
		}
		switch (result.reasonCode()) {
			case "TARGET_NOT_VISIBLE", "AIM_NOT_REACHED", "TARGET_CHANGED", "TARGET_NOT_STARTED" -> {
				skip(at, "not in sight");
				return TickResult.running(progress());
			}
			default -> {
				return stop(player, result.reasonCode(), result.message(), false, now);
			}
		}
	}

	/** The first leaves block on the sight line to a hidden log, when leaves are all that hide it. */
	private static BlockPos leavesInTheWay(ServerPlayer player, Vec3 eye, BlockPos log) {
		BlockHitResult hit = player.level().clip(new ClipContext(eye, Vec3.atCenterOf(log), ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, player));
		if (hit.getType() != HitResult.Type.BLOCK || hit.getBlockPos().equals(log)) return null;
		BlockState state = player.level().getBlockState(hit.getBlockPos());
		if (!VeinPlan.leaves(blockId(state))) return null;
		return VeinPlan.reachable(eye, hit.getBlockPos(), player.blockInteractionRange()) ? hit.getBlockPos().immutable() : null;
	}

	private List<BlockPos> component(ServerPlayer player) {
		List<BlockPos> seeds = new ArrayList<>(broken);
		if (!seeds.contains(target)) seeds.add(0, target);
		return VeinPlan.component(seeds, family, at -> known(player, at), VeinPlan.SEARCH_LIMIT);
	}

	// ---- stops ----

	private TickResult danger(ServerPlayer player, long now) {
		float health = player.getHealth();
		if (health < lastHealth - 0.01F) {
			String source = player.getLastDamageSource() == null ? "unknown" : player.getLastDamageSource().getMsgId();
			return stop(player, "DAMAGE_TAKEN", "Took " + fmt(lastHealth - health) + " damage (" + source + "); health " + fmt(health), false, now);
		}
		lastHealth = health;
		if (player.tickCount % 5 == 0) {
			Mob nearest = null;
			for (Mob mob : player.level().getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(HOSTILE_RANGE),
					mob -> player.distanceTo(mob) <= HOSTILE_RANGE && ThreatPerception.isSensedThreat(player, mob))) {
				if (nearest == null || player.distanceTo(mob) < player.distanceTo(nearest)) nearest = mob;
			}
			if (nearest != null) return stop(player, "HOSTILE_NEAR", BuiltInRegistries.ENTITY_TYPE.getKey(nearest.getType()) + " " + nearest.getUUID()
					+ " at " + cell(nearest.blockPosition()) + ", " + fmt(player.distanceTo(nearest)) + " blocks away", false, now);
		}
		return null;
	}

	private TickResult inventoryRoom(ServerPlayer player, BlockPos at, BlockState state, long now) {
		if (player.isCreative() || player.getInventory().getFreeSlot() >= 0) return null;
		for (ItemStack drop : Block.getDrops(state, player.level(), at, null, player, player.getMainHandItem())) {
			if (!InventoryRoom.canTake(player, drop)) return stop(player, "INVENTORY_FULL", "Inventory is full; "
					+ BuiltInRegistries.ITEM.getKey(drop.getItem()) + " from " + blockId(state) + " at " + cell(at) + " would stay on the ground", false, now);
		}
		return null;
	}

	private static String lavaBeside(ServerPlayer player, BlockPos opened) {
		SeenTerrain.Reader<BlockState> seen = SeenTerrain.of(player);
		for (Direction side : Direction.values()) {
			BlockPos next = opened.relative(side);
			BlockState state = seen.known(next.getX(), next.getY(), next.getZ());
			if (state != null && state.getFluidState().is(FluidTags.LAVA)) return "seen at " + cell(next);
		}
		return null;
	}

	// ---- results ----

	private TickResult done(ServerPlayer player, String why, long now) {
		cancel(player);
		if (broken.isEmpty()) return TickResult.failed("NOTHING_MINED", "No block of the " + noun() + " at " + cell(target)
				+ " was in reach and sight" + left(player), 0.0D);
		return TickResult.succeeded(kind == VeinPlan.Kind.TREE ? "TREE_FELLED" : "VEIN_MINED", facts(now) + (why == null ? "" : "; " + why) + left(player));
	}

	private TickResult stop(ServerPlayer player, String code, String why, boolean timedOut, long now) {
		cancel(player);
		String message = why + (broken.isEmpty() && leaves == 0 ? "" : "; so far " + facts(now)) + (kind == null ? "" : left(player));
		return timedOut ? TickResult.timedOut(code, message, progress()) : TickResult.failed(code, message, progress());
	}

	private TickResult fail(ServerPlayer player, String code, String why, long now) {
		cancel(player);
		return TickResult.failed(code, why, 0.0D);
	}

	private String facts(long now) {
		return String.format(Locale.ROOT, "%s %d %s in %.1f s%s", kind == VeinPlan.Kind.TREE ? "felled:" : "mined:", broken.size(),
				blockName, (now - startedAt) / 1000.0D, leaves == 0 ? "" : ", cleared " + leaves + " leaves");
	}

	/** Seen blocks of the tree or vein still standing, and why each was left. */
	private String left(ServerPlayer player) {
		if (family == null) return "";
		LinkedHashSet<String> rows = new LinkedHashSet<>();
		int count = 0;
		for (BlockPos at : component(player)) {
			if (broken.contains(at)) continue;
			count++;
			if (rows.size() < 4) rows.add(cell(at) + " (" + skipWhy.getOrDefault(at, "out of reach") + ")");
		}
		if (count == 0) return kind == VeinPlan.Kind.TREE ? "; no seen log of it is left" : "; no seen block of it is left";
		return "; " + count + " seen " + (kind == VeinPlan.Kind.TREE ? "log(s)" : "block(s)") + " left: " + String.join(", ", rows)
				+ (count > rows.size() ? ", ..." : "");
	}

	private void skip(BlockPos at, String why) {
		skipped.add(at);
		skipWhy.putIfAbsent(at, why);
	}

	private String noun() {
		return kind == VeinPlan.Kind.TREE ? "tree" : "vein";
	}

	private double progress() {
		return Math.min(1.0D, broken.size() / (double) Math.max(1, planned));
	}

	private static String known(ServerPlayer player, BlockPos at) {
		BlockState state = SeenTerrain.of(player).known(at.getX(), at.getY(), at.getZ());
		return state == null ? null : blockId(state);
	}

	private static boolean open(ServerPlayer player, BlockPos at) {
		BlockState state = SeenTerrain.of(player).known(at.getX(), at.getY(), at.getZ());
		return state != null && state.getCollisionShape(player.level(), at).isEmpty() && state.getFluidState().isEmpty();
	}

	private static boolean floor(ServerPlayer player, BlockPos at) {
		BlockState state = SeenTerrain.of(player).known(at.getX(), at.getY(), at.getZ());
		return state != null && state.getFluidState().isEmpty() && state.isFaceSturdy(player.level(), at, Direction.UP)
				&& VeinPlan.family(blockId(state)) == null;
	}

	private static String blockId(BlockState state) {
		return BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
	}

	private static String cell(BlockPos at) {
		return at.getX() + "," + at.getY() + "," + at.getZ();
	}

	private static String fmt(double value) {
		return String.format(Locale.ROOT, "%.1f", value);
	}
}
