#!/usr/bin/env bash
# All 23 ladder links (or explicitly selected links); same subscription runner and scorer.
set -euo pipefail
(( $# >= 4 )) || { echo "usage: $0 <tag> <jar> <coordinator-root> <codex|claude> [steps...]" >&2; exit 2; }
export SCENARIO_FILE="$(realpath "$3")/scripts/quality/ladder.json"
exec "$(dirname "$0")/bench.sh" "$@"
