#!/bin/bash
set -euo pipefail
b=/home/agaminggod/Desktop/Projects/arena-beat-game
h=/home/agaminggod/Desktop/Projects/aa-d39-pearls4
export JAVA_HOME=/usr/lib/jvm/temurin-25-jdk-amd64
export ARENA_HEADLESS_SERVER_TEMPLATE='/home/agaminggod/.t3/worktrees/agents arena/t3-ba7399a1/runtime/server-template'
export REPLAY_JAVA_OPTS=-XX:ActiveProcessorCount=4
mkdir -p "$b/evals/d39-warped4"
cd "$h"
exec "$b/slot.sh" live node evals/d39-warped4/survey.mjs "$b/long/checkpoints" "$b/evals/d39-warped4/survey" "$b/evals/d39-pearls4/windows-base.jar"
