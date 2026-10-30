#!/bin/bash
set -euo pipefail
b=/home/agaminggod/Desktop/Projects/arena-beat-game
h=/home/agaminggod/Desktop/Projects/aa-d39-pearls4
a=$b/evals/d39-warped4
worker=$1
mkdir -p "$a/physical"
export JAVA_HOME=/usr/lib/jvm/temurin-25-jdk-amd64
export ARENA_HEADLESS_SERVER_TEMPLATE='/home/agaminggod/.t3/worktrees/agents arena/t3-ba7399a1/runtime/server-template'
export REPLAY_JAVA_OPTS=-XX:ActiveProcessorCount=4
while [ ! -f "$a/frozen.json" ]; do sleep 10; done
cd "$h"
i=0
for seed in 123456789 8675309 987654321 20261024; do
 for repeat in 1 2 3; do
  if [ $((i%2)) -eq "$worker" ]; then
   node evals/d39-warped4/verify-frozen.mjs "$a"
   out=$a/physical/$seed-r$repeat
   "$b/slot.sh" live bash -c 'export SLOT_PORT_BASE=$((SLOT_PORT_BASE+4*$1)); exec node scripts/quality/test-warped-pearl-live.mjs "$2" "$3" "$4" "$5" 24000' x "$i" "$a/survey/$seed/checkpoint.json" "$out" "$b/evals/d39-pearls4/windows-base.jar" "$repeat" > "$out.log" 2>&1
  fi
  i=$((i+1))
 done
done

set +e
node evals/d39-warped4/summarize-physical.mjs "$a"
rc=$?
[ "$rc" -eq 0 ]||[ "$rc" -eq 77 ]
