# Decision evals

A fast check of the agent's decisions that needs no Minecraft server. Each case freezes one moment of a recorded game
as raw state (server observations, goal, plan, task memory). Every build renders that state through its own
production code, sends the result to the real model through the production provider path, captures the tool calls it
makes without executing them, and grades them. The render is the exact production rendering of the reconstructed
supported state, not a byte copy of the original recorded wake: earlier turns are synthetic, and supplied state the
coordinator cannot be given is listed per render in `replay.unreplayed` (see "Replay coverage" below). Each moment is
asked several times and graded as a rate, and a candidate build is compared with a baseline build per cause-class
family.

Headless game runs stay the test for what this cannot see: pathing, combat execution and long-game memory.

Code: `coordinator/src/decision-eval/` (schema, renderer, runner, predicates, judge, statistics, report, pricing).
Train cases: `coordinator/test/fixtures/decision-eval/train/<family>.json`. Tests: `coordinator/test/decision-eval-*.test.mjs`.

## Run it

From `coordinator/`:

```sh
# Compare this checkout with a baseline commit (full train set, 3 samples per case per build)
npm run eval:decisions -- --baseline main

# Quick check, the PR gate: 63 cases (3 per original family, 1 per progression family), 6 samples per case, 6 to confirm
npm run eval:decisions -- --baseline main --quick

# Per-push preflight, explicitly weaker: the same 63 cases with 4 samples per case, 6 to confirm
npm run eval:decisions -- --baseline main --preflight

# Two commits, neither checked out
npm run eval:decisions -- --baseline 86446c09 --candidate 9d44450c

# A pull request: base vs head in temporary worktrees, harness and cases from the PR head
npm run eval:decisions:pr -- --pr 123 --quick
```

What happens:

1. Each build is resolved. This checkout runs in place. A commit is checked out into a temporary worktree
   (with its own `npm ci`), and this checkout's harness (`coordinator/src/decision-eval/`, `run.mjs`) is copied in,
   so the harness imports that build's production coordinator, instructions and tools. Another checkout runs in
   place only if it carries the same harness; otherwise pass it as a commit.
2. Each build renders every case with its own code and asks the model `--samples` times per case
   (`scripts/decision-eval/run.mjs`), in parallel (`--concurrency`, default 32, split by the work each arm has left).
3. Both arms are graded and compared here (`scripts/decision-eval/compare.mjs`): the screen.
4. If answers came back ungraded (judge outage), grading runs once more; cached verdicts are reused.
5. If samples errored (no decision), those cases are asked again at sample indexes no earlier stage used, and a new
   screen is computed on the completed set (stage `redo`, report `screen-2`).
6. If the screen flags a drop (INCONCLUSIVE), the flagged cases are asked again with fresh sample indexes
   (`--confirm-samples`, default 3). eval writes `confirm-manifest.json` listing every required (arm, case, sample);
   compare refuses duplicates, screen samples reused as confirmation and samples outside the manifest, and the
   verdict stays INCONCLUSIVE unless each flagged unit has 90% of its required samples answered and graded.
   The screen has a plan too: compare reads each native run file's declared samples (`config.sampleCounts` from
   `config.sampleOffset`, or `config.plannedIdentities` for a merged screen-2) or a `--screen-manifest` file
   (`{ "required": [{ "arm", "caseId", "sample" }] }`). A declared sample with no row counts as missing evidence, not
   as a smaller plan. Every row from any input file, in any order, must be a declared identity of its arm (from a
   native file or the manifest); an undeclared row or an identity declared twice refuses the input, so coverage is
   always over exactly the declared identities. An arm with any input that declares no plan (a JSONL or array file,
   even an empty one, or a native file without a plan) has an unknown plan unless a manifest is given, and an
   unknown plan decides nothing: the verdict is INCONCLUSIVE, never PASS or FAIL, also after a confirmation.
   Confirmation inputs follow the same rules against `--confirm-manifest` or, without it, their own native
   declarations, and may not declare or supply a screen identity. A case id outside the corpus, declared or supplied,
   refuses the input. All of this is one function, `validateEvidence` in `coordinator/src/decision-eval/evidence.mjs`;
   grading and the statistics accept only the evidence it returns.
7. `<out>/eval.md` and `<out>/eval.json` report each stage on its own (samples asked, model calls, cache, billed
   spend, wall, concurrency, prompt-cache read share, errors), the first screen verdict, the new screen and the
   confirmation separately, and full wall time next to the model and grading phases. `<out>/screen/` (and
   `screen-2/`, `final/`) hold the full comparison reports.

Exit codes: 0 PASS, 1 FAIL, 2 setup or run error, 3 INCONCLUSIVE (only with `--no-confirm`).
A comparison that exits with anything other than 0, 1 or 3 (for example a refused input) is a run error for the whole
check. eval removes each stage's previous report before comparing, and the `eval.json` of an earlier run at start, and
uses a report only if it carries this run's id, the SHA-256 of the files it compared and a verdict matching the exit
code, so a reused `--out` cannot lend an old verdict.

Useful options: `--ids a,b` (only these cases), `--samples n`, `--judge off`, `--judge-max-usd 5`,
`--budget-usd x` (one player budget for the whole check: every arm, stage and retry appends its spend to
`<out>/budget-ledger.tsv`; concurrent workers can overshoot by at most one batch), `--out <dir>` (default OS temp),
`--cache-dir <dir>` (default `~/.cache/arena-decision-eval`), `--cache-candidate`, `--sample-offset n`,
`--keep-worktrees`, `--cache-epoch <text>`, `--import-cache <dir> --import-runtime <version>`. Judge spend is capped
separately by `--judge-max-usd` per grading pass (checked when a judge call gets its slot, counting calls in flight).

**Budget headroom.** With `--budget-usd`, eval estimates each stage before asking anything (a case's first fresh
sample writes its wake to the prompt cache, about $0.075; later samples about $0.02; plus 15%; override with
`DECISION_EVAL_FIRST_SAMPLE_USD` / `DECISION_EVAL_REPEAT_SAMPLE_USD`). The screen may use the budget minus
`--confirm-reserve` (default 30%) and refuses to start when its estimate does not fit; a confirmation or redo that the
remaining budget cannot fund is skipped with that reason and the verdict stays INCONCLUSIVE. The estimate is
conservative (measured quick run: $11.66 estimated, $8.36 billed).
Run `node scripts/decision-eval/eval.mjs --help` for the list.
`run.mjs --probe` is a diagnostic, never a gate: reads, setup and notes get a fixed skip reply and the sample continues to
the first world action or intent (not production-faithful; give it its own `--cache-epoch`). Without it a case ends at
the first accepted call, which for route decisions is usually a read (see `extra/nether-route.json`).

### Cost and caching

- **Baseline cache.** Finished samples are stored under `--cache-dir`, keyed by what decides the answers: the build
  fingerprint (commit, dirty diff outside the harness, rendered instructions and tools), the renderer and the runner's
  session protocol version (`RUNNER_PROTOCOL`; multi-step cases also hash the canned-reply code), the case's recorded
  state and steps plus this build's rendered wake, the model profile, the effective call limit (`--max-calls`), the
  provider CLI path and the version it reports, a cache epoch (`--cache-epoch`, bump it to retire everything, for
  example if a model alias may have moved) and the sample index. Grading changes (predicates, rubrics, judge,
  statistics) never invalidate samples. `--import-cache <dir> --import-runtime <version>` reuses an older cache's
  samples only where the build commit (clean), prefix, wake bytes, profile, view-id mode, call limit and CLI version
  provably match and the sample sent exactly its render; never for multi-step cases. A PR whose base did not change only pays for the candidate. Confirm runs use sample
  indexes after the screen's, so a cached screen sample never decides a confirm stage. The candidate is cached only
  with `--cache-candidate` (a re-run of the same commit).
- **Prompt cache.** Eval sessions name observation views with one fixed id (`EVAL_VIEW_SESSION`) instead of a random
  id per session, so repeated samples of a case send identical bytes and read the wake from the provider's prompt
  cache. Production keeps the random id; builds older than the option get the same effect at the adapter boundary.
  `--random-view-id` restores the production id (used to measure the difference).
- **Judge cache.** Judge verdicts are cached in `<cache-dir>/judge-cache.jsonl` by case (id and recorded state), the
  hash of the production-normalized accepted trajectory, the rubric and the judge model, so identical answers from any
  arm, sample or run are judged once.
- Prices are proxies from `coordinator/src/decision-eval/pricing.mjs` (Claude rows equal the production estimate).

### The quick check

The quick subset is 3 cases from each of the 18 original train families plus 1 from each of the 9 progression
families (63 cases, `quick.json`), asked 6 times per build,
and a flagged family is confirmed with 6 fresh samples. `simulate-verdict.mjs` reads these shapes from the committed
fixtures. In 3,000 simulated trials it catches a 50-point drop in one family 69.7% of the time (6 screen / 3 confirm:
51.3%) and a 10-point drop in every case 88.3%, with 0.7% false FAIL. These are synthetic independent-sample rates,
not guarantees, and they do not model source diversity or grading errors. The full set (18 x 8, 87% for the
single-family drop) gates merges; quick (with a cached baseline) is the PR gate.
Those figures are for the 18-family set. With the progression families the simulator models 27 families of 2 quick
cases (it uses the mean family size) and 27 x 8 for the full set, 2,000 trials: quick catches the 50-point single-family
drop 30.8% of the time and a 10-point drop in every case 90.8%, with 0.6% false FAIL; the full set 83.7% and 98.6%.
One quick case per progression family keeps them in the PR gate cheaply; a single case can flag only a large swing (6/6
to 0/6 flags, 3/6 to 0/6 passed in a synthetic control), and the simulator approximates the uneven quick family sizes
by their mean. The full train set is the check for a progression family.

`--preflight` is an explicitly weaker per-push check: the same 63 cases with 4 screen samples and 6 confirmation
samples. In the same 3,000-trial simulation it catches the 50-point single-family drop 41.8% of the time (quick:
69.7%) and a 10-point drop in every case 78.5% (quick: 88.3%), with 0.3% false FAIL. It costs about two thirds of
quick on the candidate side (216 instead of 324 samples). Measured once (fix round 3, baseline from the cache):
216 candidate samples, 330 model calls, $3.66 player and $0.62 judge, 143 s wall (93 s asking, 48 s grading).
Use it to catch large regressions early, never as the merge or PR decision.

Measured (fix round 2, Claude Opus 5.5 low, baseline from the cache): the candidate side asked 324 samples (514 model
calls) for $8.05; the complete check took 196 s wall (133 s asking, 61 s grading) and $8.98 including judge. This
misses the brief's couple-of-dollars, one-to-two-minute target. `--quick --samples 2` is a cheaper low-power smoke
option (2.9% detection of the same drop).

### Replay coverage

A render reproduces: the recorded observations; plan and intent (production taskPlan tool); model-authored task
memory (taskMemory tool); recorded deaths and stations (fed through the build's own TaskMemoryStore into the memory
directory the coordinator loads); and action results, which production reads from each replayed observation's
`lastResult`. Not reproduced, and listed in `replay.unreplayed`: results older than the replayed observations, memory
from another world, and the recorded `now` header (recomputed, never copied). Earlier wakes end as synthetic completed
turns, not the recorded decisions. Run summaries count the cases with unreplayed state (`unreplayedStateCases`) and
each kind (`unreplayedByKind`).

What an unreplayed older result costs (measured 2026-10-23 on the 60 train cases that have one, build aa891468): the
wake a fresh session receives lists only the current facts, task memory and the failure carry-over, so for 44 of them
replaying the older results as earlier observations changed no byte, for 8 it changed only task-memory ages ("told 1s"
instead of "told 23s"), and for 8 it added an earlier failure line. Replaying them is not a fix: the recorded turns that
answered those results are not replayed, so an answered failure comes back as unanswered (iron-sourcing-06 would open
with "Action failed: move_to REACHED_FRONTIER" although the recorded player had already moved on).

## Read a report

- **Verdict.** FAIL needs a whole family (Holm-adjusted over every planned family) or the overall set to drop with
  p < 0.005 and at least 10 points (overall: 5). Coverage comes first: a unit decides only when each arm has at most
  20% (family) or 10% (overall) of its planned samples errored or ungraded, AND every planned case has at least half
  of its planned samples (minimum one) answered and graded in both arms. An incomplete unit enters Holm at p = 1 and
  cannot fail or flag; a complete family can still FAIL while another is incomplete, but PASS needs every unit
  complete. Confirmation applies the same per-arm and per-case rule (90% per arm) with Holm over every planned unit, and
  a confirmation PASS cannot override undecided screen units. PASS means no detected relative regression, not that
  every case meets its threshold; known weak families can pass at 0%.
- **Source moments.** Every case has `source.sourceMomentId` (recorded trace plus observation identity; derived
  variants share their source's id). A source moment gets a total weight of one and a sample budget of `--samples`,
  split across its variants before sampling; the exact test uses those weights. Reports show rows and sources
  separately, so authoring another variant never adds an independent situation. Per-case rows stay visible, so a
  local change in one source moment is still listed.
- **Grades.** Predicates decide only unambiguous outcomes: hard bad when the recorded facts make the call clearly wrong
  (staying in lava, an identical retry with the cause unrepaired, looting while drowning, collecting an item that
  cannot fit), hard good for the canonical repair verified against the recorded cause. Everything else goes to the
  cross-family rubric judge; every case carries a rubric with its recorded facts. Only accepted calls are graded; calls
  the production normaliser rejected stay as diagnostics. An answer the judge could not grade (error, missing
  verdict, judge off, no rubric) is `ungraded`, never a neutral player answer. `--judge off` is a diagnostic: only
  hard decisions are graded, so units that need the judge cannot decide.
- **What the judge sees.** The judge gets the recorded moment, identical for both builds and never the build identity:
  goal, plan and intent; the day clock with tick and phase (day, dusk, night, dawn) and whether a bed works; position,
  health, armor, food, air and hazards; hand, held item and open menu; the ray target and the running action; the
  full slot-indexed inventory; the 32 nearest blocks with coordinates; entities, sounds heard, sightings, threats,
  the death screen and remembered deaths; since projection v4 also entity velocity, bounds, body part and item id, the 16
  nearest landmarks, and whether each observation section is complete or sampled (so an unlisted entity reads as
  unobserved, not absent). Projection truncation also marks a complete server section as sampled. The recorded cause (last result and recent results) is a separate section:
  it is ground truth, not part of what the player was shown. For multi-step cases each later step shows the recorded
  reply the answer actually received. `JUDGE_PROJECTION_VERSION` is part of every judge cache key, so verdicts given
  on an older view are never reused.
- **Without a baseline.** A candidate-only comparison checks absolute thresholds with the same coverage rule: a case
  fails only on complete evidence (at least half its planned samples answered and graded), and an outage or ungraded
  answers give INCONCLUSIVE, never PASS.
- **Canned replies.** A recorded reply is given only when the submitted call is one single action that is materially
  the recorded command (same type and behaviour arguments; only `timeoutMs` is ignored). Anything else ends the sample
  off script.
- Single cases never fail the screen: with 3 samples a 3/3 to 0/3 swing happens by chance about once in 150
  borderline cases. They are listed for review instead, and re-asked only when the screen is INCONCLUSIVE
  for another reason; a PASS screen does not re-ask them.
- **Families table** (worst first): candidate and baseline mean case rates, delta in points, p(worse) and its
  Holm-adjusted value, and how many cases sit below their threshold.
- **Regressions** lists `regression-suspect` and `below-threshold-new` cases; read their samples in
  `graded-samples.jsonl` and the wake the model saw in `spot-check/spot-check.md`.
- **Cost and time** gives per-arm spend, wall time, latency and concurrency; `eval.md` adds samples taken from the
  cache and the prompt-cache read share.
- Simulated error rates of the rule (false alarms, detection power by drop size) are in the grade agent's notes and
  reproducible with `node scripts/decision-eval/simulate-verdict.mjs`.

## Add a case family from a new failure

Failures enter as cause-class families of 5 to 10 variants (different mob, distance, health, item, biome), never one
copied moment. The aim is to be good at the class, not the scenario.

1. **Capture moments** from the recorded traces of the failing run (and any other runs with the same cause):
   `node scripts/decision-eval/capture.mjs --root <Projects dir> --out moments.jsonl <trace dirs>`.
   Triggers include damage, low health or food, failed actions, lava/fire/drowning/fall hazards, hostiles near,
   nightfall, no progress, plan step changes and stalls, full inventory, respawn and threats right after an escape.
   Progression triggers: a new milestone item (logs through eyes of ender; captured on the first observation with no
   running action, where the player decides what is next), a structure block coming into sight (nether bricks,
   spawner, obsidian, portal, end portal frame), a dimension change, and an enderman or blaze coming within 32 blocks.
2. **Write the family file** `coordinator/test/fixtures/decision-eval/train/<family>.json`:
   `{ "family", "causeClass", "rationale", "cases": [...] }`. The rationale says what a vanilla player does here and
   why. Each case keeps the recorded raw observation (plus a few earlier ones in `previousObservations`), the goal,
   plan and task memory, and `source` provenance (trace, line, observation SHA-256). A derived variant (for example
   a creeper moved to 6 blocks) records `source.derived` with its edits; never derive canned replies.
3. **Expectations.** "Good" must mean a sensible response to the situation, not a tool name. Prefer predicates
   (`expect.good` / `expect.bad`, schema `schema.mjs`, v1.3 situation keys in `predicates.mjs`): real escape progress
   off the hazard or away from the threat, freeing a slot with a low-value stack, a response that addresses the
   recorded failure reason (a repaired approach followed by a retry is not a bad retry). Reads, chat and notes are
   never good by themselves. Only accepted calls are graded. Use `expect.judge.rubric` only where predicates cannot
   decide. Set `threshold` (0.5 to 0.67 so far).
   Include in `previousObservations` the recorded observations that carry the recent results as `lastResult`
   (`source.resultObservationLines`), so those results reach the wake. A derived case records
   `source.derived.invariants`; `test/decision-eval-fixtures.test.mjs` checks that every redundant field (held item,
   tag counts, menu pages, hotbar flags, earlier observations) agrees with the edit.
4. **Multi-step cases** add `steps[].canned[]`: a `when` predicate for the call and the `result` recorded right after
   that moment for the same command. An off-script call ends the sample; the harness never invents a game reply.
5. Mark three cases `"quick": true` and add their ids to `quick.json`.
6. Check: `node scripts/decision-eval/run.mjs --cases <your file> --dry-run` (every case renders on this build),
   `node scripts/decision-eval/verify-provenance.mjs --root <Projects dir> <your file>`, and
   `node --test test/decision-eval-corpus.test.mjs test/decision-eval-fixtures.test.mjs` in `coordinator/`.
7. Run the family live against the build that showed the failure and a build that should not:
   `npm run eval:decisions -- --baseline <good build> --candidate <bad build> --ids <family ids>`. A family that
   cannot tell them apart needs better predicates or more variants.

## Progression families

Nine families (58 train cases: 34 recorded and 24 derived, from 55 source moments) check the decisions on the route to the dragon (north star: any agent beats the game on a random seed
within a few hours). Recorded moments are used wherever a run reached the stage; later stages are derived.

| Family | Stage | Source |
|---|---|---|
| `progression-next-milestone` | have X, what next (stone pickaxe through iron gear, bucket, food, bed) | recorded (PAIR1/PAIR2 full games) |
| `progression-efficiency` | use what is held, close a stalled step, do not over-gather | recorded (no-progress and stalled-step moments) |
| `nether-fortress-search` | fortress in sight or not | recorded (S1 Nether scenario runs) |
| `blaze-fight` | blaze near, healthy, low, after a failed fight | recorded (S1) |
| `enderman-pearl-hunt` | enderman near, early versus pearls needed | recorded, plus derived late-stage twins of the same moments |
| `late-stage-next-step` | portal materials, rods, pearls, bucket, diamond pickaxe, flint and steel | derived stage kits |
| `transition-prep` | before the Nether or the End: unprepared versus ready | derived stage kits |
| `eye-of-ender-stronghold` | throw, follow the flight, pick up a dropped eye | derived (kit plus the eye entity) |
| `end-fight-basics` | crystals with and without a bow, perched dragon, low-health recovery | derived (synthetic End view) |

Derivations keep a real recorded observation and change only what the edit names (`source.derived.edits`):

- **Stage kits** replace the inventory (`source.derived.invariants.kit`). Every restatement is rebuilt: held item,
  tag counts, inventory menu page, food summary, worn armour points. Items no trace recorded get their row from the
  game data (display name from the language file, tags from the 26.1.2 jar and the Fabric convention tags shipped with
  the pinned fabric-api, fingerprint as the server computes it); that computation reproduces every recorded item and
  block row exactly. Earlier observations, the recorded plan, recent results, stale observation lastResult and changedFacts are dropped, since they described
  the recorded inventory; the plan is the recorded PAIR2 A1 plan (manual steps) with the stage step active, since
  without a plan the model first reads it and the case measures the missing plan instead of the stage decision.
- **Eye of ender** cases add the flying eye (or the dropped eye item) as an entity row with a consistent box,
  distance and coverage count.
- **End views** (`invariants.dimension`) keep the recorded player and build the vanilla layout around it: end stone
  floor, the ten obsidian pillar tops at radius 42 and the exit portal as landmarks (distance, bearing and elevation as
  the server computes them), end crystals, the dragon and its boss bar; the view is levelled so the crosshair misses.

`test/decision-eval-fixtures.test.mjs` checks every kit and End case against its declaration (exact items, held
item, worn pieces, armour points, food summary, coverage counts, dimension, landmark distances), and
`test/decision-eval-progression.test.mjs` pins what the hard predicates decide and routes context-dependent combat to
the judge, with negative controls for accepted but impossible calls (a 3x3 recipe in the inventory grid, a table craft
with no table, a shot with no bow, a use_item of an item that is not held). Safe regeneration waits are judged in
context. `test/decision-eval-fixture-validator.test.mjs` applies four expectation checks to every train family: hard
goods only for actions the recorded inventory, surroundings and recipes allow; rubrics cite only carried items and
milestones still carried; Good sections offer only actions of the case's stage; no claim of absence or geometry the
view does not establish (sampled entity lists, head parts, island edges). Five older families with known infeasible
alternatives and six older cases with unbounded crafting are listed in the test as debt that must shrink.
Progression movement, combat and placement are judged from the rubric rather than credited by a target or item name.
Progression hard goods use the closed form implemented by `test/helpers/closed-progression-good.mjs`:
`all: [{count: {min: 1, max: 1}}, {tool, normalized, args}]`. The exact tool is `act` or `sequence`.
For `act`, normalized kind and actionType are literal strings, and `arguments.eq` contains the complete
production arguments. For `sequence`, `actions.eq` contains every ordered action and its complete arguments.
The raw `args` map repeats those exact action fields and requires absent view/afterObservationId options
(and absent finish for sequences), so bad predicates cannot depend on unbounded presentation variants.
Use `exactGood(steps)` in that helper to construct the form. Up to eight complete `in` alternatives are
allowed in place of `eq`, but they may vary only legal integer counts. Unknown recipes, unsupported effects,
regex, wildcards, arbitrary Boolean trees, multiple calls, partial arguments and open item sets require the judge.
Only executions graded good by production `gradeSample` undergo feasibility checks: bad predicates override good.
The two committed hard-positive crafts use exact count 1 and timeout 5000; other timings, tool forms, batches
and composite answers reach their existing factual rubrics. The fixture validator simulates every execution
in the finite closed form in order, consuming ingredients and crediting outputs. The bounded candidate search
is a secondary regression check, never proof of the accepted domain.
Required crafts are ceil(requested output items / recipe yield), checked against the production howto index.
Unknown state-changing steps in a crafting sequence cannot be certified by this validator.
A stationary dragon parent does not prove a perch or an attackable body part. Preparation rubrics distinguish
safe construction/lighting and travel from entering a dangerous dimension. End kits are checked just like every other derived stage kit. The curator, captured moments and catalog check live in
`arena-quality-research/notes/wave3/progression-evals/`. Replace derived cases with recorded ones as soon as runs
reach those stages (fluid casting, barter, eye flight, stronghold rooms and the dragon need live captures first).

## Iron sourcing

`train/iron-sourcing.json` adds eight decisions about obtaining the first iron with stone tools: reachable exposed
ore, remembered ore, two cave approaches, a remembered village, an unknown-source search, and switching after
400 or 800 unproductive tunnel breaks. Cases 01, 03 and 06 also belong to `quick.json`.
The source observations come from four Sol games in `arena-feel-run/trials/` (c4 and c5), including rotated
`protocol.jsonl.1` and `.2` files. All eight cases declare their derivations: the active iron plan uses the recorded
PAIR1 plan, the compact captured goal specification gets the metadata required for replay, and the reachable ore,
remembered village and poor-yield histories are explicitly hypothetical variants. The mining histories retain the
recorded Y65-66 terrain; their block counts are not measurements from those source moments.

Hard goods require mining the exact reachable ore cell or making coordinate-based progress toward a known source
with `navigate_to` at the current elevation. Wrong coordinates, no movement and unobserved descents get no automatic
credit. Waiting, finishing and breaking the player's footing are hard bad. Programs, access excavation, raw controls,
safe combat and the quality of an unknown-source search need the factual rubric. Reads alone never count as good.
`test/decision-eval-iron-sourcing.test.mjs` checks those boundaries and verifies that the rendered wake actually carries
the remembered sources and zero-yield histories. Captured results older than the replay window and unsupported
asset summaries remain reported in `replay.unreplayed`.

## Held-out split

Held-out cases live only outside the repo, in `arena-quality-research/evaluator-only/decision-eval/heldout.json`.
The repo keeps their SHA-256 in `coordinator/test/fixtures/decision-eval/heldout.sha256`; the runner refuses a set
whose hash does not match. People and agents fixing behaviour never read the held-out file. Current held-out set (q9
progression): 51 cases from 50 source moments (the fix round 2 set of 41 plus 10 progression cases, `ho-prog-*`: 6
recorded, 4 derived), SHA-256 `6140e6bc19edd641d8b79b8be97b7f90951d9239707b9b43afb458e90b429fca`; no source moment is
shared with train.
The held-out cases are held-out moments and variants: some come from the same recorded runs as train cases
(different moments, never a shared observation), so they test generalisation across moments, not across independent
runs or worlds. A stronger split would reserve whole source runs for the evaluator.

```sh
npm run eval:decisions -- --baseline main --split heldout \
  --cases ../../arena-quality-research/evaluator-only/decision-eval/heldout.json \
  --expect-fixture-sha256 @test/fixtures/decision-eval/heldout.sha256 \
  --out ../../arena-quality-research/evaluator-only/decision-eval/runs/<name>
```

Held-out runs write no spot checks, and `eval.md` leaves out per-case content; keep their output directory outside
the repo. To add held-out cases: write them to the held-out file only, use distinct variants (and ideally families
or runs that train does not use), then update `heldout.sha256` with the file's SHA-256 (`sha256sum heldout.json`).

## CI

`npm run eval:decisions:pr` (`scripts/decision-eval/ci-check.mjs`) runs the check for a PR: `--pr <n>` (reads base and
head with `gh pr view`) or `--base <ref> --head <ref>`. `--post-status` (off by default) sets a `decision-eval` commit
status on the head with `gh api`.

`.github/workflows/decision-eval.yml` runs the quick check on pull requests, but its job is skipped unless the
repository variable `DECISION_EVAL_ENABLED` is `true`. Choosing how it gets a model is Lucas's decision:

| | Self-hosted runner on a lab machine (default) | GitHub-hosted runner with an API key |
|---|---|---|
| Setup | Register a lab machine as a self-hosted runner; Claude Code (and Codex for the judge) already logged in there. Optional `DECISION_EVAL_RUNS_ON` (JSON label list, default `["self-hosted"]`). | Set `DECISION_EVAL_AUTH=api-key` and add the `ANTHROPIC_API_KEY` secret. The job installs Claude Code. |
| Billing | The machine's existing Claude Code plan or key | Anthropic API, per token |
| Secrets | None in GitHub | One repository secret |
| Caching | Baseline and judge caches persist on the machine between PRs | Cache is lost per job unless `actions/cache` is added |
| Judge | Works if Codex is logged in (`DECISION_EVAL_JUDGE=auto`, the default) | Needs a Codex login or OpenAI key on the runner; without it the check can only run the predicate diagnostic and cannot PASS |
| Risk | A PR's code runs on the lab machine; limit it to trusted branches | Runs on GitHub's machines; forks do not get the secret |

Other variables: `DECISION_EVAL_SCOPE=full` (full train set instead of quick) or `preflight` (the weaker per-push
check), `DECISION_EVAL_BUDGET_USD`
(default 20: a quick check with a cached baseline is estimated at about $11 and keeps a 30% confirmation reserve). Nothing is enabled by default and the workflow creates no secrets.

## Full-game stalls

`train/fullgame-route-repair.json` contains five recorded route failures from the 90-minute Sol run
`run-1792221047917-2898d71e` (seed -8641836426164806784): blocked ascent, blocked descent, a missed staircase
landing, a cave approach beside a drop, and recovery excavation. Three join the quick set. The family grades
local repairs against the actual obstruction and support; choosing another coordinate alone earns no credit.
Existing progression-efficiency, melee-threat-low-health, burning and night-falling families also carry five
`*-fullgame-*` cases for filled-bucket retention, Nether preparation, both deaths and sheltered waiting.

Capture with `capture.mjs --root /home/agaminggod --out moments.jsonl <recorded trace directory>`. These sources
use home-relative trace paths; verify them with the same root. All ten observations remain unedited. Their agent
state restores the original full goal specification and the plan/intent authored before that observation from
`provider-turns.private.jsonl` (lines recorded in `source.providerTurnLines`), rather than the capture utility's
last-saved-plan fallback. Task memory comes from the preceding delivered wake. Earlier results outside the
observation replay and unsupported remembered assets remain listed as unreplayed by the renderer.
