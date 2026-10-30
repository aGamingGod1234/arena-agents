#!/bin/bash
# Keeps up to MAXG Sol games running. Queue file lines: tag|checkpoint-or-none|minutes|maxcost|jar|root  (first unstarted line runs next).
# A line is started once (tag.started marker). Starts only with >= MINFREE GB available.
B=/home/agaminggod/Desktop/Projects/arena-beat-game; Q=$B/api/sol-queue.txt; MAXG=${MAXG:-4}; MINFREE=${MINFREE:-5}
if [ "${1:-}" = stop ]; then
  tag=$2; shift 2
  systemctl --user is-active --quiet "sq-$tag" || { echo "not running: $tag" >&2; exit 1; }
  node "$B/api/record-stop.mjs" "$B/sub/long/$tag-codex" "${*:-queue operator requested stop (no explanation supplied)}"
  systemctl --user stop "sq-$tag"
  exit
fi
mkdir -p $B/api/queue-state
while true; do
  running=$(systemctl --user list-units --no-legend --state=running 'sq-*' | wc -l)
  avail=$(free -g | awk 'NR==2{print $7}')
  if [ "$running" -lt "$MAXG" ] && [ "$avail" -ge "$MINFREE" ]; then
    line=$(grep -v '^#' $Q | while IFS='|' read -r tag cp mins cost jar root; do [ -n "$tag" ] && [ ! -f $B/api/queue-state/$tag.started ] && { echo "$tag|$cp|$mins|$cost|$jar|$root"; break; }; done)
    if [ -n "$line" ]; then
      IFS='|' read -r tag cp mins cost jar root <<< "$line"
      env=(-E MAX_COST=$cost -E EFFORT=low); [ "$cp" != none ] && env+=(-E CHECKPOINT=$B/long/checkpoints/$cp.json)
      systemd-run --user --slice=app.slice --unit=sq-$tag --collect "${env[@]}" $B/api/long-sub.sh $tag $B/jars/$jar /home/agaminggod/Desktop/Projects/$root codex $mins
      touch $B/api/queue-state/$tag.started; echo "$(date -Is) started $tag ($cp, $mins min, \$$cost, $jar) avail=${avail}G running=$running" >> $B/api/sol-queue.log
      sleep 90; continue
    fi
  fi
  sleep 60
done
