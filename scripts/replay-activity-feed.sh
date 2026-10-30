#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
classes=build/feel-feed/replay
mkdir -p "$classes"
jdk=/usr/lib/jvm/temurin-25-jdk-amd64/bin
"$jdk/javac" -d "$classes" \
  src/main/java/dev/agaminggod/arenaagents/server/AgentFeedPolicy.java \
  src/main/java/dev/agaminggod/arenaagents/server/FailureChatThrottle.java \
  src/test/java/dev/agaminggod/arenaagents/server/AgentFeedReplay.java
"$jdk/java" -cp "$classes" dev.agaminggod.arenaagents.server.AgentFeedReplay "$@"
