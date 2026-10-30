#!/bin/bash
set -u
E=/home/agaminggod/Desktop/Projects/arena-beat-game/evals/d39-travel3
while [ ! -f "$E/games.done" ]; do
  if rg -q 'REQUIRES_INSPECTION' "$E/games-state.json"; then
    echo 2 > "$E/finalize.exit"
    exit 2
  fi
  sleep 15
done
python3 /tmp/d39-travel3/finalize.py > "$E/finalize.log" 2>&1
rc=$?
echo "$rc" > "$E/finalize.exit"
if [ "$rc" -ne 0 ]; then exit "$rc"; fi
python3 "$E/render-report.py" > "$E/render-report.log" 2>&1
rc=$?
echo "$rc" > "$E/render-report.exit"
exit "$rc"
