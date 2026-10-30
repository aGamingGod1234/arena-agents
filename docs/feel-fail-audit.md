# Failure outcome audit

Scope: `claude/feel-fail`, based on `integration/feel-base`. Read both supplied traces and the production paths, contracts and tests. No push or merge.

Verdicts: **a** real outcome; **b** false failure; **c** missing physical ability; **d** misleading feedback. Run-2 costs below combine both agents, in descending affected-class order: dispatch-to-result plus result-to-next-dispatch. The latter approximates recovery/model time and can include useful work or waiting.

- **REACHED_FRONTIER (a/d, 34 results, 307 s):** partial travel does not establish arrival. Keep FAILED so success guards and composed controllers cannot treat an edge as their destination. Report endpoint, unreached destination, existing walked/remaining/closest facts, and observation/rerouting requirement. No navigation strategy changed.
- **ACTION_CANCELLED (a):** explicit model cancellations remain CANCELLED; no automatic success or retry.
- **TARGET_NOT_VISIBLE (a/c, 10 mining results, 68 s):** gravel and solid occlusion are legitimate. Vanilla outline rays hit plants. Prefer existing exposed-point aiming; otherwise clear eligible instant-break vegetation/flowers using eased aim and vanilla attack input, then revalidate the remembered target. Require owned removal receipts, protection, range, original timeout and expected identity; report cleared plants. Crops/solid substitutes remain excluded. Run 1 also names leaf litter.
- **TARGET_AIR / TARGET_CHANGED (a/d, 7/4, 43/13 s):** keep failure without owned break evidence. Explain empty/replaced cells, no credited drops and fresh identity requirements.
- **NO_PLACEMENT_SUPPORT (a/d, 5, 27 s):** retain physical support checks; name destination/face and explain placement coordinates and reacquisition.
- **ITEM_NOT_FOUND (a, pickup 6, 26 s):** a missing visible UUID without an owned collection receipt remains unavailable; existing visible alternatives make no despawn/merge claim.
- **PLACEMENT_NOT_CONFIRMED (a/d, 4, 23 s):** retain vanilla refusal; add predicted collision-shape evidence when the player's body occupies the placement cell.
- **ITEM_ALREADY_PICKED_UP (b, 7, 20 s):** owned receipts now return SUCCEEDED, current holdings and no new physical attempt. Retire the consumed UUID from memory; never collect twice.
- **ITEM_NOT_IN_HOTBAR (a, 5, 18 s):** explicit contract; existing select_tool/menu_click supplies vanilla inventory access. Preserve source-slot repair feedback.
- **AMBIGUOUS_ITEM (b/a, 5, 8 s):** equivalent stacks select the first hotbar match; different components/durability still require a model-selected slot. Align simulator.
- **NO_SEEN_ROUTE / NO_STANDABLE_PATH (a):** no known supported route is not proof of global impossibility; keep existing facts and failures.
- **UNSUPPORTED_MENU (a/d, 2, 6 s):** absent provider is legitimate; now name current block and coordinates, rather than implying vanilla furnaces are unsupported.

Estimated savings: **30–60 seconds per agent per 40 minutes**, unmeasured. Normalize the 40.77-minute run across two agents: about 14 seconds of pickup/equal-stack recovery exposure, plus an assumed 10–30% reduction in frontier/stale-target/placement recovery. Do not credit useful travel or speculate about plant savings absent run-2 plant evidence.

Backend validation: verifyCore passed 2,554,190 assertions; npm test passed 6,251, with 11 known Linux baseline failures and 74 skipped; test:contracts passed 590/590. Contract claims refreshed/reviewed; five pre-existing stale predicate parents reattached to the unchanged current paragraph. Live clearing/acknowledgement evidence remains explicitly partial. No new live-world replay.


## Implementation round 2

The menu error reads identity only from `SeenTerrain.known`, labels it “Last perceived”, and uses generic text for unknown cells. A hidden replacement cannot disclose its live block ID.

Mining allows two direct re-aim retries when the crosshair slips and at most eight credited plant removals per action. Mid-break revalidation/configuration and renewed clearing protection failures become domain results. All break-action factories start with a deny-all plant policy; only normal admission supplies authorization. Clearing still needs the exact attacked cell's fresh removal receipt; an uncredited disappearance is `TARGET_CHANGED`. The original timeout remains in force.

Lilac, rose bush, peony and sunflower now qualify alongside tall grass and large fern. The attack and receipt use the half on the ray, leaving vanilla to remove its partner. Fern, dead bush and leaf litter qualify under the instant-break/noncolliding policy. Nonreplaceable saplings, sugar cane, sweet berry bushes and crops stay excluded. **Snow layers are not implicitly cleared.**

A zero-held pickup receipt says “Collected earlier …; no longer held” and stays successful. Tests exercise missing-UUID resolution through `findItem`, acknowledge the same owned receipt twice with one and zero items held, and assert unchanged inventory counts and receipt totals. Receipt acknowledgement never calls vanilla pickup or credits another inventory delta; the coordinator's existing memory regression independently asserts unchanged inventory when retiring the UUID.

The simulator preserves an optional `components` map on scenario inventory stacks and compares its canonical fingerprint alongside damage/maxDamage. Custom names, enchantments and custom data participate; map key order and stack quantity do not affect equivalence. Scenarios must supply component metadata they model.

Executor coverage exercises production `ActiveAction` configure, clearing-receipt and retry methods, including clear-to-target transitions, denied/revoked protection, missing receipts, cap and both tall-plant halves. Geometry coverage uses actual two-cell plants and vanilla outline rays. These are backend fixtures, not a live Carpet/mixin tick replay. Contract refresh changed no advertised claims; reviewed clearing evidence remains partial for that reason.


Round-2 final validation: `JAVA_HOME=/usr/lib/jvm/temurin-25-jdk-amd64 flock /tmp/aa/gradle.lock ./gradlew verifyCore --offline` passed **2,554,433 assertions**. Coordinator `npm test` passed **6,251**, with **11 existing Windows-only/Linux baseline failures** and **74 skipped** (6,336 total). Focused simulator actions and failure-schema checks passed. `contracts:refresh` reported no advertised contract changes; the manually reviewed witness updates retain partial live-clearing status. `npm run test:contracts` passed **590/590**. `git diff --check` passed. Logs are `feel-fail-round2-java-final.log`, `feel-fail-round2-coordinator-final.log`, `feel-fail-round2-contract-refresh.log`, and `feel-fail-round2-contracts-final.log` in this checkout. No live-world replay, push or merge was performed.
