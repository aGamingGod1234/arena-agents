package dev.agaminggod.arenaagents.server.runtime.controller;

import com.google.gson.JsonObject;
import dev.agaminggod.arenaagents.agent.AgentDomainException;
import dev.agaminggod.arenaagents.server.perception.ObservationVisibility;
import dev.agaminggod.arenaagents.server.runtime.ElapsedTimeAccumulator;
import dev.agaminggod.arenaagents.server.runtime.ServerProtectionPolicy;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputState;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputStates;
import dev.agaminggod.arenaagents.server.runtime.reflex.ReflexSensors;
import dev.agaminggod.arenaagents.server.runtime.transaction.ServerTransactionAdapter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.tags.BlockTags;
import net.minecraft.util.Mth;
import net.minecraft.world.InteractionHand;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.EntityTypes;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.Enderman;
import net.minecraft.world.entity.projectile.Projectile;
import net.minecraft.world.item.ArrowItem;
import net.minecraft.world.item.BowItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.ShieldItem;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

/**
 * Model-chosen fight_until: fights one mob type until the inventory holds untilCount of untilItem. Each engagement is
 * an ordinary fight_target (melee) or use_ranged untilDead (bow) at the nearest seen target of that type inside the
 * area, with the same aim, reach, timing and pickup those actions have. Between engagements the body walks back to the
 * model's spot (when one was given). It stops at the count, at timeoutMs, at fleeAtHealth, on new lava contact, when a
 * bow-only skill runs out of arrows or bow, when no target was seen for 30 s, when two engagements in a row fail with the
 * same reason, or when the model cancels. Fire alone does not hand back: as a player plays blazes, the body steps off a
 * fire block and fights on while it burns; with a shield in the offhand it lowers the weapon and raises the shield
 * toward a shot it sees flying at it (vanilla blocking: activation delay, front arc), then fights on; and between
 * engagements with two or more blazes in line of fire it steps to a seen cell within 3 blocks that fewer of them see
 * (fixtures only: {@link #COVER} is off by default).
 *
 * <p>fight_target and use_ranged with untilItem+untilCount run this engine too: the model's named target is fought
 * first and its type is the mob. roof:true (endermen only) first builds a one-cell shelter with carried blocks: two-high
 * walls on three sides, a roof, and a two-high doorway toward the enderman with a lintel block over it (placed from
 * outside, where its face can be seen). A 2.9-block-tall enderman fits neither the cell nor the doorway, so from the
 * cell's middle it stays out of its melee reach while the body's longer reach hits it in the doorway (vanilla). Vanilla
 * counts a stare only when the enderman's eyes see the body's column at their own height, which a roof hides, so the
 * body steps two cells out under open sky to stare a calm enderman hostile, walks back in and swings in place. After a
 * kill it walks out to the drop and back, as a player does.
 */
public final class ServerFightUntilController implements ServerController {
	public static final long DEFAULT_TIMEOUT_MS = 180_000L;
	public static final long MAX_TIMEOUT_MS = 600_000L;
	public static final double DEFAULT_RADIUS = 24.0D;
	public static final float DEFAULT_FLEE_AT_HEALTH = 6.0F;
	static final long NO_TARGET_MS = 30_000L;
	/**
	 * The shield turns to a seen shot that lands within this (a blaze fireball crosses 10 blocks in about a second). 1.5 s,
	 * not 1.0: a vanilla shield blocks only 5 ticks after it is raised, and d41 platform fixture bodies burned 10-20 s a
	 * trial from unblocked fireballs with no fire block touched.
	 */
	static final double GUARD_SHOT_S = 1.5D;
	/** It stays toward that line this many ticks after the last inbound shot (a blaze volley is three shots in 0.6 s). */
	static final long GUARD_HOLD_TICKS = 12L;
	/** Cover is weighed between engagements at most this often (ticks), within this many blocks. */
	static final long COVER_EVERY_TICKS = 40L;
	/**
	 * Fixture A/B switch (-Darenaagents.fight.cover=true); off by default. Cover never ran before review 3 (an overflowed
	 * sentinel); once it ran, the d41 floor fixture went from 0/5 deaths and 20 rods (48f02318) to 2/5 and 16, then 4/5 and
	 * 6 (evals/d41-review3-fix wip1, wip2), so it stays off until it is reworked and measured again.
	 */
	static final boolean COVER = "true".equals(System.getProperty("arenaagents.fight.cover"));
	static final int COVER_RADIUS = 3;
	/** How long the body looks toward a kill for a drop it did not see fall (a turn and a glance). */
	static final long DROP_LOOK_MS = 1_500L;
	/** One engagement's own limit; it is then re-chosen (weapon and target) like a player re-reads the fight. */
	static final long MELEE_SEGMENT_MS = 30_000L;
	static final long VOLLEY_SEGMENT_MS = 15_000L;
	/** A target an engagement failed on is passed over for this long. */
	static final long EXCLUDE_MS = 15_000L;
	static final double SPOT_SLACK = 2.0D;
	/** Engagement endings that are not failures: the target moved out of sight or out of the world, or a segment ended. */
	private static final Set<String> SOFT_ENDS = Set.of("TARGET_GONE", "TARGET_NOT_VISIBLE", "TARGET_KILLED",
			"RANGED_VOLLEY_TIMED_OUT", "FIGHT_TIMED_OUT", "ACTION_TIMED_OUT", "ACTION_CANCELLED", "ON_FIRE");

	public enum Weapon { AUTO, BOW, SWORD }

	/** The body's own construction for roof:true, with the build_shelter placement and clearing gates. */
	public interface Roofing {
		/** The carried full solid block (not falling, no block entity, not obsidian) held the most of, or null. */
		String blockItem(ServerPlayer body);
		/** build_shelter's roofed cell without the sill: the opening is a two-high doorway. */
		ServerController shelter(BlockPos center, Direction opening, String itemId, boolean sneak, long timeoutMs, long now);
		Vec3 aim(ServerPlayer body, BlockPos at, Direction face, String itemId);
		/** Null when placed, else why not. */
		String place(ServerPlayer body, BlockPos at, Direction face, String itemId);
	}

	/** A calm enderman not provoked by a stare within this time is passed over. */
	static final long PROVOKE_MS = 6_000L;
	/** After a roofed kill, the drops have this long to fall and be picked up from inside. */
	static final long SETTLE_MS = 1_500L;
	/**
	 * An angry enderman farther than this is awaited where the body stands rather than chased: it walks or teleports to
	 * its target itself (vanilla), and a chase across a warped forest runs past lava lips.
	 */
	static final double ENDER_HOLD_RANGE = 5.0D;
	/** The perch: blocks up (feet above a 2.9-block enderman's reach), and how long the climb may take (ticks). */
	static final int PERCH_HEIGHT = 3;
	static final int PERCH_TICKS = 140;
	/** How long the body waits for an angry enderman that does not come before walking in to it. */
	static final long ENDER_HOLD_MS = 8_000L;
	/** An attacker that hit the body this recently is turned to even when out of view (the hurt tilt and its scream). */
	static final int HURT_TURN_TICKS = 60;

	private final ServerProtectionPolicy protection;
	private final EntityType<?> mob;
	private final String mobId;
	private final Item untilItem;
	private final String untilItemId;
	private final int untilCount;
	private final Weapon weapon;
	private final boolean collect;
	private final float fleeAtHealth;
	private final Vec3 spot;
	private final double radius;
	private final long timeoutMs;
	/** Count mode: the model's own fight_target / use_ranged options, kept for every engagement. */
	private final CountFightChoices choices;
	private final ElapsedTimeAccumulator elapsedTime;
	private final HazardEntry hazard = new HazardEntry();
	private final Map<UUID, Long> excluded = new HashMap<>();
	private final Map<String, Integer> endings = new LinkedHashMap<>();
	/** Hurts the body took, by damage kind and what the body was doing (shield, sword, bow, move, idle). */
	private final Map<String, Integer> hurts = new LinkedHashMap<>();
	private int lastHurtTime;
	private final List<String> log = new ArrayList<>();
	private Vec3 center;
	private int startCount = -1;
	private int startArrows;
	private int kills;
	private int bowEngagements;
	private int meleeEngagements;
	/** Bow shots passed over because the kill's drop would fall where the body cannot walk; kills whose drop did. */
	private int bowSkipsOverDrop;
	private int killsOverDrop;
	/** Bow engagements put down for a mob hitting from sword reach. */
	private int reachTurns;
	/** Sword engagements on a blaze out of reach turned to an attacker inside it (the engine's own switch). */
	private int swordTurns;
	/** The engagement is a short melee hold chosen because the bow's kill would drop out of reach. */
	private boolean heldForFloor;
	private boolean bowSpent;
	private long lastTargetMs;
	/** The shield arm and fire footwork share one combat input lease, held only while they act. */
	private final CombatInputLease guardInput = new CombatInputLease();
	/**
	 * The crouch the model's sneak:true holds for the whole call (holdCrouch). It sits under navigation (100) and combat
	 * (200), so a sword engagement, walk, guard or ledge step that drives the keys wins (each crouches itself), and the
	 * stance fills every tick nobody drives: a bow draw (the volley has no key lease), waits, looks, a pickup at the drop.
	 */
	static final int STANCE_PRIORITY = 50;
	private final CombatInputLease stanceInput = new CombatInputLease(STANCE_PRIORITY);
	private boolean guardHeld;
	private Vec3 shotFrom;
	private long shotTick = Long.MIN_VALUE;
	private int guards;
	private int shieldBlocks;
	private int shieldWear = -1;
	private int burnTicks;
	private int fireSteps;
	/** Ticks spent clicking on a fire block the body stood in with no way off it. */
	private int firePunches;
	private int fireContactTicks;
	/** Seen blazes glowing charged, since which game tick; shield raises at a charged blaze's due volley. */
	private final Map<UUID, Long> chargedSince = new HashMap<>();
	private int chargeGuards;
	static final boolean CHARGE_GUARD = !"false".equals(System.getProperty("arenaagents.fight.chargeGuard"));
	static final double CHARGE_RANGE = 16.0D;
	/** A blaze charges 60 ticks before its first fireball; the shield goes up 10 ticks before (turn and 5-tick raise). */
	static final long CHARGE_DUE_TICKS = 50L;
	/** Three fireballs over about 12 ticks after the charge. */
	static final long CHARGE_HOLD_TICKS = 25L;
	/** Backing off to heal: since when (elapsed ms, -1 when not), where to, and totals for the result. */
	private long recoverSinceMs = -1L;
	private long recoverEndedMs = Long.MIN_VALUE / 2;
	private Vec3 recoverGoal;
	private int recovers;
	private int recoverMoves;
	private int recoverNotes;
	private int recoverLooks;
	private long recoverLookUntilMs = -1L;
	private float recoverLookYaw;
	private long recoverMs;
	/** Fixture A/B switch (-Darenaagents.fight.recover=false); on by default. */
	static final boolean RECOVER = !"false".equals(System.getProperty("arenaagents.fight.recover"));
	static final float RECOVER_MARGIN = 8.0F;
	static final float RECOVER_DONE = 18.0F;
	static final long RECOVER_MS = 30_000L;
	static final long RECOVER_GAP_MS = 5_000L;
	static final int RECOVER_RADIUS = 8;
	/** Ticks of stepping toward a way off fire before the body punches the flame out instead. */
	static final int FIRE_STEP_TICKS = 15;
	private boolean inFire;
	private Vec3 fireExit;
	/** Never weighed yet: a sentinel compared by {@link #coverDue}, never subtracted (Long.MIN_VALUE overflowed). */
	static final long COVER_NEVER = Long.MIN_VALUE;
	private long coverCheckTick = COVER_NEVER;
	private Vec3 coverGoal;
	private int coverMoves;
	/** After a kill that gained nothing, the body looks where the target died (until this elapsed ms) for its drop. */
	private long dropLookUntilMs = -1L;
	private int heldAtEngage;
	private int dropLooks;
	private int dropsFound;
	private String lastFailure;
	private int failuresInRow;
	private LivingEntity current;
	private ServerFightController melee;
	private ServerTransactionAdapter.ActiveTransaction volley;
	private ServerNavigationController walk;
	/** The look-around turn while no target is seen: a player turns to find the next mob, it is never seen through the back of the head. */
	private ServerLookController look;
	private int lookStep;
	private int walkFailures;
	private TickResult finished;
	/** Which call runs the engine: fight_until, or fight_target / use_ranged in count mode. */
	private final String via;
	private LivingEntity firstTarget;
	private final boolean roof;
	private final Roofing roofing;
	private boolean roofed;
	private int roofBuilds;
	private BlockPos roofCenter;
	private Direction roofOpening;
	private String roofItem;
	private ServerController building;
	private LivingEntity provoking;
	private long provokeSinceMs;
	/** Calm endermen a stare from the open did not provoke; they are walked in to and hit instead. */
	private final Set<UUID> staredOut = new java.util.HashSet<>();
	private LivingEntity holding;
	private long holdSinceMs;
	private int stares;
	private int staresProvoked;
	private int holds;
	private int attackerSoftEnds;
	/** The low-health perch (endermen): the column's base cell, blocks placed, ticks spent; done once per call. */
	private BlockPos perchBase;
	private int perchPlaced;
	private int perchTicks;
	private int perchSlot = -1;
	private boolean perchTried;
	private AgentInputStates.MotorState perchMotor;
	private Vec3 lastKillAt;
	private long settleUntilMs = -1L;
	private int heldBeforeSettle;
	private boolean lintelPlaced;
	private int lintelTicks;
	private ServerNavigationController step;
	/** The game tick the short walk (cover, recover, roof) was last ticked on. */
	private long stepTick;
	private Vec3 stepGoal;
	private KillDropCollector collector;
	/** pursue:false: since when (elapsed ms, -1 none) the sword engagement's target has stayed out of sword reach. */
	private long outOfReachSinceMs = -1L;
	private UUID outOfReachTarget;
	static final long STILL_REACH_MS = 20_000L;
	/** Count mode: the trip up to a drop seen landing on a ledge above the feet, and the drops already tried. */
	private LedgeFetch ledge;
	private final java.util.Set<UUID> ledgeTried = new java.util.HashSet<>();
	private final java.util.Set<UUID> ledgeRefused = new java.util.HashSet<>();
	private final Map<String, Integer> ledgeRefusals = new LinkedHashMap<>();
	private final Map<String, Integer> ledgeOutcomes = new LinkedHashMap<>();
	private int ledgeLowHealth;
	private int heldBeforeLedge;
	/** Where kills died whose drop the body has not seen (no rod seen falling, none found by the look). */
	private final List<Vec3> unseenKills = new ArrayList<>();
	/** Kills over a ledge whose drop was not seen before the body goes up to look for them. */
	static final int LEDGE_UNSEEN_KILLS = 2;
	private int ledgeTrips;
	private int ledgeRods;
	/** Game tick of the ledge trip's last tick: a trip nobody ticks puts its walk down before the walk's lease expires. */
	private long ledgeTick;
	/** The model's targetPolicy, applied by the engine (each engagement stays on the one target the engine named). */
	private int policySwitches;
	private int policyCountdown;
	private UUID dwellTarget;
	private long dwellSinceTick;
	private int breakOuts;

	public ServerFightUntilController(ServerPlayer player, JsonObject arguments, ServerProtectionPolicy protection, long now) {
		this(player, arguments, protection, now, "fight_until", null, null);
	}

	public ServerFightUntilController(ServerPlayer player, JsonObject arguments, ServerProtectionPolicy protection, long now,
			String via, LivingEntity firstTarget, Roofing roofing) {
		this.via = via;
		this.firstTarget = firstTarget;
		this.roofing = roofing;
		this.protection = Objects.requireNonNull(protection, "protection must not be null");
		this.mobId = arguments.get("mob").getAsString();
		this.mob = BuiltInRegistries.ENTITY_TYPE.getOptional(Identifier.parse(mobId))
				.orElseThrow(() -> new AgentDomainException("INVALID_FIELD", "mob: no entity type " + mobId));
		this.untilItemId = arguments.get("untilItem").getAsString();
		this.untilItem = BuiltInRegistries.ITEM.getOptional(Identifier.parse(untilItemId))
				.orElseThrow(() -> new AgentDomainException("INVALID_FIELD", "untilItem: no item " + untilItemId));
		this.untilCount = arguments.get("untilCount").getAsInt();
		this.weapon = arguments.has("weapon") ? Weapon.valueOf(arguments.get("weapon").getAsString().toUpperCase(Locale.ROOT)) : Weapon.AUTO;
		this.fleeAtHealth = arguments.has("fleeAtHealth") ? arguments.get("fleeAtHealth").getAsFloat() : DEFAULT_FLEE_AT_HEALTH;
		this.spot = arguments.has("x") ? new Vec3(arguments.get("x").getAsDouble(), arguments.get("y").getAsDouble(), arguments.get("z").getAsDouble()) : null;
		this.radius = arguments.has("radius") ? arguments.get("radius").getAsDouble() : DEFAULT_RADIUS;
		this.timeoutMs = Math.min(MAX_TIMEOUT_MS, arguments.has("timeoutMs") ? arguments.get("timeoutMs").getAsLong() : DEFAULT_TIMEOUT_MS);
		this.choices = CountFightChoices.from(arguments);
		// Count mode collects by default; the model's pursue:false (fight in place) keeps the body off drop walks unless it said collect:true.
		this.collect = arguments.has("collect") ? arguments.get("collect").getAsBoolean() : choices.collectByDefault();
		if (weapon == Weapon.BOW && mob == EntityTypes.ENDERMAN)
			throw new AgentDomainException("INVALID_FIELD", "weapon bow: an enderman teleports away from arrows (vanilla)");
		boolean anyBow = player.getOffhandItem().getItem() instanceof BowItem || hasBow(player);
		if (weapon == Weapon.BOW && !anyBow) throw new AgentDomainException("BOW_NOT_EQUIPPED", "No bow in either hand or the hotbar");
		if (weapon == Weapon.BOW && !bowReady(player)) throw new AgentDomainException("OUT_OF_ARROWS", "No arrow to loose");
		this.roof = arguments.has("roof") && arguments.get("roof").getAsBoolean();
		if (roof && mob != EntityTypes.ENDERMAN)
			throw new AgentDomainException("INVALID_FIELD", "roof: only against endermen (a 2-high space keeps out a 3-tall enderman; " + mobId + " fits)");
		if (roof && roofing == null) throw new AgentDomainException("INVALID_FIELD", "roof: no construction available here");
		this.elapsedTime = new ElapsedTimeAccumulator(now);
	}

	@Override
	public TickResult tick(ServerPlayer player, long nowEpochMs) {
		TickResult result = tickBody(player, nowEpochMs);
		holdCrouch(player, result);
		return result;
	}

	/**
	 * sneak:true holds the crouch for the whole call: every part that drives the keys crouches itself (sword, guard,
	 * navigation walks, drop pickups), and this low-priority lease keeps the crouch on every other tick (a bow draw,
	 * between engagements, looking around, waiting on a target). Its view and slot are refreshed each tick so it never
	 * turns the body back when it becomes the winning lease.
	 */
	private void holdCrouch(ServerPlayer player, TickResult result) {
		if (finished != null || result.state() != State.RUNNING || !choices.sneak()) { stanceInput.release(); return; }
		stanceInput.apply(player, new AgentInputState(0.0F, 0.0F, false, true, false, false, false, player.getYRot(), player.getXRot(),
				player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
	}

	private void applyGuard(ServerPlayer player, AgentInputState state) {
		guardInput.apply(player, state);
	}

	private TickResult tickBody(ServerPlayer player, long nowEpochMs) {
		if (finished != null) return finished;
		long elapsed = elapsedTime.advance(nowEpochMs);
		if (startCount < 0) {
			startCount = count(player, untilItem);
			startArrows = arrows(player);
			center = spot != null ? spot : player.position();
			hazard.observe(player);
		}
		if (!player.isAlive()) return stop(player, TickResult.failed("AGENT_DEAD", "Agent player died during fight_until", progress(player)));
		int held = count(player, untilItem);
		if (held >= untilCount && melee == null && volley == null)
			return stop(player, TickResult.succeeded("UNTIL_COUNT_REACHED", "Holds " + held + " " + untilItemId + " (asked " + untilCount + ")"));
		if (elapsed >= timeoutMs)
			return stop(player, TickResult.timedOut("FIGHT_UNTIL_TIMED_OUT", String.format(Locale.ROOT, "%.0f s timeout reached", timeoutMs / 1000.0D), progress(player)));
		if (step != null && stepIdle(player.level().getGameTime(), stepTick)) {
			step.cancel(player);
			step = null;
			if (coverGoal != null && coverGoal.equals(stepGoal)) coverGoal = null;
		}
		if (ledge != null && stepIdle(player.level().getGameTime(), ledgeTick)) ledge.suspend(player);
		if (perchBase != null) return perchTick(player, elapsed, nowEpochMs);
		if (CombatPlanning.shouldBailOut(player.getHealth(), fleeAtHealth)) {
			if (startPerch(player)) return perchTick(player, elapsed, nowEpochMs);
			return stop(player, TickResult.failed("LOW_HEALTH_BAILOUT", String.format(Locale.ROOT,
					"Health %.1f reached fleeAtHealth %.1f; body idle, no retreat performed", player.getHealth(), fleeAtHealth), progress(player)));
		}
		boolean immune = HazardExits.fireResistant(player);
		if (player.isOnFire() && !immune) burnTicks++;
		if (player.hurtTime > lastHurtTime) {
			var source = player.getLastDamageSource();
			String phase = guardHeld ? "shield" : melee != null ? "sword" : volley != null ? "bow" : ledge != null ? "ledge" : step != null || walk != null || collector != null ? "move" : "idle";
			hurts.merge((source == null ? "unknown" : source.getMsgId()) + " " + phase, 1, Integer::sum);
		}
		lastHurtTime = player.hurtTime;
		long gameTick = player.level().getGameTime();
		if (gameTick % 5L == 0L) rememberSeenDrops(player);
		boolean fireContact = !immune && HazardExits.contact(player) == HazardExits.Contact.FIRE;
		InteractionHand shieldHand = !immune && !roofed && choices.guardShield(player.getOffhandItem().getItem() instanceof ShieldItem) ? InteractionHand.OFF_HAND : null;
		if (shieldHand != null) {
			Projectile shot = ReflexSensors.blockableShot(player, GUARD_SHOT_S);
			if (shot != null) { shotFrom = ReflexSensors.shieldFacing(shot); shotTick = gameTick; }
			else if (mob == EntityTypes.BLAZE && CHARGE_GUARD) {
				LivingEntity due = chargedBlazeDue(player, gameTick);
				if (due != null) { shotFrom = due.getEyePosition(); shotTick = gameTick; chargeGuards++; }
			}
		}
		boolean shielding = shieldHand != null && shotFrom != null && gameTick - shotTick <= GUARD_HOLD_TICKS;
		// A kill's drop pickup runs inside the engagement; the shield waits for it.
		boolean collecting = (melee != null || volley != null) && current != null && current.isDeadOrDying();
		// A ledge trip in mid-pillar is not dropped for a shot (fire still stops it): a player finishes the climb.
		if ((shielding && (ledge == null || !ledge.climbing()) || fireContact) && !collecting) return guard(player, shieldHand, shielding, fireContact, elapsed);
		releaseGuard();

		if (!roof && mob == EntityTypes.BLAZE && RECOVER && choices.guardShield(true)) {
			TickResult recovering = tickRecover(player, nowEpochMs, elapsed);
			if (recovering != null) return recovering;
		}

		if (roof) {
			TickResult roofStep = tickRoof(player, nowEpochMs, elapsed);
			if (roofStep != null) return roofStep;
		}

		if (volley != null && current != null && !current.isDeadOrDying()) {
			// A bow drawn at a hovering blaze while another hits from sword reach (live d41 platform: four punches at 3.1
			// a hit while the body aimed past them): as a player, put the bow down and swing at the one in reach.
			LivingEntity close = attackerInReach(player);
			if (close != null && close != current && mayEngage(player, close)) {
				volley.cancel("attacker in sword reach");
				volley.cleanup();
				volley = null;
				firstTarget = current;
				reachTurns++;
				note("bow put down for " + BuiltInRegistries.ENTITY_TYPE.getKey(close.getType()) + " in sword reach");
				current = null;
				engageMelee(player, close, elapsed, nowEpochMs);
				return TickResult.running(progress(player));
			}
		}
		if (melee != null && current != null && !current.isDeadOrDying()) {
			LivingEntity close = swordTurn(player);
			if (close != null) {
				// The engine's own in-reach switch (the sword engagement never switches by itself): the same gates as the bow's.
				melee.cancel(player);
				melee = null;
				firstTarget = current;
				swordTurns++;
				note("sword turned from " + BuiltInRegistries.ENTITY_TYPE.getKey(current.getType()) + " out of reach to "
						+ BuiltInRegistries.ENTITY_TYPE.getKey(close.getType()) + " in sword reach");
				current = null;
				engageMelee(player, close, elapsed, nowEpochMs);
				return TickResult.running(progress(player));
			}
		}
		if (volley != null) { outOfReachSinceMs = -1L; outOfReachTarget = null; }
		else if (melee != null && current != null && !current.isDeadOrDying() && !roof && !choices.mayMove()) {
			// pursue:false swings only at what comes into reach: a target that stays out of it hands back early, not at the timeout.
			if (!current.getUUID().equals(outOfReachTarget)) {
				outOfReachTarget = current.getUUID();
				outOfReachSinceMs = -1L;
			}
			if (player.getAttackRangeWith(player.getMainHandItem()).isInRange(player, current.getBoundingBox(), 0.0D)) outOfReachSinceMs = -1L;
			else if (outOfReachSinceMs < 0L) outOfReachSinceMs = elapsed;
			else if (elapsed - outOfReachSinceMs >= STILL_REACH_MS)
				return stop(player, TickResult.failed("TARGET_OUT_OF_REACH", String.format(Locale.ROOT,
						"pursue:false: %s %s stayed out of sword reach for %.0f s (%.1f blocks away) and no bow shot was taken; the body stays in place, so the fight handed back",
						BuiltInRegistries.ENTITY_TYPE.getKey(current.getType()), current.getUUID(), STILL_REACH_MS / 1000.0D, player.distanceTo(current)), progress(player)));
		}
		if (melee != null || volley != null) {
			LivingEntity better = current != null && !current.isDeadOrDying() ? policySwitch(player, gameTick) : null;
			if (better != null) {
				// The model's targetPolicy: a clearly better attacker (CombatPlanning.policyRetarget's dwell and margins) replaces the target.
				if (melee != null) melee.cancel(player);
				if (volley != null) { volley.cancel(choices.targetPolicy().wireName() + " switched target"); volley.cleanup(); }
				melee = null;
				volley = null;
				if (firstTarget == current) firstTarget = null;
				policySwitches++;
				note(choices.targetPolicy().wireName() + ": switched to " + BuiltInRegistries.ENTITY_TYPE.getKey(better.getType()) + " " + better.getUUID());
				current = null;
				lastTargetMs = elapsed;
				engage(player, better, elapsed, nowEpochMs);
				return finished != null ? finished : TickResult.running(progress(player));
			}
			String end = tickEngagement(player, nowEpochMs);
			if (end == null) {
				lastTargetMs = elapsed;
				return TickResult.running(progress(player));
			}
			if (finished != null) return finished;
			hazard.observe(player);
			if (count(player, untilItem) >= untilCount)
				return stop(player, TickResult.succeeded("UNTIL_COUNT_REACHED", "Holds " + count(player, untilItem) + " " + untilItemId + " (asked " + untilCount + ")"));
			return TickResult.running(progress(player));
		}

		String hazardCode = hazard.observe(player);
		// New fire contact is handled above (step off, fight on); new lava hands back.
		if (HazardEntry.IN_LAVA.equals(hazardCode))
			return stop(player, TickResult.failed(hazardCode, CombatMoveText.hazardStop(hazardCode, player, "fight_until"), progress(player)));

		if (!roof) {
			TickResult looking = tickDropLook(player, nowEpochMs, elapsed);
			if (looking != null) return looking;
			if (collect && choices.mayMove()) {
				TickResult fetching = tickLedge(player, nowEpochMs, elapsed);
				if (fetching != null) return fetching;
			}
		}
		LivingEntity target = nextTarget(player, elapsed);
		if (target != null && roofed && !provoked(player, target)) {
			// A calm enderman is stared hostile from the open cell outside the doorway (a roof hides the body from it).
			if (look != null) { look.cancel(player); look = null; }
			lastTargetMs = elapsed;
			if (provoking != target) { provoking = target; provokeSinceMs = elapsed; }
			TickResult walking = walkTo(player, Vec3.atBottomCenterOf(outside()), nowEpochMs);
			if (walking != null) return walking;
			if (elapsed - provokeSinceMs >= PROVOKE_MS + 4_000L) {
				// Vanilla counts a stare only if the enderman's eyes see the body's column at their own height.
				Vec3 column = new Vec3(player.getX(), target.getEyeY(), player.getZ());
				boolean hidden = player.level().clip(new net.minecraft.world.level.ClipContext(target.getEyePosition(), column,
						net.minecraft.world.level.ClipContext.Block.VISUAL, net.minecraft.world.level.ClipContext.Fluid.NONE, target)).getType()
						!= net.minecraft.world.phys.HitResult.Type.MISS;
				note(String.format(Locale.ROOT, "stare did not provoke %s %s in %d s (%.1f blocks away, its eyes %.1f above your feet%s)", mobId,
						target.getUUID(), (PROVOKE_MS + 4_000L) / 1000, player.distanceTo(target), target.getEyeY() - player.getY(),
						hidden ? "; blocks hide your column at its eye height, so vanilla ignores the stare" : ""));
				excluded.put(target.getUUID(), elapsed + EXCLUDE_MS);
				provoking = null;
				return TickResult.running(progress(player));
			}
			ServerLookController.turnToward(player, target.getEyePosition());
			return TickResult.running(progress(player));
		}
		if (target != null && roofed) {
			// Fights happen from the cell's middle, out of the enderman's melee reach.
			TickResult walking = walkTo(player, Vec3.atBottomCenterOf(roofCenter), nowEpochMs);
			if (walking != null) return walking;
		}
		if (target != null && !roofed && mob == EntityTypes.ENDERMAN) {
			TickResult open = tickOpenEnderman(player, target, elapsed);
			if (open != null) return open;
		}
		boolean coverTick = COVER && target != null && !roofed && spot == null && mob == EntityTypes.BLAZE && choices.mayReposition();
		// A cover walk not ticked this tick is put down: its navigation lease expires after 40 idle ticks (LeasedServerInputController
		// LEASE_TIMEOUT_TICKS) and a later tick on it threw "input lease is no longer active" (review-3 floor fixture).
		if (!coverTick && coverGoal != null) {
			if (step != null && coverGoal.equals(stepGoal)) { step.cancel(player); step = null; }
			coverGoal = null;
		}
		if (coverTick) {
			TickResult moving = takeCover(player, nowEpochMs, gameTick);
			if (moving != null) { lastTargetMs = elapsed; return moving; }
		}
		if (target != null) {
			provoking = null;
			if (walk != null) { walk.cancel(player); walk = null; }
			if (look != null) { look.cancel(player); look = null; }
			lastTargetMs = elapsed;
			String refused = engage(player, target, elapsed, nowEpochMs);
			if (refused != null) return finished != null ? finished : TickResult.running(progress(player));
			return TickResult.running(progress(player));
		}
		if (elapsed - lastTargetMs >= NO_TARGET_MS)
			return stop(player, TickResult.failed("NO_TARGET_SEEN", String.format(Locale.ROOT,
					"No %s seen within %.0f blocks of %s for %.0f s", mobId, radius, cell(center), NO_TARGET_MS / 1000.0D), progress(player)));
		if (roofed) {
			TickResult walking = walkTo(player, Vec3.atBottomCenterOf(roofCenter), nowEpochMs);
			if (walking != null) return walking;
		} else if (spot != null && (walk != null || player.position().distanceTo(spot) > SPOT_SLACK)) return walkBack(player, nowEpochMs);
		lookAround(player, nowEpochMs);
		return TickResult.running(progress(player));
	}

	/**
	 * roof:true phases, in order: build the shelter (no sill); place the lintel from outside; after a kill, let the drop
	 * fall, then walk out to it and back. Null once the body is under its roof and free to fight.
	 */
	private TickResult tickRoof(ServerPlayer player, long now, long elapsed) {
		if (collector != null) {
			String done = collector.tick(player, now);
			if (done == null) return TickResult.running(progress(player));
			collector = null;
			note("collect: " + done);
			lastTargetMs = elapsed;
		}
		if (settleUntilMs >= 0L && melee == null && volley == null) {
			if (count(player, untilItem) > heldBeforeSettle) settleUntilMs = -1L;
			else if (elapsed < settleUntilMs) return TickResult.running(progress(player));
			else {
				settleUntilMs = -1L;
				List<UUID> drops = dropsNear(player, lastKillAt);
				if (!drops.isEmpty()) {
					breakOuts++;
					collector = new KillDropCollector(drops, protection::mayTakeEntity, now).crouched(choices.sneak());
					return TickResult.running(progress(player));
				}
				note("no " + untilItemId + " dropped at the kill");
			}
		}
		if (roofed && lintelPlaced) return null;
		if (!roofed) {
			if (building == null) {
				if (roofCenter == null) {
					roofCenter = spot != null ? BlockPos.containing(spot) : player.blockPosition();
					roofOpening = openingToward(player);
					if (spot == null) chooseSite(player);
					roofItem = roofing.blockItem(player);
				}
				int needed = cellsToPlace(player);
				int carried = roofItem == null ? 0 : count(player, BuiltInRegistries.ITEM.getValue(Identifier.parse(roofItem)));
				if (roofItem == null || carried < needed)
					return stop(player, TickResult.failed("ROOF_BLOCKS_MISSING", String.format(Locale.ROOT,
							"roof:true needs %d more full solid blocks of one kind for the shelter at %s (two-high walls, roof, lintel); carries %s; nothing was built",
							needed, roofCenter.toShortString(), roofItem == null ? "none" : carried + " " + roofItem), progress(player)));
				building = roofing.shelter(roofCenter, roofOpening, roofItem, choices.sneak(), Math.max(1L, Math.min(60_000L, timeoutMs - elapsed)), now);
			}
			TickResult built = building.tick(player, now);
			if (built.state() == State.RUNNING) return TickResult.running(progress(player));
			building.cancel(player);
			building = null;
			if (built.state() != State.SUCCEEDED)
				return stop(player, TickResult.failed(built.reasonCode().startsWith("SNEAK_") ? built.reasonCode() : "ROOF_NOT_BUILT", "Roof not built: " + built.reasonCode() + ": " + built.message(), progress(player)));
			roofed = true;
			roofBuilds++;
			center = Vec3.atBottomCenterOf(roofCenter);
			lastTargetMs = elapsed;
		}
		// The lintel: from the open cell outside the doorway the roof block's outer face is in view.
		BlockPos lintel = roofCenter.relative(roofOpening).above(2);
		var seen = dev.agaminggod.arenaagents.server.perception.SeenTerrain.of(player).known(lintel.getX(), lintel.getY(), lintel.getZ());
		if (seen != null && seen.isCollisionShapeFullBlock(player.level(), lintel)) {
			lintelPlaced = true;
			lastTargetMs = elapsed;
			note("roof " + roofBuilds + " built at " + roofCenter.toShortString() + ", doorway " + roofOpening.getSerializedName());
			return TickResult.running(progress(player));
		}
		TickResult walking = walkTo(player, Vec3.atBottomCenterOf(outside()), now);
		if (walking != null) return walking;
		if (++lintelTicks > 60)
			return stop(player, TickResult.failed("ROOF_NOT_BUILT", "Roof not built: the lintel over the doorway at " + lintel.toShortString() + " was not placed", progress(player)));
		Vec3 aim;
		try { aim = roofing.aim(player, lintel, roofOpening, roofItem); }
		catch (AgentDomainException refused) { aim = Vec3.atCenterOf(lintel); note("lintel aim " + refused.code()); }
		if (!ServerLookController.turnToward(player, aim)) return TickResult.running(progress(player));
		try {
			String why = roofing.place(player, lintel, roofOpening, roofItem);
			if (why != null) note("lintel: " + why);
		} catch (AgentDomainException refused) {
			if (lintelTicks % 20 == 0) note("lintel refused " + refused.code() + ": " + refused.getMessage());
		}
		return TickResult.running(progress(player));
	}

	/** The open cell two steps out of the doorway. */
	private BlockPos outside() {
		return roofCenter.relative(roofOpening, 2);
	}

	/** Null on arrival (within 0.35 blocks); otherwise one navigation tick toward the point. */
	private TickResult walkTo(ServerPlayer player, Vec3 goal, long now) {
		if (player.position().distanceTo(goal) <= 0.35D && player.onGround()) {
			if (step != null) { step.cancel(player); step = null; }
			return null;
		}
		if (step == null || !goal.equals(stepGoal)) {
			if (step != null) step.cancel(player);
			step = new ServerNavigationController(goal, 0.3D, false, now, 10_000L, false).crouched(choices.sneak());
			stepGoal = goal;
		}
		TickResult result = tickStep(player, now);
		if (result.state() == State.RUNNING) return TickResult.running(progress(player));
		step.cancel(player);
		step = null;
		if (result.state() != State.SUCCEEDED) {
			note("walk to " + cell(goal) + " " + result.reasonCode());
			if (++walkFailures >= 3)
				return stop(player, TickResult.failed("SPOT_UNREACHABLE", "Three walks inside the roof site failed: " + result.reasonCode(), progress(player)));
		}
		return TickResult.running(progress(player));
	}

	/** The window faces the nearest seen enderman in the area, else the way the body faces. */
	private Direction openingToward(ServerPlayer player) {
		Vec3 from = Vec3.atBottomCenterOf(roofCenter);
		LivingEntity nearest = firstTarget;
		if (nearest == null) {
			double best = Double.MAX_VALUE;
			for (LivingEntity entity : player.level().getEntitiesOfClass(LivingEntity.class, new AABB(from, from).inflate(radius),
					e -> e.getType() == mob && e.isAlive())) {
				if (!ObservationVisibility.canSeeEntity(player, entity)) continue;
				double d = entity.distanceToSqr(from);
				if (d < best) { best = d; nearest = entity; }
			}
		}
		if (nearest == null) return player.getDirection();
		Vec3 delta = nearest.position().subtract(from);
		if (delta.horizontalDistanceSqr() < 1.0E-4D) return player.getDirection();
		return Direction.getApproximateNearest(delta.x, 0.0D, delta.z);
	}

	/**
	 * A player builds on firm ground: the start cell or a seen neighbour within 2 blocks (same floor height), and a
	 * window side, where the interior has seen floor and headroom and every ground-level wall or sill cell has seen
	 * solid ground below it (or is already solid). Closest first; the window toward the enderman breaks ties. When none
	 * qualifies the start cell and the window toward the enderman stay (build_shelter then adds supports or names why).
	 */
	private void chooseSite(ServerPlayer player) {
		var seen = dev.agaminggod.arenaagents.server.perception.SeenTerrain.of(player);
		java.util.function.Predicate<BlockPos> solid = at -> {
			var state = seen.known(at.getX(), at.getY(), at.getZ());
			return state != null && state.isCollisionShapeFullBlock(player.level(), at);
		};
		java.util.function.Predicate<BlockPos> open = at -> {
			var state = seen.known(at.getX(), at.getY(), at.getZ());
			return state != null && state.getCollisionShape(player.level(), at).isEmpty() && state.getFluidState().isEmpty();
		};
		BlockPos start = roofCenter;
		Direction toward = roofOpening;
		BlockPos bestCenter = null;
		Direction bestOpening = null;
		double best = Double.MAX_VALUE;
		for (int dx = -2; dx <= 2; dx++) for (int dz = -2; dz <= 2; dz++) {
			BlockPos center = start.offset(dx, 0, dz);
			if (!solid.test(center.below()) || !open.test(center) || !open.test(center.above())) continue;
			for (Direction opening : Direction.Plane.HORIZONTAL) {
				boolean firm = true;
				int built = 0;
				for (ServerShelterController.Cell cell : ServerShelterController.plan(center, opening, true, false)) {
					BlockPos at = cell.at();
					if (solid.test(at)) built++;
					if (at.getY() != center.getY() || solid.test(at)) continue;
					if (!solid.test(at.below())) { firm = false; break; }
				}
				// The doorway and the open cell beyond it must be walkable (the body stares and collects from there).
				for (BlockPos walkable : new BlockPos[] {center.relative(opening), center.relative(opening, 2)})
					if (!solid.test(walkable.below()) || !open.test(walkable) || !open.test(walkable.above())) firm = false;
				if (!firm) continue;
				// Cells already standing (an earlier shelter) save blocks and keep its window.
				double score = Math.abs(dx) + Math.abs(dz) + (opening == toward ? 0.0D : 0.5D) - 0.2D * built;
				if (score < best) { best = score; bestCenter = center; bestOpening = opening; }
			}
		}
		if (bestCenter == null) { note("no firm shelter site within 2 blocks; building at the start cell"); return; }
		roofCenter = bestCenter;
		roofOpening = bestOpening;
	}

	/** Shelter cells the body has not seen solid yet (each takes one carried block). */
	private int cellsToPlace(ServerPlayer player) {
		var seen = dev.agaminggod.arenaagents.server.perception.SeenTerrain.of(player);
		int needed = 0;
		List<BlockPos> cells = new ArrayList<>();
		for (ServerShelterController.Cell cell : ServerShelterController.plan(roofCenter, roofOpening, true, false)) cells.add(cell.at());
		cells.add(roofCenter.relative(roofOpening).above(2));
		for (BlockPos at : cells) {
			var state = seen.known(at.getX(), at.getY(), at.getZ());
			if (state == null || !state.isCollisionShapeFullBlock(player.level(), at)) needed++;
		}
		return needed;
	}

	/** untilItem drops lying within 4 blocks of where the body saw its last kill die. */
	private List<UUID> dropsNear(ServerPlayer player, Vec3 at) {
		if (at == null) return List.of();
		List<UUID> ids = new ArrayList<>();
		for (ItemEntity item : player.level().getEntitiesOfClass(ItemEntity.class, new AABB(at, at).inflate(4.0D),
				e -> e.isAlive() && e.getItem().is(untilItem))) ids.add(item.getUUID());
		return ids;
	}

	/** True when the enderman already targets the body or is inside melee reach (the first hit provokes it). */
	private static boolean provoked(ServerPlayer player, LivingEntity target) {
		if (target instanceof Mob hostile && hostile.getTarget() == player) return true;
		double reach = player.entityInteractionRange();
		return target.getBoundingBox().distanceToSqr(player.getEyePosition()) <= reach * reach;
	}

	/** The mob is hostile to this body (vanilla target). */
	private static boolean attacking(ServerPlayer player, LivingEntity entity) {
		return entity instanceof Mob hostile && hostile.getTarget() == player;
	}

	/** Seen, or the attacker that just hurt the body (a player feels the hit's direction and hears an enderman scream). */
	private static boolean sensed(ServerPlayer player, LivingEntity entity) {
		if (ObservationVisibility.canSeeEntity(player, entity)) return true;
		return player.getLastHurtByMob() == entity && player.tickCount - player.getLastHurtByMobTimestamp() <= HURT_TURN_TICKS
				&& entity.distanceTo(player) <= 8.0D;
	}

	/**
	 * Open-ground endermen, as a player hunts them. A calm one out of reach is stared at the head from where the body
	 * stands (vanilla: the view within 0.025/distance of its eyes and a clear line between the eyes; it then comes to
	 * the body) instead of being walked to; one the stare does not provoke in PROVOKE_MS is walked in to and hit. An angry
	 * one beyond ENDER_HOLD_RANGE is awaited, the view on its legs (a stare inside 4 blocks makes it teleport away), up
	 * to ENDER_HOLD_MS. One out of view that just hit the body is turned to. Null when the engagement may start.
	 */
	private TickResult tickOpenEnderman(ServerPlayer player, LivingEntity target, long elapsed) {
		boolean seen = ObservationVisibility.canSeeEntity(player, target);
		if (!seen) {
			if (look != null) { look.cancel(player); look = null; }
			lastTargetMs = elapsed;
			ServerLookController.turnToward(player, legs(target));
			return TickResult.running(progress(player));
		}
		if (!provoked(player, target)) {
			holding = null;
			if (staredOut.contains(target.getUUID()) || !eyesClear(player, target)) return null;
			if (provoking != target) { provoking = target; provokeSinceMs = elapsed; stares++; }
			if (elapsed - provokeSinceMs >= PROVOKE_MS) {
				staredOut.add(target.getUUID());
				provoking = null;
				note(String.format(Locale.ROOT, "stare did not provoke %s %s in %d s (%.1f blocks away); walking in to hit it", mobId,
						target.getUUID(), PROVOKE_MS / 1000, player.distanceTo(target)));
				return null;
			}
			if (look != null) { look.cancel(player); look = null; }
			if (walk != null) { walk.cancel(player); walk = null; }
			lastTargetMs = elapsed;
			ServerLookController.turnToward(player, target.getEyePosition());
			return TickResult.running(progress(player));
		}
		if (provoking == target) { staresProvoked++; provoking = null; }
		if (!attacking(player, target) || player.distanceTo(target) <= ENDER_HOLD_RANGE) { holding = null; return null; }
		if (holding != target) { holding = target; holdSinceMs = elapsed; holds++; }
		if (elapsed - holdSinceMs >= ENDER_HOLD_MS) return null;
		if (look != null) { look.cancel(player); look = null; }
		if (walk != null) { walk.cancel(player); walk = null; }
		lastTargetMs = elapsed;
		ServerLookController.turnToward(player, legs(target));
		return TickResult.running(progress(player));
	}

	/**
	 * At fleeAtHealth with an angry enderman within 8 blocks, the body pillars PERCH_HEIGHT blocks up with a carried
	 * plain block before it hands back, as players escape one: a mob's melee box reaches out sideways but not above its
	 * own 2.9-block height (vanilla Mob.getAttackBoundingBox), and an enderman cannot stand on the column. Needs the
	 * blocks on the hotbar, solid footing and open cells above the head. False when it does not apply.
	 */
	private boolean startPerch(ServerPlayer player) {
		if (perchTried || mob != EntityTypes.ENDERMAN || roofed || !player.onGround() || player.isInWater() || player.isInLava()) return false;
		boolean hunted = !player.level().getEntitiesOfClass(Enderman.class, player.getBoundingBox().inflate(8.0D),
				e -> e.isAlive() && e.getTarget() == player && e.getBoundingBox().maxY > player.getY()).isEmpty();
		if (!hunted) return false;
		if (!choices.mayMove()) {
			// The model chose to fight in place: the bailout hands back without the pillar.
			note("pursue:false: no pillar out of reach");
			return false;
		}
		int slot = TravelBuilder.blockSlot(player);
		if (slot < 0 || slot > 8 || player.getInventory().getItem(slot).getCount() < PERCH_HEIGHT) return false;
		BlockPos feet = player.blockPosition();
		for (int up = 2; up <= PERCH_HEIGHT + 1; up++)
			if (!player.level().getBlockState(feet.above(up)).getCollisionShape(player.level(), feet.above(up)).isEmpty()) return false;
		for (int up = 0; up < PERCH_HEIGHT; up++) if (!protection.mayModifyBlock(player, player.level(), feet.above(up))) return false;
		perchTried = true;
		if (melee != null) { melee.cancel(player); melee = null; }
		if (walk != null) { walk.cancel(player); walk = null; }
		if (look != null) { look.cancel(player); look = null; }
		current = null;
		perchBase = feet;
		perchSlot = slot;
		perchPlaced = 0;
		perchTicks = 0;
		perchMotor = AgentInputStates.MotorState.initial(player.getYRot(), player.getXRot());
		note(String.format(Locale.ROOT, "health %.1f at fleeAtHealth %.1f with an angry enderman near: pillaring %d up at %s", player.getHealth(),
				fleeAtHealth, PERCH_HEIGHT, feet.toShortString()));
		return true;
	}

	/** One tick of the perch: centre over the column, look straight down, jump, place under the feet at the top. */
	private TickResult perchTick(ServerPlayer player, long elapsed, long now) {
		lastTargetMs = elapsed;
		BlockPos next = perchBase.above(perchPlaced);
		double off = Math.hypot(perchBase.getX() + 0.5D - player.getX(), perchBase.getZ() + 0.5D - player.getZ());
		boolean standingTop = player.onGround() && player.getY() >= next.getY() - 1.0E-3D && player.getY() < next.getY() + 0.5D;
		if (perchPlaced >= PERCH_HEIGHT && standingTop) return endPerch(player, true, null);
		if (++perchTicks > PERCH_TICKS) return endPerch(player, false, "the column did not rise in " + PERCH_TICKS / 20 + " s");
		if (off > 0.8D && player.onGround()) return endPerch(player, false, "knocked off the column");
		if (!player.isAlive()) return stop(player, TickResult.failed("AGENT_DEAD", "Agent player died during fight_until", progress(player)));
		if (player.getInventory().getItem(perchSlot).isEmpty() || !TravelBuilder.buildingBlock(player.getInventory().getItem(perchSlot)))
			return endPerch(player, false, "no block left in the hotbar slot");
		boolean selected = player.getInventory().getSelectedSlot() == perchSlot;
		boolean high = player.getY() >= next.getY() + 1.0D + 1.0E-3D;
		if (selected && high && player.getXRot() > 80.0F && player.level().getBlockState(next).canBeReplaced()) {
			BlockHitResult hit = TravelBuilder.crosshair(player);
			if (hit != null && hit.getDirection() == Direction.UP && hit.getBlockPos().equals(next.below()) && TravelBuilder.click(player, hit))
				perchPlaced++;
		}
		boolean jump = selected && standingTop && off <= 0.3D && perchPlaced < PERCH_HEIGHT && player.getXRot() > 80.0F;
		float moveYaw = (float) Math.toDegrees(Math.atan2(-(perchBase.getX() + 0.5D - player.getX()), perchBase.getZ() + 0.5D - player.getZ()));
		AgentInputStates.MotorStep motorStep = AgentInputStates.stepMotor(perchMotor, new AgentInputStates.MotorTarget(player.getYRot(), 90.0F,
				off > 0.15D && player.onGround(), jump, false, off > 0.15D ? moveYaw : Float.NaN), now);
		perchMotor = motorStep.state();
		applyGuard(player, new AgentInputState(motorStep.forward(), motorStep.strafe(), motorStep.jump(), choices.sneak(), false, false, false,
				motorStep.state().yaw(), motorStep.state().pitch(), perchSlot, InteractionHand.MAIN_HAND));
		return TickResult.running(progress(player));
	}

	private TickResult endPerch(ServerPlayer player, boolean done, String why) {
		// A perch starts only once shouldBailOut(player.getHealth(), fleeAtHealth) held (tick) or the engagement bailed on it.
		BlockPos base = perchBase;
		perchBase = null;
		releaseGuard();
		String text = done
				? String.format(Locale.ROOT, "Health %.1f reached fleeAtHealth %.1f; perched %d blocks up at %s, out of reach of the endermen below (a mob's melee does not reach above its own height); eat here before fighting on",
						player.getHealth(), fleeAtHealth, perchPlaced, base.above(perchPlaced).toShortString())
				: String.format(Locale.ROOT, "Health %.1f reached fleeAtHealth %.1f; pillar out of reach stopped after %d block%s: %s; body idle",
						player.getHealth(), fleeAtHealth, perchPlaced, perchPlaced == 1 ? "" : "s", why);
		return stop(player, TickResult.failed("LOW_HEALTH_BAILOUT", text, progress(player)));
	}

	private static Vec3 legs(LivingEntity target) {
		return new Vec3(target.getX(), target.getY() + 0.6D, target.getZ());
	}

	/** Vanilla's stare line: the enderman's eyes to the body's eyes, through collision shapes. */
	private static boolean eyesClear(ServerPlayer player, LivingEntity target) {
		return player.level().clip(new ClipContext(target.getEyePosition(), player.getEyePosition(), ClipContext.Block.COLLIDER,
				ClipContext.Fluid.NONE, target)).getType() == HitResult.Type.MISS;
	}

	/** Eased 60-degree turns, alternating level and raised pitch (blazes hover), one after another. */
	private void lookAround(ServerPlayer player, long now) {
		if (look == null) {
			lookStep++;
			double yaw = Math.toRadians(player.getYRot() + 60.0D);
			double pitch = Math.toRadians(lookStep % 2 == 0 ? -25.0D : 0.0D);
			Vec3 eye = player.getEyePosition();
			look = new ServerLookController(eye.add(-Math.sin(yaw) * Math.cos(pitch) * 16.0D, -Math.sin(pitch) * 16.0D, Math.cos(yaw) * Math.cos(pitch) * 16.0D));
		}
		if (look.tick(player, now).state() != State.RUNNING) look = null;
	}

	/** Null while the engagement runs; its reason code once it ended (the skill may have finished too). */
	private String tickEngagement(ServerPlayer player, long now) {
		String code;
		String message;
		boolean ended;
		if (melee != null) {
			TickResult result = melee.tick(player, now);
			ended = result.state() != State.RUNNING;
			code = result.reasonCode();
			message = result.message();
		} else {
			ServerTransactionAdapter.TickResult result = volley.tick(now);
			ended = result.state() != ServerTransactionAdapter.TickState.RUNNING;
			code = result.reasonCode();
			message = result.message();
		}
		if (!ended) return null;
		boolean wasMelee = melee != null;
		if (volley != null) volley.cleanup();
		melee = null;
		volley = null;
		boolean killed = current != null && current.isDeadOrDying();
		if (killed) {
			kills++;
			lastKillAt = current.position();
			if (!dropReachable(player, lastKillAt)) killsOverDrop++;
			if (roofed && collect) { settleUntilMs = elapsedTime.advance(now) + SETTLE_MS; heldBeforeSettle = count(player, untilItem); }
			else if (collect && !roof && count(player, untilItem) <= heldAtEngage) { dropLookUntilMs = elapsedTime.advance(now) + DROP_LOOK_MS; dropLooks++; }
		}
		endings.merge(code, 1, Integer::sum);
		note((wasMelee ? "sword " : "bow ") + code + (killed ? " (kill)" : "") + ": " + message);
		UUID id = current == null ? null : current.getUUID();
		LivingEntity endedTarget = current;
		current = null;
		if ("LOW_HEALTH_BAILOUT".equals(code) && startPerch(player)) return code;
		if (stopsSkill(code)) {
			stop(player, TickResult.failed(code, "Engagement stopped: " + code, progress(player)));
			return code;
		}
		if ("OUT_OF_ARROWS".equals(code) || "BOW_NOT_EQUIPPED".equals(code)) {
			bowSpent = true;
			if (weapon == Weapon.BOW) {
				stop(player, TickResult.failed(code, "weapon bow: " + ("OUT_OF_ARROWS".equals(code) ? "no arrow left" : "no bow left"), progress(player)));
				return code;
			}
			return code;
		}
		if (killed || SOFT_ENDS.contains(code)) {
			if (killed) { failuresInRow = 0; lastFailure = null; }
			return code;
		}
		if (endedTarget != null && endedTarget.isAlive() && !endedTarget.isDeadOrDying() && attacking(player, endedTarget)) {
			// It still hunts the body (an enderman that teleported off, out of reach or view): passing it over leaves the
			// body idle while it comes back and hits (live d41-m4/m5 warped deaths), so it stays the next target.
			attackerSoftEnds++;
			firstTarget = endedTarget;
			return code;
		}
		if (id != null) excluded.put(id, elapsedTime.advance(now) + EXCLUDE_MS);
		failuresInRow = code.equals(lastFailure) ? failuresInRow + 1 : 1;
		lastFailure = code;
		if (failuresInRow >= 2)
			stop(player, TickResult.failed(code, "Two engagements in a row ended " + code + " without a kill", progress(player)));
		return code;
	}

	/** Starts one engagement; returns a refusal code when neither weapon could start (the target is then passed over). */
	private String engage(ServerPlayer player, LivingEntity target, long elapsed, long now) {
		long left = Math.max(1L, timeoutMs - elapsed);
		boolean protectionAllows = protection.mayInteractWithEntity(player, target);
		if (!protectionAllows || !mayEngage(player, target)) {
			// fight_target's own gates (combatTarget) for every engagement, not only the named first target.
			excluded.put(target.getUUID(), elapsed + EXCLUDE_MS);
			if (target == firstTarget) firstTarget = null;
			note("passed over " + BuiltInRegistries.ENTITY_TYPE.getKey(target.getType()) + " " + target.getUUID() + ": PROTECTION_DENIED");
			return "PROTECTION_DENIED";
		}
		current = target;
		heldAtEngage = count(player, untilItem);
		if (useBow(player, target)) {
			JsonObject shot = new JsonObject();
			shot.addProperty("targetId", target.getUUID().toString());
			shot.addProperty("drawDurationMs", choices.draw());
			shot.addProperty("trackTarget", choices.track());
			shot.addProperty("untilDead", true);
			shot.addProperty("timeoutMs", Math.min(weapon == Weapon.BOW ? ServerRangedVolleyController.MAX_TIMEOUT_MS : VOLLEY_SEGMENT_MS, left));
			shot.addProperty("fleeAtHealth", fleeAtHealth);
			// The count fight collects a bow kill's drop itself (the drop look, then a ledge trip for one that landed above):
			// the volley's own pickup walked 15 s at a stair foot under fire, shield down, for a rod on the steps above.
			shot.addProperty("collect", false);
			try {
				volley = new ServerRangedVolleyController(player, shot, protection);
				bowEngagements++;
				return null;
			} catch (AgentDomainException refused) {
				note("bow refused " + refused.code() + ": " + refused.getMessage());
				if ("PROJECTILE_REQUIRED".equals(refused.code()) || "BOW_NOT_EQUIPPED".equals(refused.code())) bowSpent = true;
				if (weapon == Weapon.BOW) {
					current = null;
					if (bowSpent) {
						boolean noArrow = "PROJECTILE_REQUIRED".equals(refused.code());
						stop(player, TickResult.failed(noArrow ? "OUT_OF_ARROWS" : refused.code(), "weapon bow: " + refused.getMessage(), progress(player)));
						return refused.code();
					}
					excluded.put(target.getUUID(), elapsed + EXCLUDE_MS);
					return refused.code();
				}
			}
		}
		engageMelee(player, target, elapsed, now);
		return null;
	}

	/**
	 * The nearest seen mob attacking the body from inside sword reach, or null: the model's continueWithAttackers (reachTurn),
	 * fight_target's gates and protection apply, creepers only when the call fights creepers (a swing does not stop a fuse
	 * and follow-through never picks one), and another player only with includePlayers when it hurt the body.
	 */
	private LivingEntity attackerInReach(ServerPlayer player) {
		var range = player.getAttackRangeWith(player.getMainHandItem());
		LivingEntity best = null;
		double bestDistance = Double.MAX_VALUE;
		for (LivingEntity hostile : player.level().getEntitiesOfClass(LivingEntity.class, player.getBoundingBox().inflate(4.0D),
				e -> e != player && e.isAlive() && !e.isDeadOrDying() && (e instanceof Mob m && m.getTarget() == player
						|| choices.includePlayers() && e instanceof ServerPlayer && player.getLastHurtByMob() == e))) {
			if (!choices.reachTurn(hostile.getType() == mob) || !followable(hostile.getType() == mob, hostile instanceof net.minecraft.world.entity.monster.Creeper)) continue;
			if (!range.isInRange(player, hostile.getBoundingBox(), 0.0D) || !ObservationVisibility.canSeeEntity(player, hostile) || !mayEngage(player, hostile)) continue;
			double distance = player.distanceToSqr(hostile);
			if (distance < bestDistance) { bestDistance = distance; best = hostile; }
		}
		return best;
	}

	/**
	 * A sword fight on a hovering blaze out of sword reach while another attacker hits from inside it (live d41 platform,
	 * batch 4): a player swings at the one in reach. Only an attacker {@link #attackerInReach} admits (the model's
	 * continueWithAttackers, protection, no creepers), else null.
	 */
	private LivingEntity swordTurn(ServerPlayer player) {
		if (current.getType() != EntityTypes.BLAZE) return null;
		if (player.getAttackRangeWith(player.getMainHandItem()).isInRange(player, current.getBoundingBox(), 0.0D)) return null;
		LivingEntity close = attackerInReach(player);
		return close == current ? null : close;
	}

	private void engageMelee(ServerPlayer player, LivingEntity target, long elapsed, long now) {
		long left = Math.max(1L, timeoutMs - elapsed);
		if (!mayEngage(player, target)) {
			excluded.put(target.getUUID(), elapsed + EXCLUDE_MS);
			current = null;
			return;
		}
		current = target;
		heldAtEngage = count(player, untilItem);
		boolean shield = choices.meleeShield(player.getOffhandItem().getItem() instanceof ShieldItem, mob == EntityTypes.BLAZE);
		// Roofed: swing in place from the cell (pursue:false); drops are collected by walking out after the kill.
		long segment = heldForFloor ? FLOOR_HOLD_MS : MELEE_SEGMENT_MS;
		heldForFloor = false;
		// The engine owns every retarget with the model's targetPolicy, continueWithAttackers, includePlayers and protection
		// (nextTarget, policySwitch, swordTurn), so each engagement stays on the one target whose kill and drop it counts and
		// never switches by itself (engineTargets: no in-reach, follow-through or policy switch inside the fight).
		melee = new ServerFightController(target, choices.desiredRange(), fleeAtHealth, false, CombatPlanning.TargetPolicy.NAMED, choices.includePlayers(),
				choices.meleePursue(roofed), choices.sneak(), shield, Math.min(segment, left), now)
				.engineTargets()
				.collectDrops(collect && !roofed ? protection::mayTakeEntity : null);
		meleeEngagements++;
	}

	/**
	 * fight_target's target gates (ServerActionExecutor.combatTarget) for every engagement and retarget: a living target,
	 * not a creative or spectator player, and the protection policy allows interacting with it.
	 */
	private boolean mayEngage(ServerPlayer player, LivingEntity target) {
		return engageable(target.isAlive() && !target.isDeadOrDying(),
				target instanceof ServerPlayer other && (other.isCreative() || other.isSpectator()),
				protection.mayInteractWithEntity(player, target));
	}

	static boolean engageable(boolean alive, boolean untouchablePlayer, boolean protectionAllows) {
		return alive && !untouchablePlayer && protectionAllows;
	}

	/** An engagement that ended for the body's own safety (death, health floor, new lava) ends the skill too; fire does not. */
	private static boolean stopsSkill(String code) {
		boolean stops = switch (code) {
			case "AGENT_DEAD", "LOW_HEALTH_BAILOUT", "IN_LAVA" -> true;
			default -> false;
		};
		return stops;
	}

	private boolean useBow(ServerPlayer player, LivingEntity target) {
		if (weapon == Weapon.SWORD || mob == EntityTypes.ENDERMAN || bowSpent || !bowReady(player)) return false;
		if (weapon == Weapon.BOW) return true;
		// auto: a bow when the target is past melee reach and in clear sight, else the sword. Shield-first melee on
		// blazes was tried and dropped: fixture blaze3 reached 3 rods in 1/5 with 3 kills, against 2/5 and 19 kills here.
		double reach = player.entityInteractionRange();
		boolean inReach = target.getBoundingBox().distanceToSqr(player.getEyePosition()) <= reach * reach;
		if (inReach || !ObservationVisibility.frame(player.level(), player).hasLineOfSight(target)) return false;
		// Count mode wants the drop: a kill over a drop the body cannot walk to loses it (d41 blaze fixture r2: 13 kills,
		// 0 rods). As a player waits for the blaze to drift back over the floor, the sword holds the deck a moment instead.
		if (!dropReachable(player, target.position())) { bowSkipsOverDrop++; heldForFloor = true; return false; }
		return true;
	}

	/** How far below the feet a drop may land and still be walked to (a drop of three costs no health). */
	static final int DROP_REACH_BELOW = 3;
	/** The short sword hold while a target hovers over a drop, before the bow is weighed again. */
	static final long FLOOR_HOLD_MS = 4_000L;

	/**
	 * Whether an item dropped at {@code at} would land on ground and not be lost: straight down to the first block the body
	 * has seen with a top to stand on, no lower than {@link #DROP_REACH_BELOW} under the feet. Higher landings count (a
	 * ledge or stair the route may climb; the d41 floor fixture's rods land 2-3 blocks up). Lava or fluid first, or seen
	 * open air all the way past that depth, is no landing (the void and the lava sea under fortress bridges). A column the
	 * body has not seen all of is given the benefit of the doubt: holding the bow for unseen ground cut floor-fixture kills
	 * from 30 to 10 in five trials (91 shots held).
	 */
	static boolean dropReachable(ServerPlayer player, Vec3 at) {
		var seen = dev.agaminggod.arenaagents.server.perception.SeenTerrain.of(player);
		int feet = Mth.floor(player.getY() + 1.0E-3D);
		int x = Mth.floor(at.x), z = Mth.floor(at.z);
		boolean unseen = false;
		for (int y = Mth.floor(at.y); y >= feet - DROP_REACH_BELOW - 1; y--) {
			var state = seen.known(x, y, z);
			if (state == null) { unseen = true; continue; }
			if (!state.getFluidState().isEmpty()) return false;
			BlockPos pos = new BlockPos(x, y, z);
			if (state.getCollisionShape(player.level(), pos).isEmpty()) continue;
			int landing = y + 1;
			return landing >= feet - DROP_REACH_BELOW;
		}
		return unseen;
	}

	/** The nearest seen living target of the mob type inside the area; one already fighting this body comes first. */
	private LivingEntity nextTarget(ServerPlayer player, long elapsed) {
		excluded.values().removeIf(until -> until <= elapsed);
		if (firstTarget != null) {
			LivingEntity first = firstTarget;
			if (!first.isAlive() || first.isDeadOrDying()) firstTarget = null;
			else if (!mayEngage(player, first)) firstTarget = null;
			else if ((!excluded.containsKey(first.getUUID()) || attacking(player, first)) && sensed(player, first)) return first;
		}
		List<LivingEntity> candidates = candidates(player);
		if (choices.targetPolicy() != CombatPlanning.TargetPolicy.NAMED) {
			// The model's policy picks among the attackers first; with none attacking, the nearest of the mob type starts the next fight.
			int index = CombatPlanning.policyRetarget(choices.targetPolicy(), null, policyCandidates(player, candidates), 0);
			if (index >= 0) return candidates.get(index);
		}
		LivingEntity best = null;
		double bestScore = Double.MAX_VALUE;
		for (LivingEntity entity : candidates) {
			double score = entity.distanceToSqr(player);
			if (entity instanceof Mob hostile && hostile.getTarget() == player) score -= 10_000.0D;
			if (score < bestScore) { bestScore = score; best = entity; }
		}
		return best;
	}

	/**
	 * Who the engine may fight next: seen living mobs of the type inside the area (one attacking the body from past its
	 * edge too), and, on the model's follow-through opt-in (continueWithAttackers or a targetPolicy), other kinds attacking
	 * the body within fight_target's threat range. Players only with includePlayers. fight_target's gates apply to all.
	 */
	private List<LivingEntity> candidates(ServerPlayer player) {
		List<LivingEntity> out = new ArrayList<>();
		AABB area = new AABB(center, center).inflate(radius);
		for (LivingEntity entity : player.level().getEntitiesOfClass(LivingEntity.class, area, e -> e.getType() == mob && e != player && e.isAlive() && !e.isDeadOrDying())) {
			boolean attacker = attacking(player, entity);
			if (!choices.candidate(true, attacker, entity instanceof net.minecraft.world.entity.player.Player)) continue;
			if (excluded.containsKey(entity.getUUID()) && !attacker) continue;
			if (entity.position().distanceTo(center) > radius && !attacker) continue;
			if (!sensed(player, entity) || !mayEngage(player, entity)) continue;
			out.add(entity);
		}
		if (!choices.followThrough()) return out;
		for (LivingEntity entity : player.level().getEntitiesOfClass(LivingEntity.class, player.getBoundingBox().inflate(CombatPlanning.THREAT_RANGE),
				e -> e.getType() != mob && e != player && e.isAlive() && !e.isDeadOrDying())) {
			boolean attacker = attacking(player, entity) || entity instanceof ServerPlayer && player.getLastHurtByMob() == entity;
			if (!choices.candidate(false, attacker, entity instanceof net.minecraft.world.entity.player.Player)
					|| !followable(false, entity instanceof net.minecraft.world.entity.monster.Creeper)) continue;
			if (player.distanceTo(entity) > CombatPlanning.THREAT_RANGE || !sensed(player, entity) || !mayEngage(player, entity)) continue;
			out.add(entity);
		}
		return out;
	}

	/**
	 * Creepers are fought only when the model named the creeper kind (the call's mob): follow-through, policy switches, the
	 * sword turn and every fallback pick among the other kinds pass them over, as fight_target's follow-through does.
	 */
	static boolean followable(boolean ofMobType, boolean creeper) {
		return ofMobType || !creeper;
	}

	private static List<CombatPlanning.PolicyCandidate> policyCandidates(ServerPlayer player, List<LivingEntity> entities) {
		List<CombatPlanning.PolicyCandidate> out = new ArrayList<>(entities.size());
		for (LivingEntity entity : entities)
			out.add(new CombatPlanning.PolicyCandidate(player.distanceTo(entity), dev.agaminggod.arenaagents.server.perception.RiskAssessment.assess(player, entity).risk(),
					attacking(player, entity) || player.getLastHurtByMob() == entity, entity instanceof net.minecraft.world.entity.monster.Creeper));
		return out;
	}

	/**
	 * Twice a second during an engagement under the model's targetPolicy: the attacker CombatPlanning.policyRetarget
	 * switches to (dwell 1.5 s on a target, clear margins), or null to stay on the current target.
	 */
	private LivingEntity policySwitch(ServerPlayer player, long gameTick) {
		if (choices.targetPolicy() == CombatPlanning.TargetPolicy.NAMED) return null;
		if (!current.getUUID().equals(dwellTarget)) { dwellTarget = current.getUUID(); dwellSinceTick = gameTick; }
		if (--policyCountdown > 0) return null;
		policyCountdown = CombatPlanning.POLICY_INTERVAL_TICKS;
		List<LivingEntity> others = candidates(player);
		others.remove(current);
		if (others.isEmpty()) return null;
		CombatPlanning.PolicyCandidate now = new CombatPlanning.PolicyCandidate(player.distanceTo(current),
				dev.agaminggod.arenaagents.server.perception.RiskAssessment.assess(player, current).risk(), true, current instanceof net.minecraft.world.entity.monster.Creeper);
		int index = CombatPlanning.policyRetarget(choices.targetPolicy(), now, policyCandidates(player, others), (int) Math.min(Integer.MAX_VALUE, gameTick - dwellSinceTick));
		return index < 0 ? null : others.get(index);
	}

	/**
	 * The shield arm and fire footwork, as a player plays blazes: the engagement is put down (its target fought first
	 * again after), the shield is raised toward the line the shot flies in on, and in a fire block the body walks to the
	 * nearest seen exit, shield still up. Vanilla decides what the shield blocks (activation delay, front arc).
	 */
	private TickResult guard(ServerPlayer player, InteractionHand hand, boolean shielding, boolean fireContact, long elapsed) {
		if (fireContact && !HazardExits.fireResistant(player) && !choices.mayMove())
			// Getting off fire takes movement the model ruled out (pursue:false): hand back rather than step or pillar.
			return stop(player, TickResult.failed("ON_FIRE", "In fire with pursue:false: the body stays in place, so the fight handed back instead of stepping off the fire",
					progress(player)));
		if (melee != null || volley != null) {
			if (current != null && current.isAlive()) firstTarget = current;
			if (melee != null) melee.cancel(player);
			if (volley != null) { volley.cancel("shield raised"); volley.cleanup(); }
			melee = null;
			volley = null;
			current = null;
		}
		if (step != null) { step.cancel(player); step = null; }
		if (walk != null) { walk.cancel(player); walk = null; }
		if (look != null) { look.cancel(player); look = null; }
		if (collector != null && !roof) { collector.cancel(player); collector = null; dropLookUntilMs = elapsed + DROP_LOOK_MS; }
		// A shot pauses a ledge trip's walk (the shield turns to it); fire underfoot ends the trip.
		if (ledge != null && fireContact) { ledge.cancel(player); ledge = null; note("ledge trip stopped by fire underfoot"); }
		// Its walk is put down while the shield is up (an unticked walk's navigation lease expires in 40 ticks); the trip walks on afresh after.
		else if (ledge != null) ledge.suspend(player);
		if (shielding) {
			int wear = player.getItemInHand(hand).getDamageValue();
			if (!guardHeld) guards++;
			else if (shieldWear >= 0 && wear > shieldWear) shieldBlocks++;
			shieldWear = wear;
		}
		guardHeld = shielding;
		if (fireContact && !inFire) fireSteps++;
		inFire = fireContact;
		Vec3 exit = fireContact ? fireExit(player) : null;
		Vec3 face = shielding ? shotFrom : exit != null ? new Vec3(exit.x, player.getEyeY(), exit.z) : null;
		float yaw = player.getYRot();
		float pitch = player.getXRot();
		if (face != null) {
			Vec3 delta = face.subtract(player.getEyePosition());
			double flat = Math.sqrt(delta.x * delta.x + delta.z * delta.z);
			yaw = AgentInputStates.turnYaw(yaw, Mth.wrapDegrees((float) Math.toDegrees(Math.atan2(-delta.x, delta.z))));
			pitch = AgentInputStates.turnPitch(pitch, Mth.clamp((float) -Math.toDegrees(Math.atan2(delta.y, flat)), -90.0F, 90.0F));
		}
		float forward = 0.0F;
		float strafe = 0.0F;
		boolean punch = false;
		fireContactTicks = fireContact ? fireContactTicks + 1 : 0;
		BlockPos fire = fireContact && (exit == null || fireContactTicks > FIRE_STEP_TICKS) && !shielding ? HazardExits.fireTouched(player) : null;
		if (fire != null) {
			exit = null;
			// No seen way off the fire, or stepping off has not worked (a one-cell shelter lit through its window): punch
			// the flame out, as a player does.
			Vec3 delta = HazardExits.fireAim(fire).subtract(player.getEyePosition());
			double flat = Math.sqrt(delta.x * delta.x + delta.z * delta.z);
			yaw = AgentInputStates.turnYaw(yaw, Mth.wrapDegrees((float) Math.toDegrees(Math.atan2(-delta.x, delta.z))));
			pitch = AgentInputStates.turnPitch(pitch, Mth.clamp((float) -Math.toDegrees(Math.atan2(delta.y, flat)), -90.0F, 90.0F));
			punch = HazardExits.viewHits(player, fire) && !player.isUsingItem();
			if (punch) firePunches++;
		}
		if (exit != null) {
			float[] keys = BrinkGuard.keysToward(yaw, exit.x - player.getX(), exit.z - player.getZ());
			forward = keys[0];
			strafe = keys[1];
		}
		applyGuard(player, new AgentInputState(forward, strafe, false, choices.sneak(), false, punch, shielding, yaw, pitch,
				player.getInventory().getSelectedSlot(), shielding ? hand : InteractionHand.MAIN_HAND));
		lastTargetMs = elapsed;
		return TickResult.running(progress(player));
	}

	/**
	 * A kill whose drop was not seen to fall (a bow kill out at range): turn toward where the target died, as a player
	 * looks for the rod, and walk to any untilItem drop now seen within 4 blocks of it by pick_up_item's route. Null when
	 * nothing is left to do.
	 */
	private TickResult tickDropLook(ServerPlayer player, long now, long elapsed) {
		if (collector != null) {
			String done = collector.tick(player, now);
			if (done == null) { lastTargetMs = elapsed; return TickResult.running(progress(player)); }
			collector = null;
			note("collect after look: " + done);
			return null;
		}
		if (dropLookUntilMs < 0L || lastKillAt == null) return null;
		List<UUID> seen = new ArrayList<>();
		for (ItemEntity item : player.level().getEntitiesOfClass(ItemEntity.class, new AABB(lastKillAt, lastKillAt).inflate(4.0D),
				e -> e.isAlive() && e.getItem().is(untilItem)))
			if (ObservationVisibility.canSeeEntity(player, item)) seen.add(item.getUUID());
		if (!seen.isEmpty()) {
			dropLookUntilMs = -1L;
			dropsFound++;
			if (look != null) { look.cancel(player); look = null; }
			collector = new KillDropCollector(seen, protection::mayTakeEntity, now).crouched(choices.sneak());
			lastTargetMs = elapsed;
			return TickResult.running(progress(player));
		}
		if (elapsed >= dropLookUntilMs) {
			dropLookUntilMs = -1L;
			if (collect && lastKillAt != null) unseenKills.add(lastKillAt);
			return null;
		}
		ServerLookController.turnToward(player, lastKillAt);
		lastTargetMs = elapsed;
		return TickResult.running(progress(player));
	}

	/**
	 * Low on health in a blaze fight (at most {@link #RECOVER_MARGIN} above the model's fleeAtHealth) with food for
	 * natural regeneration: as a player backs off to heal, the body stops shooting, walks to the seen cell within
	 * {@link #RECOVER_RADIUS} blocks that the fewest seen blazes have a line to, and holds the shield toward the nearest
	 * one, swinging only at a blaze that comes into sword reach, until health is back to {@link #RECOVER_DONE} (or
	 * {@link #RECOVER_MS} pass). d41 fixtures: every platform and floor death came after the fight ran on to the
	 * health floor and the body stood in the open. Null when not recovering.
	 */
	private TickResult tickRecover(ServerPlayer player, long now, long elapsed) {
		float health = player.getHealth();
		if (recoverSinceMs < 0L) {
			boolean low = health <= fleeAtHealth + RECOVER_MARGIN && health < RECOVER_DONE;
			if (!low || player.getFoodData().getFoodLevel() < 18 || !(player.getOffhandItem().getItem() instanceof ShieldItem)
					|| elapsed - recoverEndedMs < RECOVER_GAP_MS) return null;
			recoverSinceMs = elapsed;
			recovers++;
			recoverGoal = null;
			recoverLooks = 0;
			recoverLookUntilMs = -1L;
			if (melee != null) melee.cancel(player);
			if (volley != null) { volley.cancel("backing off to heal"); volley.cleanup(); }
			if (melee != null || volley != null) { if (current != null && current.isAlive()) firstTarget = current; current = null; }
			melee = null;
			volley = null;
			if (ledge != null) { ledge.cancel(player); ledge = null; }
			if (look != null) { look.cancel(player); look = null; }
			note(String.format(Locale.ROOT, "health %.1f: backing off to heal", health));
		}
		if (health >= RECOVER_DONE || elapsed - recoverSinceMs >= RECOVER_MS || player.getFoodData().getFoodLevel() < 18) {
			recoverMs += elapsed - recoverSinceMs;
			recoverSinceMs = -1L;
			recoverEndedMs = elapsed;
			if (step != null) { step.cancel(player); step = null; }
			guardInput.release();
			note(String.format(Locale.ROOT, "healed to %.1f", health));
			return null;
		}
		lastTargetMs = elapsed;
		if (melee != null) {
			// A blaze that came into sword reach is fought from where the body stands.
			String end = tickEngagement(player, now);
			if (end == null || finished == null) return finished != null ? finished : TickResult.running(progress(player));
			return finished;
		}
		LivingEntity close = attackerInReach(player);
		if (close != null) {
			if (step != null) { step.cancel(player); step = null; }
			guardInput.release();
			engageMelee(player, close, elapsed, now);
			return TickResult.running(progress(player));
		}
		List<LivingEntity> shooters = new ArrayList<>();
		for (LivingEntity entity : player.level().getEntitiesOfClass(LivingEntity.class, player.getBoundingBox().inflate(radius),
				e -> e.getType() == mob && e.isAlive() && !e.isDeadOrDying()))
			if (ObservationVisibility.canSeeEntity(player, entity)) shooters.add(entity);
		// pursue:false: the body heals where it stands, shield up.
		if (recoverGoal == null && choices.mayReposition() && !shooters.isEmpty() && exposure(player, shooters, player.position()) > 0) {
			var seen = dev.agaminggod.arenaagents.server.perception.SeenTerrain.of(player);
			BlockPos here = player.blockPosition();
			double best = exposure(player, shooters, player.position()) * 10.0D;
			for (int dx = -RECOVER_RADIUS; dx <= RECOVER_RADIUS; dx++) for (int dz = -RECOVER_RADIUS; dz <= RECOVER_RADIUS; dz++) for (int dy = -1; dy <= 1; dy++) {
				BlockPos cell = here.offset(dx, dy, dz);
				if (cell.equals(here) || !standable(player, seen, cell)) continue;
				double score = exposure(player, shooters, Vec3.atBottomCenterOf(cell)) * 10.0D + Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.5D;
				if (score < best) { best = score; recoverGoal = Vec3.atBottomCenterOf(cell); }
			}
			if (recoverGoal == null && recoverLooks < 2) {
				// Nothing better among the cells it has seen: look behind, as a player backing off does, then weigh again.
				recoverLooks++;
				recoverLookUntilMs = elapsed + 700L;
				recoverLookYaw = player.getYRot() + 180.0F;
			}
			if (recoverGoal == null) recoverGoal = player.position();
			if (recoverNotes++ < 3) note(String.format(Locale.ROOT, "cover: %d of %d seen blazes see %s; %s", exposure(player, shooters, player.position()), shooters.size(),
					here.toShortString(), recoverGoal.equals(player.position()) ? "no seen cell within " + RECOVER_RADIUS + " blocks is better" : "to " + cell(recoverGoal)));
		}
		if (recoverGoal != null && player.position().distanceTo(recoverGoal) > 0.4D) {
			if (step == null || !recoverGoal.equals(stepGoal)) {
				if (step != null) step.cancel(player);
				step = new ServerNavigationController(recoverGoal, 0.4D, true, now, 8_000L, false).crouched(choices.sneak());
				stepGoal = recoverGoal;
			}
			guardInput.release();
			TickResult walked = tickStep(player, now);
			if (walked.state() == State.RUNNING) return TickResult.running(progress(player));
			step.cancel(player);
			step = null;
			if (walked.state() == State.SUCCEEDED) recoverMoves++;
			recoverGoal = player.position();
		}
		if (recoverLookUntilMs > elapsed) {
			applyGuard(player, new AgentInputState(0.0F, 0.0F, false, choices.sneak(), false, false, false,
					AgentInputStates.turnYaw(player.getYRot(), Mth.wrapDegrees(recoverLookYaw)), AgentInputStates.turnPitch(player.getXRot(), 15.0F),
					player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
			return TickResult.running(progress(player));
		}
		if (recoverLookUntilMs >= 0L) {
			recoverLookUntilMs = -1L;
			recoverGoal = null;
			return TickResult.running(progress(player));
		}
		// Shield toward the nearest seen blaze; the shot guard above turns it to a fireball on its way.
		LivingEntity nearest = null;
		for (LivingEntity shooter : shooters) if (nearest == null || shooter.distanceToSqr(player) < nearest.distanceToSqr(player)) nearest = shooter;
		float yaw = player.getYRot(), pitch = player.getXRot();
		if (nearest != null) {
			Vec3 delta = nearest.getEyePosition().subtract(player.getEyePosition());
			double flat = Math.sqrt(delta.x * delta.x + delta.z * delta.z);
			yaw = AgentInputStates.turnYaw(yaw, Mth.wrapDegrees((float) Math.toDegrees(Math.atan2(-delta.x, delta.z))));
			pitch = AgentInputStates.turnPitch(pitch, Mth.clamp((float) -Math.toDegrees(Math.atan2(delta.y, flat)), -90.0F, 90.0F));
		}
		applyGuard(player, new AgentInputState(0.0F, 0.0F, false, choices.sneak(), false, false, nearest != null, yaw, pitch,
				player.getInventory().getSelectedSlot(), InteractionHand.OFF_HAND));
		return TickResult.running(progress(player));
	}

	/**
	 * A seen blaze in line of sight that has glowed charged long enough that its volley is due (vanilla BlazeAttackGoal:
	 * 3 s charging, then three fireballs 0.3 s apart). A player sees the glow and raises the shield toward it before the
	 * shots: at 2-5 blocks a fireball lands faster than a shield raised on sight of it blocks (5 ticks). Null when none.
	 */
	private LivingEntity chargedBlazeDue(ServerPlayer player, long gameTick) {
		LivingEntity due = null;
		java.util.Set<UUID> charged = new java.util.HashSet<>();
		for (LivingEntity blaze : player.level().getEntitiesOfClass(LivingEntity.class, player.getBoundingBox().inflate(CHARGE_RANGE),
				e -> e.getType() == EntityTypes.BLAZE && e.isAlive() && !e.isDeadOrDying() && e.isOnFire())) {
			if (!ObservationVisibility.canSeeEntity(player, blaze)) continue;
			charged.add(blaze.getUUID());
			long since = chargedSince.computeIfAbsent(blaze.getUUID(), id -> gameTick);
			long age = gameTick - since;
			if (age >= CHARGE_DUE_TICKS && age <= CHARGE_DUE_TICKS + CHARGE_HOLD_TICKS
					&& (due == null || blaze.distanceToSqr(player) < due.distanceToSqr(player))) due = blaze;
		}
		chargedSince.keySet().retainAll(charged);
		return due;
	}

	/** Counted-item drops the body sees now are remembered where they lie (a landed rod it walks past or looks at). */
	private void rememberSeenDrops(ServerPlayer player) {
		for (ItemEntity item : player.level().getEntitiesOfClass(ItemEntity.class, player.getBoundingBox().inflate(radius),
				e -> e.isAlive() && e.getItem().is(untilItem)))
			if (ObservationVisibility.canSeeEntity(player, item)) dev.agaminggod.arenaagents.server.perception.ObservedDrops.remember(player, item);
	}

	/**
	 * Between engagements, with health to spare: a counted-item drop the body saw fall since the fight began and that
	 * landed on a ledge 1-3 blocks above its feet is fetched ({@link LedgeFetch}), once per drop, then the body walks
	 * back to the fighting spot. Null when there is no such trip to run.
	 */
	private TickResult tickLedge(ServerPlayer player, long now, long elapsed) {
		if (ledge != null) {
			ledgeTick = player.level().getGameTime();
			String done = ledge.tick(player, now);
			lastTargetMs = elapsed;
			if (done == null) return TickResult.running(progress(player));
			String failure = ledge.failureCode();
			ledge = null;
			if (failure != null) return stop(player, TickResult.failed(failure, done + "; the fight handed back instead of releasing sneak", progress(player)));
			ledgeRods += Math.max(0, count(player, untilItem) - heldBeforeLedge);
			note("ledge: " + done);
			String outcome = done.substring(done.indexOf(": ") + 2).replaceAll("\\d+(\\.\\d+)?,\\s?-?\\d+(,\\s?-?\\d+)?", "#").replaceAll("\\d+", "#");
			ledgeOutcomes.merge(outcome.length() > 90 ? outcome.substring(0, 90) : outcome, 1, Integer::sum);
			return TickResult.running(progress(player));
		}
		if (player.getHealth() < Math.max(10.0F, fleeAtHealth + 4.0F) || player.isOnFire()) {
			ledgeLowHealth++;
			return null;
		}
		Vec3 back = spot != null ? spot : center;
		for (UUID id : dev.agaminggod.arenaagents.server.perception.ObservedDrops.remembered(player)) {
			if (ledgeTried.contains(id)) continue;
			var drop = dev.agaminggod.arenaagents.server.perception.ObservedDrops.recall(player, id);
			if (drop == null || !drop.item().equals(untilItemId)) continue;
			if (!(((net.minecraft.server.level.ServerLevel) player.level()).getEntity(id) instanceof ItemEntity item) || !item.isAlive()) continue;
			LedgeFetch trip = LedgeFetch.plan(player, id, untilItem, back, this::mayModify, count(player, untilItem), now);
			if (trip == null) {
				if (LedgeFetch.waiting) continue;
				ledgeTried.add(id);
				if (ledgeRefused.add(id)) {
					note("ledge: no trip for drop " + id + ": " + LedgeFetch.refusal);
					ledgeRefusals.merge(LedgeFetch.refusal.replaceAll(" (under|at|\\().*", ""), 1, Integer::sum);
				}
				continue;
			}
			ledgeTried.add(id);
			return startLedge(player, trip, elapsed);
		}
		if (unseenKills.size() >= LEDGE_UNSEEN_KILLS) {
			Vec3 at = unseenKills.get(unseenKills.size() - 1);
			LedgeFetch trip = LedgeFetch.plan(player, null, at, untilItem, back, this::mayModify, count(player, untilItem), now);
			if (trip == null && LedgeFetch.waiting) return null;
			if (trip == null) {
				// Not over a ledge (the floor's own drops are looked for after each kill): forget the oldest.
				unseenKills.remove(unseenKills.size() - 1);
				return null;
			}
			unseenKills.clear();
			return startLedge(player, trip, elapsed);
		}
		return null;
	}

	private TickResult startLedge(ServerPlayer player, LedgeFetch trip, long elapsed) {
		ledge = trip.crouched(choices.sneak());
		ledgeTick = player.level().getGameTime();
		ledgeTrips++;
		heldBeforeLedge = count(player, untilItem);
		if (look != null) { look.cancel(player); look = null; }
		note("ledge trip: " + trip.describe());
		lastTargetMs = elapsed;
		return TickResult.running(progress(player));
	}

	private boolean mayModify(ServerPlayer body, BlockPos pos) {
		return protection.mayModifyBlock(body, (net.minecraft.server.level.ServerLevel) body.level(), pos);
	}

	private void releaseGuard() {
		releaseGuard(false);
	}

	private void releaseGuard(boolean terminal) {
		// Backing off to heal holds the same lease for its raised shield: releasing it each tick would restart the raise
		// (a vanilla shield blocks only 5 ticks after it goes up). The call's end releases it always.
		if (!holdsGuardLease(terminal, recoverSinceMs >= 0L, guardHeld, inFire)) guardInput.release();
		guardHeld = false;
		inFire = false;
		fireExit = null;
		fireContactTicks = 0;
	}

	private TickResult tickStep(ServerPlayer player, long now) {
		stepTick = player.level().getGameTime();
		return step.tick(player, now);
	}

	/**
	 * A short walk no branch ticked for a second is put down before its navigation lease expires (40 idle ticks,
	 * LeasedServerInputController.LEASE_TIMEOUT_TICKS); a later tick on an expired lease threw "input lease is no
	 * longer active" once cover selection ran (review-3 floor fixture).
	 */
	static boolean stepIdle(long gameTick, long stepTick) {
		return gameTick - stepTick > 20L;
	}

	/** Whether the combat input lease stays held: only between ticks of backing off to heal, never at the call's end. */
	static boolean holdsGuardLease(boolean terminal, boolean recovering, boolean guardHeld, boolean inFire) {
		return !terminal && recovering && !guardHeld && !inFire;
	}

	/** Whether cover is weighed this tick: the first time, then every {@link #COVER_EVERY_TICKS}. */
	static boolean coverDue(long gameTick, long lastCheckTick) {
		return lastCheckTick == COVER_NEVER || gameTick - lastCheckTick >= COVER_EVERY_TICKS;
	}

	/** The nearest seen exit from a fire cell: level, no gap, no lava first; kept until reached. */
	private Vec3 fireExit(ServerPlayer player) {
		if (fireExit != null && player.position().distanceToSqr(fireExit) > 0.04D) return fireExit;
		fireExit = null;
		Vec3 fallback = null;
		for (HazardExits.Exit exit : HazardExits.scan(player)) {
			Vec3 at = new Vec3(exit.x() + 0.5D, exit.y(), exit.z() + 0.5D);
			if (exit.lavaCells() > 0) continue;
			if (fallback == null) fallback = at;
			if (exit.up() == 0 && exit.gaps() == 0 && !exit.unseen()) { fireExit = at; break; }
		}
		if (fireExit == null) fireExit = fallback;
		return fireExit;
	}

	/**
	 * Between engagements, with two or more seen blazes having a clear line to the body's eyes: walk to the seen standing
	 * cell within {@link #COVER_RADIUS} blocks that the fewest of them see (a wall or pillar between), nearest first. A
	 * blaze that cannot see its target flies toward it, so the fight comes to the body one blaze at a time. Null when
	 * staying; a running tick while walking.
	 */
	private TickResult takeCover(ServerPlayer player, long now, long gameTick) {
		if (coverGoal == null) {
			if (!coverDue(gameTick, coverCheckTick)) return null;
			coverCheckTick = gameTick;
			List<LivingEntity> shooters = new ArrayList<>();
			for (LivingEntity entity : player.level().getEntitiesOfClass(LivingEntity.class, player.getBoundingBox().inflate(radius),
					e -> e.getType() == mob && e.isAlive() && !e.isDeadOrDying()))
				if (ObservationVisibility.canSeeEntity(player, entity)) shooters.add(entity);
			if (shooters.size() < 2) return null;
			BlockPos here = player.blockPosition();
			int exposedHere = exposure(player, shooters, Vec3.atBottomCenterOf(here));
			if (exposedHere < 2) return null;
			var seen = dev.agaminggod.arenaagents.server.perception.SeenTerrain.of(player);
			BlockPos best = null;
			double bestScore = exposedHere * 10.0D;
			for (int dx = -COVER_RADIUS; dx <= COVER_RADIUS; dx++) for (int dz = -COVER_RADIUS; dz <= COVER_RADIUS; dz++) for (int dy = -1; dy <= 1; dy++) {
				BlockPos cell = here.offset(dx, dy, dz);
				if (cell.equals(here) || !standable(player, seen, cell)) continue;
				double score = exposure(player, shooters, Vec3.atBottomCenterOf(cell)) * 10.0D + Math.sqrt(dx * dx + dy * dy + dz * dz);
				if (score < bestScore) { bestScore = score; best = cell; }
			}
			if (best == null) return null;
			coverGoal = Vec3.atBottomCenterOf(best);
			note(String.format(Locale.ROOT, "cover: %d of %d seen blazes see %s; moving to %s", exposedHere, shooters.size(), here.toShortString(), best.toShortString()));
		}
		if (step == null || !coverGoal.equals(stepGoal)) {
			if (step != null) step.cancel(player);
			step = new ServerNavigationController(coverGoal, 0.4D, false, now, 6_000L, false).crouched(choices.sneak());
			stepGoal = coverGoal;
		}
		TickResult result = tickStep(player, now);
		if (result.state() == State.RUNNING) return TickResult.running(progress(player));
		step.cancel(player);
		step = null;
		if (result.state() == State.SUCCEEDED) coverMoves++;
		else note("cover walk to " + cell(coverGoal) + " " + result.reasonCode());
		coverGoal = null;
		return null;
	}

	/** Seen blazes with a clear block line from their eyes to the body's eyes standing at {@code feet}. */
	private static int exposure(ServerPlayer player, List<LivingEntity> shooters, Vec3 feet) {
		Vec3 eye = feet.add(0.0D, player.getEyeHeight(), 0.0D);
		int exposed = 0;
		for (LivingEntity shooter : shooters)
			if (player.level().clip(new ClipContext(shooter.getEyePosition(), eye, ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, shooter)).getType() == HitResult.Type.MISS)
				exposed++;
		return exposed;
	}

	/** A seen cell with a seen full floor and two seen open cells, no fluid and no fire. */
	private static boolean standable(ServerPlayer player, dev.agaminggod.arenaagents.server.perception.SeenTerrain.Reader<net.minecraft.world.level.block.state.BlockState> seen, BlockPos cell) {
		var floor = seen.known(cell.getX(), cell.getY() - 1, cell.getZ());
		if (floor == null || !floor.isCollisionShapeFullBlock(player.level(), cell.below()) || HazardExits.hotFloor(floor)) return false;
		for (BlockPos at : new BlockPos[] {cell, cell.above()}) {
			var state = seen.known(at.getX(), at.getY(), at.getZ());
			if (state == null || !state.getCollisionShape(player.level(), at).isEmpty() || !state.getFluidState().isEmpty() || state.is(BlockTags.FIRE)) return false;
		}
		return true;
	}

	private TickResult walkBack(ServerPlayer player, long now) {
		if (walk == null) {
			if (player.position().distanceTo(spot) <= SPOT_SLACK) return TickResult.running(progress(player));
			walk = new ServerNavigationController(spot, 1.0D, false, now, 20_000L, true).crouched(choices.sneak());
		}
		TickResult result = walk.tick(player, now);
		if (result.state() == State.RUNNING) return TickResult.running(progress(player));
		walk = null;
		if (result.state() == State.SUCCEEDED) { walkFailures = 0; return TickResult.running(progress(player)); }
		note("walk back to " + cell(spot) + " " + result.reasonCode() + ": " + result.message());
		if (++walkFailures >= 2)
			return stop(player, TickResult.failed("SPOT_UNREACHABLE", "Two walks back to " + cell(spot) + " failed: " + result.reasonCode(), progress(player)));
		return TickResult.running(progress(player));
	}

	private void note(String line) {
		log.add(line.length() > 360 ? line.substring(0, 360) + "..." : line);
	}

	private double progress(ServerPlayer player) {
		if (startCount < 0) return 0.0D;
		int gained = count(player, untilItem) - startCount;
		int needed = Math.max(1, untilCount - startCount);
		return Math.max(0.0D, Math.min(0.99D, gained / (double) needed));
	}

	private TickResult stop(ServerPlayer player, TickResult result) {
		if (finished != null) return finished;
		cancelParts(player);
		int held = count(player, untilItem);
		StringBuilder text = new StringBuilder(result.message());
		if (roof) text.append(String.format(Locale.ROOT, "; roof: %s", roofed || roofBuilds > 0 ? roofBuilds + " build" + (roofBuilds == 1 ? "" : "s")
				+ " at " + roofCenter.toShortString() + " doorway " + roofOpening.getSerializedName() + " (" + roofItem + ")" + (lintelPlaced ? "" : ", lintel missing") + (breakOuts > 0 ? ", " + breakOuts + " walk" + (breakOuts == 1 ? "" : "s") + " out to collect" : "") : "not built"));
		text.append(String.format(Locale.ROOT, "; %s %s: %d kill%s, %s %d -> %d (gained %d, asked %d), %d arrow%s used, %d bow and %d sword engagement%s",
				via.equals("fight_until") ? "fight_until" : via + " count", mobId, kills, kills == 1 ? "" : "s", untilItemId, Math.max(0, startCount), held, held - Math.max(0, startCount), untilCount,
				Math.max(0, startArrows - arrows(player)), startArrows - arrows(player) == 1 ? "" : "s", bowEngagements, meleeEngagements,
				bowEngagements + meleeEngagements == 1 ? "" : "s"));
		text.append(String.format(Locale.ROOT, "; fire: %.1f s burning, %d step%s off fire; shield: raised %d time%s at shots, %d blocked; cover: %d move%s; looked for %d unseen drop%s, found %d",
				burnTicks / 20.0D, fireSteps, fireSteps == 1 ? "" : "s", guards, guards == 1 ? "" : "s", shieldBlocks, coverMoves, coverMoves == 1 ? "" : "s",
				dropLooks, dropLooks == 1 ? "" : "s", dropsFound));
		if (ledgeTrips > 0 || !ledgeRefusals.isEmpty()) text.append(String.format(Locale.ROOT, "; ledge: %d trip%s up for drops seen landing above, %d picked up%s",
				ledgeTrips, ledgeTrips == 1 ? "" : "s", ledgeRods, ledgeRefusals.isEmpty() ? "" : ", not tried " + ledgeRefusals));
		if (!ledgeOutcomes.isEmpty()) text.append("; ledge trips ended: ").append(ledgeOutcomes);
		if (firePunches > 0) text.append("; punched out fire underfoot with no way off it");
		if (chargeGuards > 0) text.append(String.format(Locale.ROOT, "; shield up %.1f s toward charged blazes before their volleys", chargeGuards / 20.0D));
		if (recovers > 0) text.append(String.format(Locale.ROOT, "; backed off to heal %d time%s (%.0f s, %d move%s to cover)", recovers, recovers == 1 ? "" : "s",
				recoverMs / 1000.0D, recoverMoves, recoverMoves == 1 ? "" : "s"));
		if (ledgeLowHealth > 0) text.append(String.format(Locale.ROOT, "; ledge trips waited %.1f s on health or burning", ledgeLowHealth / 20.0D));
		if (policySwitches > 0) text.append(String.format(Locale.ROOT, "; targetPolicy %s switched target %d time%s", choices.targetPolicy().wireName(),
				policySwitches, policySwitches == 1 ? "" : "s"));
		if (reachTurns > 0) text.append(String.format(Locale.ROOT, "; bow put down %d time%s for an attacker in sword reach", reachTurns, reachTurns == 1 ? "" : "s"));
		if (swordTurns > 0) text.append(String.format(Locale.ROOT, "; sword turned %d time%s from a blaze out of reach to an attacker in sword reach", swordTurns, swordTurns == 1 ? "" : "s"));
		if (bowSkipsOverDrop > 0 || killsOverDrop > 0) text.append(String.format(Locale.ROOT,
				"; drops: %d bow shot%s held for a target over unwalkable ground, %d kill%s over unwalkable ground (drop lost)",
				bowSkipsOverDrop, bowSkipsOverDrop == 1 ? "" : "s", killsOverDrop, killsOverDrop == 1 ? "" : "s"));
		if (!hurts.isEmpty()) text.append("; hurt by (kind while doing): ").append(hurts);
		if (mob == EntityTypes.ENDERMAN && !roofed && stares + holds + attackerSoftEnds > 0)
			text.append(String.format(Locale.ROOT, "; endermen: stared at %d calm (%d provoked), waited %d time%s for an angry one to come, kept on %d that left reach still hunting you",
					stares, staresProvoked, holds, holds == 1 ? "" : "s", attackerSoftEnds));
		if (!endings.isEmpty()) text.append("; endings: ").append(endings);
		int from = Math.max(0, log.size() - 4);
		if (!log.isEmpty()) text.append("; last: ").append(String.join(" | ", log.subList(from, log.size())));
		finished = new TickResult(result.state(), result.reasonCode(), text.toString(), result.state() == State.SUCCEEDED ? 1.0D : result.progress());
		return finished;
	}

	private void cancelParts(ServerPlayer player) {
		releaseGuard(true);
		stanceInput.release();
		if (melee != null) melee.cancel(player);
		if (volley != null) { volley.cancel("fight_until stopped"); volley.cleanup(); }
		if (walk != null) walk.cancel(player);
		if (look != null) look.cancel(player);
		if (building != null) building.cancel(player);
		if (step != null) step.cancel(player);
		if (collector != null) collector.cancel(player);
		if (ledge != null) ledge.cancel(player);
		ledge = null;
		building = null;
		step = null;
		collector = null;
		look = null;
		melee = null;
		volley = null;
		walk = null;
	}

	@Override
	public void cancel(ServerPlayer player) {
		cancelParts(player);
	}

	private static String cell(Vec3 at) {
		return String.format(Locale.ROOT, "%d,%d,%d", (int) Math.floor(at.x), (int) Math.floor(at.y), (int) Math.floor(at.z));
	}

	static int count(ServerPlayer player, Item item) {
		int total = 0;
		for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (stack.is(item)) total += stack.getCount();
		}
		return total;
	}

	private static int arrows(ServerPlayer player) {
		int total = 0;
		for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (stack.getItem() instanceof ArrowItem) total += stack.getCount();
		}
		return total;
	}

	private static boolean hasBow(ServerPlayer player) {
		if (player.getOffhandItem().getItem() instanceof BowItem || player.getMainHandItem().getItem() instanceof BowItem) return true;
		for (int slot = 0; slot < 9; slot++) if (player.getInventory().getItem(slot).getItem() instanceof BowItem) return true;
		return false;
	}

	private static boolean bowReady(ServerPlayer player) {
		return hasBow(player) && (player.hasInfiniteMaterials() || arrows(player) > 0);
	}
}
