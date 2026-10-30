#!/bin/bash
# Model-free stand-in cohort with the build-where-you-stand cover: one 24,000-tick trial per prepared seed (salt from $1, default 1).
# Waits for the latest calibration to build cover and complete its window; stops on a broken calibration.
set -uo pipefail
b=/home/agaminggod/Desktop/Projects/arena-beat-game
h=/home/agaminggod/Desktop/Projects/aa-d39-pearls4
a=$b/evals/d39-warped4
salt=${1:-1}
export JAVA_HOME=/usr/lib/jvm/temurin-25-jdk-amd64
export ARENA_HEADLESS_SERVER_TEMPLATE='/home/agaminggod/.t3/worktrees/agents arena/t3-ba7399a1/runtime/server-template'
export REPLAY_JAVA_OPTS=-XX:ActiveProcessorCount=4
while true;do
 node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1]));process.exit(r.completedWindow&&r.coverBuilt?0:r.error||r.dead?3:1)' "$a/calibration-${CAL:-10}/result.json" 2>/dev/null;rc=$?
 [ $rc -eq 0 ]&&break;[ $rc -eq 3 ]&&{ echo 'calibration failed' >&2;exit 3; };sleep 15
done
mkdir -p "$a/physical2"
cd "$h"
for seed in 123456789 8675309 987654321 20261024; do
 out=$a/physical2/$seed-r$salt
 [ -f "$out/result.json" ]&&continue
 SLOT_TOKENS=phys:2 python3 evals/d39-warped4/slot-wait.py node scripts/quality/test-warped-pearl-live.mjs "$a/survey/$seed/checkpoint.json" "$out" "$b/evals/d39-pearls4/windows-base.jar" "$salt" 24000 > "$out.log" 2>&1
 echo "seed $seed salt $salt exit $? $(date -Is)"
done
