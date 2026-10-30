#!/bin/bash
set -euo pipefail
b=/home/agaminggod/Desktop/Projects/arena-beat-game
h=/home/agaminggod/Desktop/Projects/aa-d39-pearls4
a=$b/evals/d39-warped4
kind=$1;shift
export JAVA_HOME=/usr/lib/jvm/temurin-25-jdk-amd64
export ARENA_HEADLESS_SERVER_TEMPLATE='/home/agaminggod/.t3/worktrees/agents arena/t3-ba7399a1/runtime/server-template'
unset OPENAI_API_KEY ANTHROPIC_API_KEY CODEX_HOME CLAUDE_CONFIG_DIR
cd "$h"
finished() {
 [ -f "$1.done" ]&&[ ! -e "$1.void.json" ]&&[ ! -e "$1.monitor-error.json" ]||return 1
 node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1]));process.exit(r.windowMs===3600000&&r.ending?.reason==="WALL_CLOCK_BUDGET"?0:1)' "$1/long-run.json"
}
remember() {
 mkdir -p "$a/completed-games${ROUND:+-$ROUND}"
 node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({out:process.argv[2],at:new Date().toISOString()})+"\n")' "$a/completed-games${ROUND:+-$ROUND}/$seed.json" "$out"
}
if [ "$kind" = admitted ];then
 seed=$1;attempt=$2;tag=d39-warped4-$seed-${ROUND:-r}$attempt-mini
 probe=$a/probes/$tag.json
 # Check after admission, immediately before the launch; failed probes release the live slot.
 bash evals/d39-warped4/probe-exec.sh "$probe" || exit 76
 runtime=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).coordinatorRoot)' "$a/games-frozen.json")
 commit=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).coordinatorCommit)' "$a/games-frozen.json")
 [ "$(git -C "$runtime" rev-parse HEAD)" = "$commit" ]&&git -C "$runtime" diff --quiet -- coordinator/src coordinator/config||{ echo 'Player runtime changed since freeze' >&2;exit 75;}
 out=$b/sub/long/$tag-codex
 node evals/d39-warped4/supervise-live.mjs "$out" --provider codex --model "${MODEL:-gpt-6.1-sol}" --effort low --service-tier default --checkpoint "$a/survey/$seed/checkpoint.json" --goal 'Beat the game. First gather and retain 12 ender pearls here; prefer warped-forest endermen, with seen gold and held ingots as secondary supply.' --codex-observer-cap yes --budget-minutes 60 --max-total-cost-usd 1000 --ledger "$out.ledger.json" --port-base "$SLOT_PORT_BASE" --jar "$b/evals/d39-pearls4/windows-base.jar" --coordinator-root "$runtime" --server-template "$ARENA_HEADLESS_SERVER_TEMPLATE" --java "$JAVA_HOME/bin/java"
 exit $?
fi
if [ "$kind" = worker ];then
 worker=$1
 i=0
 for seed in ${SEEDS:-123456789 8675309 987654321 20261024};do
  if [ $((i%2)) -eq "$worker" ];then
   if [ -f "$a/completed-games${ROUND:+-$ROUND}/$seed.json" ];then i=$((i+1));continue;fi
   attempt=1
   while [ "$attempt" -le "${MAXATT:-4}" ];do
    out=$b/sub/long/d39-warped4-$seed-${ROUND:-r}$attempt-mini-codex
    if [ -e "$out.done" ];then
     if finished "$out";then remember;break;fi
     attempt=$((attempt+1));continue
    fi
    if ! bash evals/d39-warped4/probe-exec.sh "$a/probes/preflight-$seed-${ROUND:-r}$attempt.json";then
     sleep 60;continue
    fi
    set +e
    python3 evals/d39-warped4/slot-wait.py bash "$0" admitted "$seed" "$attempt"
    rc=$?
    set -e
    if [ "$rc" -eq 0 ]&&finished "$out";then remember;break;fi
    printf 'seed %s attempt %s unavailable or void; exit %s at %s\n' "$seed" "$attempt" "$rc" "$(date -Is)"
    attempt=$((attempt+1))
    sleep 60
   done
  fi
  i=$((i+1))
 done
 exit 0
fi
printf 'Unknown job\n' >&2;exit 2
