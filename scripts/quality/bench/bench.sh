#!/usr/bin/env bash
# bench.sh <tag> <jar> <coordinator-root> <codex|claude> [rooms...]
# Run under systemd-run --user --collect for an unattended sweep; each room holds a live slot.
set -euo pipefail
if (( $# < 4 )); then echo "usage: $0 <tag> <jar> <coordinator-root> <codex|claude> [rooms...]" >&2; exit 2; fi
tag=$1; jar=$(realpath "$2"); root=$(realpath "$3"); provider=$4; shift 4
B=/home/agaminggod/Desktop/Projects/arena-beat-game
[[ $tag =~ ^[A-Za-z0-9_-]+$ && $provider =~ ^(codex|claude)$ && -f $jar ]] || { echo 'Invalid tag, jar or provider' >&2; exit 2; }
export SCENARIO_FILE=${SCENARIO_FILE:-"$root/scripts/quality/reflex-rooms.json"}
mapfile -t selected < <(python3 - "$SCENARIO_FILE" "$@" <<'PY'
import json,sys
ids=[s['id'] for s in json.load(open(sys.argv[1]))['scenarios']]
selected=sys.argv[2:] or ids
if len(set(selected))!=len(selected) or any(s not in ids for s in selected):
 sys.exit('Unknown or duplicate room')
print('\n'.join(selected))
PY
)
(( ${#selected[@]} )) || { echo 'No valid rooms selected' >&2; exit 2; }
# Preflight every output before launching anything. Existing evidence is never overwritten.
for room in "${selected[@]}"; do
 for suffix in '' .log .done; do
  [[ ! -e "$B/sub/runs/$tag-$provider-$room-r1$suffix" ]] || { echo "Tag already used for $room; select a fresh tag" >&2; exit 2; }
 done
done
# ladder-sub.sh selects subscription auth, medium effort and default service tier.
if [[ $provider == codex ]] && ! grep -q -- '--service-tier default' "$B/api/ladder-sub.sh"; then
 echo 'Codex launcher must explicitly use the default service tier' >&2; exit 2
fi
for room in "${selected[@]}"; do
 echo "Running $room ($provider); artifacts: $B/sub/runs/$tag-$provider-$room-r1"
 "$B/api/ladder-sub.sh" "$tag" "$jar" "$root" "$provider" "$room" 1
done
python3 "$B/api/bench-score.py" "$tag"
