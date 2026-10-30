#!/usr/bin/env bash
# Run this launcher under slot.sh live; detach with setsid -f for unattended verification.
# Usage: verify-savepoints-v2.sh CHECKPOINT_DIR OUT_DIR JAR [SHARD=0] [SHARDS=1]
set -u
checkpoints=$1; output=$2; jar=$3; shard=${4:-0}; shards=${5:-1}
mkdir -p "$output"
# Check final-stage fixtures first so dragon and portal setup failures appear early.
index=0; failures=0
while IFS= read -r file; do
  if (( index++ % shards != shard )); then continue; fi
  name=$(basename "$file" .json)
  if [[ -f "$output/$name/result.json" ]]; then continue; fi
  node scripts/quality/test-savepoints-live.mjs "$file" "$output/$name" "$jar" > "$output/$name.log" 2>&1
  rc=$?
  if ((rc)); then failures=$((failures+1)); fi
  echo "$(date -Is) $name exit=$rc" >> "$output/status-$shard.txt"
done < <(rg --files "$checkpoints" -g '*-v2.json' | sort -r)
echo "$(date -Is) complete failures=$failures" >> "$output/status-$shard.txt"
exit "$failures"
