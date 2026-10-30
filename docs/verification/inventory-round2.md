# Inventory fix round 2 verification, 2026-10-13

## Status and change

The worktree was clean on resume at `d6dafb2048b75eb1eb38904812911bb6499a20e6`. That existing local commit already implements the review correction; no further production change was needed. The byte blocker in `reviews/w3-inventory-r2.md` is resolved on all requested wakes. The behavioral shipping gate remains **OWED**, per the brief's NO CLAUDE override. No model, judge, live-game, or Claude CLI run was made in this resumed round. New model spend: **$0**.

`d6dafb20` replaces repeated default item names and slot-implied hotbar flags with one explicit `itemDefaults` statement, only if both the encoded event and raw event shrink. Custom names and hotbar exceptions remain explicit. This happens after budget decisions, so it does not alter which rows those decisions retain. The capacity line still names the full inventory and partial carried stacks, now showing four item IDs and `+N more`; the remaining stack counts and limits stay in inventory rows. This describes carried-stack headroom by item ID, not a guarantee that any incoming same-ID item has matching components.

The prior reviewed commit added 961 bytes over the 12 inventory wakes. The fixed commit removes 2,214 bytes relative to that reviewed version, leaving the same 12 wakes **1,253 bytes below baseline**. Every inventory wake saves 12 to 184 bytes. The quick set saves **2,627 bytes** versus baseline; none of its 54 wakes grows. These totals overlap on inventory cases 01 to 03 and must not be added together.

## Measurement method and scope

Fresh render-only captures used immutable coordinator snapshots of baseline `9d44450c`, reviewed `fc367f7b`, and fixed `d6dafb20`, each with the same `render.mjs` and `schema.mjs` from q8. `renderWake` replays each reconstructed case through the production coordinator with an in-memory bridge and captures the encoded provider input. `renderPrefix` captures instructions and tool definitions without calling a model. Prefix hashes match: `5861a5c63260e808cf5a85f7b78cb1e33490e910dca84053deb171da9f4116b5`.

Artifacts: `r2-resume/{base,reviewed,candidate}.json`, each snapshot's `renders/`, `r2-resume/BYTES.md`, `r2-resume/bytes.html`, and `tools/measure-r2-resume.mjs`, under `arena-quality-research/notes/wave3/inventory`. The script throws on missing cases or failed renders. It captured 63 distinct wakes: all 12 branch inventory cases plus all 54 current quick IDs. No held-out files were read. This demonstrates byte savings for those inputs, not dollar savings per completed game or a universal bound on all full-inventory states.

The Java pickup and mining messages are unchanged from `fc367f7b`. Their standalone result bytes have no new reduction in this round. The frozen cases replay their supplied historical results; these measurements do not claim to measure newly produced Java failure messages or long-game result traffic. No Java files changed, so no new Gradle build was required. The round 2 review's previous core verification and live survival/creative checks remain historical evidence; its full build had an unrelated voice-addon failure.

## Always-sent bytes

| Component | Base | Reviewed | Fixed | Delta |
|---|---:|---:|---:|---:|
| Instructions including API reference | 18,591 | 18,591 | 18,591 | 0 |
| Tools | 24,272 | 24,272 | 24,272 | 0 |
| Total | 42,863 | 42,863 | 42,863 | 0 |

## All 12 inventory wakes

| Wake | Base 9d44450c | Reviewed fc367f7b | Fixed d6dafb20 | Fixed minus base |
|---|---:|---:|---:|---:|
| inventory-full-01 | 11,708 | 11,742 | 11,692 | -16 |
| inventory-full-02 | 12,838 | 12,901 | 12,654 | -184 |
| inventory-full-03 | 13,694 | 13,768 | 13,556 | -138 |
| inventory-full-04 | 16,675 | 16,788 | 16,537 | -138 |
| inventory-full-05 | 16,351 | 16,464 | 16,328 | -23 |
| inventory-full-06 | 14,825 | 14,940 | 14,782 | -43 |
| inventory-full-07 | 10,823 | 10,876 | 10,672 | -151 |
| inventory-full-08 | 16,063 | 16,122 | 15,881 | -182 |
| inventory-full-09 | 12,130 | 12,223 | 12,002 | -128 |
| inventory-full-10 | 11,153 | 11,233 | 11,036 | -117 |
| inventory-full-11 | 16,435 | 16,511 | 16,423 | -12 |
| inventory-full-12 | 14,187 | 14,275 | 14,066 | -121 |
| **Total** | 166,882 | 167,843 | 165,629 | -1,253 |

## All 54 quick-gate wakes

| Wake | Base 9d44450c | Reviewed fc367f7b | Fixed d6dafb20 | Fixed minus base |
|---|---:|---:|---:|---:|
| creeper-post-escape-pair2-b2-recorded-flee | 21,231 | 21,231 | 21,004 | -227 |
| creeper-near-01 | 9,615 | 9,615 | 9,597 | -18 |
| creeper-near-02 | 11,058 | 11,058 | 11,058 | 0 |
| creeper-near-03 | 13,353 | 13,353 | 13,353 | 0 |
| creeper-post-escape-01 | 11,173 | 11,173 | 11,173 | 0 |
| creeper-post-escape-02 | 12,003 | 12,003 | 12,003 | 0 |
| melee-threat-low-health-01 | 8,428 | 8,428 | 8,428 | 0 |
| melee-threat-low-health-02 | 14,001 | 14,001 | 13,983 | -18 |
| melee-threat-low-health-03 | 14,552 | 14,552 | 14,504 | -48 |
| nether-hostile-near-01 | 13,322 | 13,322 | 13,304 | -18 |
| nether-hostile-near-02 | 13,304 | 13,304 | 13,286 | -18 |
| nether-hostile-near-03 | 12,112 | 12,112 | 12,085 | -27 |
| lava-contact-01 | 11,824 | 11,824 | 11,806 | -18 |
| lava-contact-02 | 10,891 | 10,891 | 10,873 | -18 |
| lava-contact-03 | 11,035 | 11,035 | 11,017 | -18 |
| burning-01 | 10,610 | 10,610 | 10,583 | -27 |
| burning-02 | 13,363 | 13,363 | 13,345 | -18 |
| burning-03 | 12,599 | 12,599 | 12,581 | -18 |
| drowning-01 | 12,505 | 12,505 | 12,461 | -44 |
| drowning-02 | 13,894 | 13,894 | 13,838 | -56 |
| drowning-03 | 6,838 | 6,838 | 6,838 | 0 |
| hunger-01 | 13,723 | 13,723 | 13,698 | -25 |
| hunger-02 | 13,868 | 13,868 | 13,775 | -93 |
| hunger-03 | 14,562 | 14,562 | 14,499 | -63 |
| low-health-recovery-01 | 13,332 | 13,332 | 13,332 | 0 |
| low-health-recovery-02 | 11,806 | 11,806 | 11,806 | 0 |
| low-health-recovery-03 | 14,468 | 14,468 | 14,468 | 0 |
| night-falling-01 | 14,213 | 14,213 | 14,130 | -83 |
| night-falling-02 | 14,026 | 14,026 | 13,899 | -127 |
| night-falling-03 | 13,236 | 13,236 | 13,047 | -189 |
| inventory-full-01 | 11,708 | 11,742 | 11,692 | -16 |
| inventory-full-02 | 12,838 | 12,901 | 12,654 | -184 |
| inventory-full-03 | 13,694 | 13,768 | 13,556 | -138 |
| wrong-tool-01 | 11,786 | 11,786 | 11,686 | -100 |
| wrong-tool-02 | 13,165 | 13,165 | 13,064 | -101 |
| wrong-tool-03 | 12,578 | 12,578 | 12,486 | -92 |
| unreachable-target-01 | 11,698 | 11,698 | 11,698 | 0 |
| unreachable-target-02 | 12,088 | 12,088 | 12,070 | -18 |
| unreachable-target-03 | 9,870 | 9,870 | 9,852 | -18 |
| failed-interaction-retry-01 | 7,724 | 7,724 | 7,724 | 0 |
| failed-interaction-retry-02 | 11,062 | 11,062 | 11,062 | 0 |
| failed-interaction-retry-03 | 12,704 | 12,704 | 12,686 | -18 |
| known-need-ignored-01 | 17,663 | 17,663 | 17,462 | -201 |
| known-need-ignored-02 | 12,804 | 12,804 | 12,782 | -22 |
| known-need-ignored-03 | 15,539 | 15,539 | 15,492 | -47 |
| plan-prerequisite-gap-01 | 16,694 | 16,694 | 16,590 | -104 |
| plan-prerequisite-gap-02 | 14,026 | 14,026 | 13,799 | -227 |
| plan-prerequisite-gap-03 | 21,203 | 21,203 | 21,033 | -170 |
| respawn-continuity-01 | 6,460 | 6,460 | 6,460 | 0 |
| respawn-continuity-02 | 11,159 | 11,159 | 11,159 | 0 |
| respawn-continuity-03 | 10,311 | 10,311 | 10,311 | 0 |
| failure-reason-contrast-01 | 11,830 | 11,830 | 11,830 | 0 |
| failure-reason-contrast-02 | 7,471 | 7,471 | 7,471 | 0 |
| failure-reason-contrast-03 | 12,062 | 12,062 | 12,062 | 0 |
| **Total** | 679,082 | 679,253 | 676,455 | -2,627 |

## Tests

- Fresh `npm test` at `d6dafb20`: exit 0; 5,125 total, 5,115 passed, zero failed or cancelled, 3 skipped, 7 existing TODOs; 486.5 seconds. Log: `npm-test-r2-resume.log`. This supersedes the earlier round 2 run's single timing failure.
- Focused `node --test --test-timeout=60000 test/situation-facts.test.mjs test/model-fact-encoding.test.mjs`: 31/31 passed. Log: `r2-resume/focused-tests.log`.
- Fresh production render captures: 63 distinct cases per build, three builds, no render errors. All fixed wake byte counts are at or below base; all three prefix hashes match.
- `git diff --check` passed. No production or Java edits in this resume; verification is of existing commit `d6dafb20`.
- The HTML table was published inline. Visual preview was attempted twice and failed both times with: `Headless Chrome could not render the page: the page did not finish loading within 20 seconds.` Its rendered appearance was not visually verified; the table values were checked from the JSON measurements.

## Owed evals, do not run until Claude is available

Run from `C:/Users/player/Desktop/Projects/aa-wt-q8-integrate/coordinator`. The prepared `r2-resume/full-train` corpus copies the current 152-case q8 train set and replaces its inventory file with this branch's 12 cases, giving 158 cases. This includes the six added cases in the full gate without modifying the shared harness.

```sh
bash C:/Users/player/Desktop/Projects/arena-quality-research/tools/eval-slot.sh npm run eval:decisions -- --baseline 9d44450c --candidate d6dafb2048b75eb1eb38904812911bb6499a20e6 --concurrency 8 --cases C:/Users/player/Desktop/Projects/arena-quality-research/notes/wave3/inventory/r2-resume/full-train --ids inventory-full-01,inventory-full-02,inventory-full-03,inventory-full-04,inventory-full-05,inventory-full-06,inventory-full-07,inventory-full-08,inventory-full-09,inventory-full-10,inventory-full-11,inventory-full-12 --samples 6 --out C:/Users/player/Desktop/Projects/arena-quality-research/notes/wave3/inventory/runs/r2-resume-focused
bash C:/Users/player/Desktop/Projects/arena-quality-research/tools/eval-slot.sh npm run eval:decisions -- --baseline 9d44450c --candidate d6dafb2048b75eb1eb38904812911bb6499a20e6 --concurrency 8 --cases C:/Users/player/Desktop/Projects/arena-quality-research/notes/wave3/inventory/r2-resume/full-train --quick --out C:/Users/player/Desktop/Projects/arena-quality-research/notes/wave3/inventory/runs/r2-resume-quick
bash C:/Users/player/Desktop/Projects/arena-quality-research/tools/eval-slot.sh npm run eval:decisions -- --baseline 9d44450c --candidate d6dafb2048b75eb1eb38904812911bb6499a20e6 --concurrency 8 --cases C:/Users/player/Desktop/Projects/arena-quality-research/notes/wave3/inventory/r2-resume/full-train --out C:/Users/player/Desktop/Projects/arena-quality-research/notes/wave3/inventory/runs/r2-resume-full
```

Shipping requires focused inventory improvement over baseline, quick and full-train PASS with required coverage, and no significantly worse family. Prior 54% versus 1% focused results and 53% versus 0% full-train inventory results used earlier inputs; they do not establish the fixed commit's behavior. The earlier full train covered only the original six inventory cases. The full gate is owed because item encoding also changes non-inventory wakes. Respect the remaining spend cap when the orchestrator schedules these runs.
