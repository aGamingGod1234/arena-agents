# Navigation continuation, round 2

Implementation commit: `eca9ffc4f45d1aa8fc943d1bf61850d4cdc65612`.

Near stops now return `FAILED / DESTINATION_NEAR_UNVERIFIED`, with distance, requested tolerance and movement facts. The coordinator classifies them as path failures; success-gated programs and sequences stop before later actions. The old near-success classification is removed.

Near eligibility requires acquired clear target feet/headroom and safe standable support. Stable, dry, collision-free current footing and the existing distance/height limits still apply. Unknown target geometry, rock, unsupported ground, lava, powder snow and cactus cannot justify this outcome. The approach remains unverified, so the receipt never proves arrival.

Any observed health drop during continuation observation stops navigation with `NAVIGATION_DAMAGED`. Terrain invalidation and movement-view replacement clear stale frontier history. Original target, timeout and observed-detour behavior remain.

Controller fixtures use a stub player and input sink with real acquired-terrain searches. They cover retries, safe/stable gates, timeout inside the wait, damage without an attacker, cancellation, repeated frontiers, unsafe leg endpoints and a non-improving observed detour. Coordinator tests cover receipt delivery, failure classification, sequence/program chaining and threat cancellation.

Verification: Java 25 `verifyCore --offline` passed with 2,554,231 assertions. Coordinator: 6,253 passed, 74 skipped, 11 expected Linux baseline failures involving Windows paths/PowerShell. Contracts: 590 passed after refresh and explicit review; changed claims remain `partial` because Minecraft physics and live gameplay were not replayed. No measured improvement to the original live failure rates is claimed. No push or merge.
