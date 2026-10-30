#!/usr/bin/env bash
# Mini PC: pull a finished trial from the Desktop and run the analyzer on it.
#   scripts/feel/collect.sh <trialId> <destDir> [extra analyze.mjs args]
# Writes <destDir>/<provider>/metrics.{md,json} and <destDir>/metrics.md (both agents side by side is not
# possible across worlds, so the combined file concatenates the per-provider tables).
set -euo pipefail
trial=${1:?trialId}; dest=${2:?destDir}; shift 2
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$dest"
scp -rq "desktop:aa-trials/runs/$trial/*" "$dest/"
: > "$dest/metrics.md"
for d in "$dest"/*/; do
	p=$(basename "$d")
	[ -f "$d/coordinator.jsonl" ] && [ -f "$d/server-latest.log" ] || { echo "skip $p (no artifacts)"; continue; }
	node "$here/analyze.mjs" --coordinator "$d/coordinator.jsonl" --log "$d/server-latest.log" \
		--label "$trial/$p" --out-md "$d/metrics.md" --out-json "$d/metrics.json" "$@"
	cat "$d/metrics.md" >> "$dest/metrics.md"; echo >> "$dest/metrics.md"
done
echo "wrote $dest/metrics.md"
