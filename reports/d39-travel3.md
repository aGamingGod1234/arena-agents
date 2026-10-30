# d39 travel3

The port verifies a 1.96x course pace gain. The requested zero-fire bar fails: one candidate burn produced 15 fire samples. Both 90-minute Sol windows completed. Live outcomes are mixed: the first reaches a fortress earlier with lower Nether pace and one death; the second has higher conditional Nether pace, four deaths, and no observed fortress.

## Change and identity

Branch `claude/d39-travel3` starts at `4682f12e`. Body/runtime commit: `6345839e`. Contract review: `f2f3890b`. Frozen runtime: `aa-run-6345839e`; jar SHA-256 `53545d9bf635763da270c9077888de9e675d4587f86e833149c20eb52670f88f`. Native coordinator fingerprint: `23a75cdf2428218e02ccecb702ca909b53cce1bb13504859778ab14ab39be885`. See [artifact identity](../evals/d39-travel3/artifact.json).

- Ported `ServerTravelController`, `TravelBuilder` and `TravelCheckpoints`: connected walking searches survive slice limits, longer legs/calls, vanilla whole-inventory hotbar swaps, batched supported strides/mining, visible bridge attachments, brief tool-free wart clearing, and nearby uphill checkpoints. Pace reports elapsed wall time and all carried plain blocks.
- `ServerNavigationController` retains base movement-level support and adds the d38 acceleration/corner fire brake. The d35 post-mining observation window and lava retreat remain.
- `BrinkGuard` retains all base level-holding and bracing behavior; only full-footprint idle-magma crouching is added.
- `nether-regions.mjs`, `live-task-view.mjs`, `search-coverage.mjs` and the fortress fact are byte-identical to base. No region-ranking fact or its sight-memory changes were ported.
- Updated the travel reference for carried supplies and the 600000 ms default. Only the Nether topic's pinned allowance rises 4096 to 4128, exactly its 32 added UTF-8 bytes. The rendered topic is 4127 bytes. Added the d38 fixture identity correction to prevent equal-ID weak-map aliases in crafting verification; runtime inventory behavior is unchanged.

## Six fresh matched course pairs

Original six substantive `travel-courses.json` cases, `travel` mode, 12-minute issuance budget. Each physical arm used a fresh world on the Mini PC, a 400% CPU quota, JVM ActiveProcessorCount=4 and nice=10. Odd pairs ran base first, even pairs candidate first. No baseline reuse and no outcome resampling. Targets from vanilla `/locate` are operator-only test inputs; these courses make no model calls.

| Measurement | Base 4682f12e | Candidate 6345839e |
| --- | ---: | ---: |
| Net blocks per active wall minute | 31.777 | 62.146 |
| Net blocks per game minute | 31.767 | 62.092 |
| Net blocks | 1700.2 | 1610.2 |
| Active minutes | 53.503 | 25.910 |
| Observed TPS | 20.007 | 20.017 |
| Deaths / fire samples / lava samples | 0 / 0 / 0 | 0 / 15 / 0 |
| Damage lower bound, health | 10.48 | 7.50 |
| Course arrivals | 0/6 | 0/6 |
| NO_ROUTE handbacks / calls, including detours | 20/50 | 18/54 |

The candidate covers 5.3% less net distance in 51.6% less active time. The weighted wall gain is 1.9557x and the game-clock gain 1.9546x. No pair reverses pace ordering after TPS adjustment. One pair has a host-CPU mean difference above 15 percentage points; it is retained and flagged. Quotas are verified in cgroup `cpu.max`; cores were not pinned. The pair 3 baseline host-CPU sampler covers about 50.5% of its interval because its Python coordinator and sampler thread were paused to yield the next slot to the diagnostic. Its Minecraft child continued normally; wall time and game ticks are complete. All six pairs match checkpoint, mode, target and starting position within 0.02 blocks.

| Course | Base blocks/min | Candidate blocks/min | Net blocks, base / candidate | Fire samples, base / candidate |
| --- | ---: | ---: | ---: | ---: |
| entry9-fortress | 34.8 | 45.7 | 258.7 / 358.4 | 0 / 0 |
| y55-fortress | 35.7 | 56.7 | 428.0 / 155.8 | 0 / 15 |
| high110-fortress | 22.5 | 65.5 | 270.2 / 578.6 | 0 / 0 |
| entry9-east300 | 29.9 | 40.4 | 209.0 / 103.4 | 0 / 0 |
| gold2-north300 | 25.3 | 98.7 | 140.0 / 143.9 | 0 / 0 |
| fortress3-bastion | 41.3 | 109.2 | 394.3 / 270.1 | 0 / 0 |

The pace gain passes. Zero deaths and lava contact hold. The zero-fire criterion fails, and no arrival-rate gain is established. These are sampled contacts plus action-result evidence, not a continuous native damage ledger.

### Fire failure retained

In y55, a piglin arrow caused a damage handback at 91.4 s; the next call stopped ON_FIRE at 91.8 s. The exact ignition cause is unresolved: burning projectile versus knockback into nearby fire. The standard harness had cleaned the original incident world. A separate 240.6-second diagnostic captured projectile fire and movement, followed a different route, and recorded zero damage/fire/lava. It does not explain or replace the failed arm. Candidate source remains unchanged. See [diagnostic conclusion](../evals/d39-travel3/fire-diagnostic-conclusion.json).

Raw courses, logs and diagnostic capture live under `arena-beat-game/evals/d39-travel3`; accepted result JSON and the [paired summary](../evals/d39-travel3/course-summary.json) are committed here.

## Live Sol games

Both sequential 90-minute games completed on the Mini PC through `slot.sh live` and the canonical `long-sub.sh`, using `9-nether-entry-123456789-v2.json` and `9-nether-entry-987654321-v2.json`. Runtime/jar identity is frozen above. The native launch profile and all recorded player-turn settings submit low effort; provider records confirm `gpt-6.1-sol` and default service tier. Explicit player settings override an unused global priority fallback. No Desktop access was made.

The same hash-pinned d39 scorer and ten-second horizontal-displacement metric process baseline and candidate protocols. Fortress seen means visible fortress brick; entered means the vanilla `nether/find_fortress` advancement. Fortress times are elapsed game-window minutes. Each candidate is also clipped to its baseline's available capture. Setup and checkpoint metadata match apart from independently generated loot salts, so these are separate stochastic trials.

### Seed 123456789

Baseline `d39-nether-entry-123456789-18` (mini); candidate `d39-travel3-123456789-r3` (Mini PC).

| Measurement | Base 4682f12e | Candidate, common window | Candidate, full window |
| --- | ---: | ---: | ---: |
| Game minutes | 89.993 | 89.993 | 90.000 |
| Nether minutes | 89.977 | 89.228 | 89.236 |
| Blocks per Nether minute | 37.765 | 25.168 | 25.165 |
| First fortress seen, min | 39.549 | 26.168 | 26.168 |
| First fortress entered, min | 41.760 | 35.278 | 35.278 |
| Deaths | 0 | 1 | 1 |
| Observed TPS | 20.000 | 20.000 | 20.000 |

### Seed 987654321

Baseline `d39-nether-entry-987654321-20` (desktop); candidate `d39-travel3-987654321-r2` (Mini PC).

| Measurement | Base 4682f12e | Candidate, common window | Candidate, full window |
| --- | ---: | ---: | ---: |
| Game minutes | 44.764 | 44.764 | 90.000 |
| Nether minutes | 41.773 | 10.107 | 10.815 |
| Blocks per Nether minute | 20.918 | 30.005 | 30.227 |
| First fortress seen, min | 0.422 | Not observed | Not observed |
| First fortress entered, min | 0.863 | Not observed | Not observed |
| Deaths | 2 | 4 | 4 |
| Observed TPS | 19.963 | 20.001 | 20.002 |

For 123456789, fortress discovery is 13.38 minutes earlier and entry 6.48 minutes earlier, but movement per Nether minute falls and deaths rise from zero to one. The death is a blaze fireball at 83.43 minutes.

For 987654321, conditional Nether pace rises, but the candidate spends only 10.81 of 90 minutes in the Nether and observes no fortress. It has four deaths within the common window: three Piglin Brute deaths and one Skeleton death. The baseline sees/enters a fortress within one minute and has two deaths in its available 44.76-minute capture. These game outcomes do not establish consistent whole-game improvement.

### Capture and identity limits

Both native windows end at the 90-minute wall-clock budget; native exits are zero. The framework retains `INCOMPLETE` and `FAILED`/`TIMEOUT` labels. The first game has no observer errors. The second records the non-terminal “Quality player disappeared during sampling” error (duplicated in the aggregate report); its timing is not established. Neither has terminal observer errors or recorded native sampling gaps. Candidate sample coverage starts 0.135/0.136 seconds after the window start and ends 0.929/0.545 seconds before its deadline; maximum internal gaps are 3.773/4.869 seconds. Metrics exclude samples after the exact deadline. See [native verification](../evals/d39-travel3/game-native-verification.json) and [full/common comparison](../evals/d39-travel3/game-comparison.json).

The seed 987654321 baseline is a locally cached partial Desktop capture, not proof its game ended at 44.76 minutes. Its native sampler has an 82.565-second maximum gap; its protocol-based Nether metric reports no gaps over five seconds. Both baseline harnesses record `4682f12e`, the same coordinator fingerprint, and no source change. The Mini PC baseline jar matches the course base jar. The Desktop jar has a different SHA-256 and no cached binary for class comparison; its class identity is unverified. Native source-commit fields are null. See [baseline identity](../evals/d39-travel3/baseline-native-identity.json) and [input matching](../evals/d39-travel3/game-input-matching.json).

Both usable baseline captures predate the Oct 25 22:20–22:50 stall. The 20261024 and 8675309 queue captures have no usable gameplay protocol; no Desktop refresh was attempted.

The old `d38-travel-98-mini-123456789` game and the Oct 25 capacity-stall window are void. A d39 startup failed before gameplay with EADDRINUSE on port 28101 and remains a void attempt. Subsequent launches check all three assigned ports after admission. Other superseded tags stopped while waiting, before gameplay. The second game waited for shared capacity; its private admission wrapper still uses the canonical `slot.sh`, the same three lock files/count and one actual lease. No poor outcome was resampled.

## Gates

- `./gradlew build verifyCore --offline --no-daemon`: PASS, 2,577,454 assertions. The first build ran online after the cache wipe; the final build passed in 2m19s.
- Full `npm test`: 7,075 total, 6,989 passed, 75 skipped, the same 11 known Windows/platform failures.
- Final `npm run test:contracts`: 639/639 passed.
- Both game jars and coordinator fingerprints match the frozen artifact; native source-change detection is false. Provider-reported player model/tier match Sol/default, with low effort submitted.
- Final collection and HTML generation exit 0; full/common windows and matched setup are audited.

Unverified: original course fire ignition; Desktop baseline jar class identity; timing of the second game's non-terminal observer error. Contact counts are sampled, not a continuous damage ledger. The measured zero-fire bar is failed.

[Self-contained results page](../evals/d39-travel3/results.html). Raw logs and full protocols remain in the Mini PC evaluation/run directories; selected results and analysis launchers are committed on this branch.
