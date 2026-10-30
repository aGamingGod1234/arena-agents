#!/bin/bash
set -euo pipefail
b=/home/agaminggod/Desktop/Projects/arena-beat-game
h=/home/agaminggod/Desktop/Projects/aa-d39-pearls4
a=$b/evals/d39-warped4
attempt=${1:-3}
export JAVA_HOME=/usr/lib/jvm/temurin-25-jdk-amd64
export ARENA_HEADLESS_SERVER_TEMPLATE='/home/agaminggod/.t3/worktrees/agents arena/t3-ba7399a1/runtime/server-template'
export REPLAY_JAVA_OPTS=-XX:ActiveProcessorCount=4
while [ ! -f "$a/survey/${SEED:-123456789}/checkpoint.json" ]; do sleep 10; done
cd "$h"
SLOT_TOKENS=phys:1 exec python3 "$h/evals/d39-warped4/slot-wait.py" node scripts/quality/test-warped-pearl-live.mjs "$a/survey/${SEED:-123456789}/checkpoint.json" "$a/calibration-$attempt" "$b/evals/d39-pearls4/windows-base.jar" 77 2400
