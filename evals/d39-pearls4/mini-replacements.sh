#!/bin/bash
set -euo pipefail
b=/home/agaminggod/Desktop/Projects/arena-beat-game
h=/home/agaminggod/Desktop/Projects/aa-d39-pearls4
r=/home/agaminggod/Desktop/Projects/aa-d39-pearls4-live-af6
base=/home/agaminggod/Desktop/Projects/aa-d39-pearls4-base
a=$b/evals/d39-pearls4
export JAVA_HOME=/usr/lib/jvm/temurin-25-jdk-amd64
export ARENA_HEADLESS_SERVER_TEMPLATE='/home/agaminggod/.t3/worktrees/agents arena/t3-ba7399a1/runtime/server-template'
export REPLAY_JAVA_OPTS=-XX:ActiveProcessorCount=4
unset OPENAI_API_KEY ANTHROPIC_API_KEY CODEX_HOME CLAUDE_CONFIG_DIR
kind=$1;shift
if [ "$kind" = live ]; then
 seed=$1
 exec "$b/slot.sh" live bash "$0" live-admitted "$seed"
fi
if [ "$kind" = live-admitted ]; then
 seed=$1;tag=d39-pearls4-$seed-r4-mini;out=$b/sub/long/$tag-codex
 [ "$(git -C "$r" rev-parse HEAD)" = af6f3f0958614ac6401709ba2e3f1fe62399f5c2 ]
 [ ! -e "$out/long-run.json" ]
 mkdir -p "$out";cd "$h"
 printf '{"tag":"%s","admittedAt":"%s","port":%s,"runtime":"af6f3f09","model":"gpt-6.1-sol","effort":"low","tier":"default"}\n' "$tag" "$(date -Is)" "$SLOT_PORT_BASE" > "$a/$tag-admitted.json"
 set +e
 node scripts/quality/run-long.mjs --provider codex --model gpt-6.1-sol --effort low --service-tier default --checkpoint "$b/long/checkpoints/9-nether-entry-$seed-v2.json" --codex-observer-cap yes --budget-minutes 90 --max-total-cost-usd 1000 --ledger "$out.ledger.json" --port-base "$SLOT_PORT_BASE" --jar "$a/windows-base.jar" --coordinator-root "$r" --server-template "$ARENA_HEADLESS_SERVER_TEMPLATE" --java "$JAVA_HOME/bin/java" --out "$out" > "$out.log" 2>&1
 rc=$?;printf 'exit %s %s\n' "$rc" "$(date -Is)" > "$out.done";exit "$rc"
fi
if [ "$kind" = physical ]; then
 cmp "$h/scripts/quality/test-gold-route-live.mjs" "$base/scripts/quality/test-gold-route-live.mjs"
 i=0
 while read -r arm seed salt;do
  "$b/slot.sh" live bash "$0" physical-admitted "$arm" "$seed" "$salt" "$i"
  i=$((i+1))
 done <<'CASES'
base 8675309 3
candidate 8675309 3
base 987654321 2
base 987654321 3
candidate 987654321 3
base 20261024 2
base 20261024 3
candidate 20261024 3
CASES
 exit 0
fi
if [ "$kind" = physical-pairing ];then
 "$b/slot.sh" live bash "$0" physical-admitted candidate 987654321 2 8
 "$b/slot.sh" live bash "$0" physical-admitted candidate 20261024 2 9
 exit 0
fi
if [ "$kind" = physical-admitted ];then
 arm=$1;seed=$2;salt=$3;ordinal=$4
 root=$h;[ "$arm" != base ]||root=$base
 out=$a/physical-mini/$arm/$seed-r$salt-mini1
 [ ! -e "$out" ];mkdir -p "$(dirname "$out")";cd "$root"
 export SLOT_PORT_BASE=$((SLOT_PORT_BASE+ordinal*8))
 printf '{"arm":"%s","seed":"%s","salt":%s,"admittedAt":"%s","port":%s}\n' "$arm" "$seed" "$salt" "$(date -Is)" "$SLOT_PORT_BASE" >> "$a/mini-physical-admissions.jsonl"
 node scripts/quality/test-gold-route-live.mjs "$b/long/checkpoints/9-nether-entry-$seed-v2.json" "$out" "$a/windows-base.jar" 600 "$salt" > "$out.log" 2>&1
 exit 0
fi
printf 'unknown job kind\n' >&2;exit 2
