#!/bin/bash
# usage: [EFFORT=low] [CHECKPOINT=save.json] [MAX_COST=1000] [MODEL=id] long-sub.sh <tag> <jar> <coordinator-root> <codex|claude|opencode> [minutes]  Full "Beat the game" on a random seed (or from a save point), low effort by default, subscription logins, Sol at the standard tier. Output in sub/long/.
set -u
B=/home/agaminggod/Desktop/Projects/arena-beat-game
if [ "${1:-}" = stop ]; then
  tag=$2; prov=$3; shift 3; reason=${*:-operator requested stop (no explanation supplied)}
  out=$B/sub/long/$tag-$prov
  [ -f "$out.pid" ] || { echo "no pid record for $tag" >&2; exit 1; }
  kill -0 "$(cat "$out.pid")" 2>/dev/null || { echo "not running: $tag" >&2; exit 1; }
  node "$B/api/record-stop.mjs" "$out" "$reason"
  if systemctl --user is-active --quiet "sq-$tag"; then systemctl --user stop "sq-$tag"; else kill -TERM "$(cat "$out.pid")"; fi
  exit
fi
tag=$1; jar=$2; root=$3; prov=$4; mins=${5:-90}
B=/home/agaminggod/Desktop/Projects/arena-beat-game; out=$B/sub/long/$tag-$prov; mkdir -p $B/sub/long
mkdir -p "$out"
echo $$ > "$out.pid"
trap 'rm -f "$out.pid"' EXIT
unset OPENAI_API_KEY ANTHROPIC_API_KEY CODEX_HOME CLAUDE_CONFIG_DIR
export JAVA_HOME=/usr/lib/jvm/temurin-25-jdk-amd64
# opencode = OpenCode's free models (MODEL=opencode/glm-5.3-flash-free for GLM); needs opencode installed and logged in.
case $prov in
  codex) model=${MODEL:-gpt-6.1-sol}; extra="--service-tier default";;
  opencode) model=${MODEL:-opencode/deepseek-v4.1-flash-free}; extra="";;
  *) model=${MODEL:-claude-opus-5-5}; extra="";;
esac
cd "$root"
setsid $B/slot.sh live bash -c 'exec node scripts/quality/run-long.mjs --provider "$1" --model "$2" --effort ${EFFORT:-low} '"$extra"' ${CHECKPOINT:+--checkpoint "$CHECKPOINT"} --codex-observer-cap yes --budget-minutes "$3" --max-total-cost-usd ${MAX_COST:-1000} --ledger "$4.ledger.json" --port-base "$SLOT_PORT_BASE" --jar "$5" --coordinator-root "$6" --server-template "/home/agaminggod/.t3/worktrees/agents arena/t3-ba7399a1/runtime/server-template" --java /usr/lib/jvm/temurin-25-jdk-amd64/bin/java --out "$4"' x "$prov" "$model" "$mins" "$out" "$jar" "$root" > "$out.log" 2>&1 &
worker=$!
trap 'kill -TERM -- "-$worker" 2>/dev/null; wait "$worker"; exit 143' TERM INT
wait "$worker"
rc=$?
echo "exit $rc $(date -Is)" > $out.done
