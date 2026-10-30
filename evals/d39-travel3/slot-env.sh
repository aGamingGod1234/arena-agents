if [[ "$0" == /home/agaminggod/Desktop/Projects/arena-beat-game/slot.sh ]]; then
  flock() {
    if [[ "${1:-}" == -n ]]; then
      shift
      command flock -w 0.5 "$@"
    else
      command flock "$@"
    fi
  }
  sleep() {
    if [[ "$#" == 1 && "$1" == 10 ]]; then command sleep 0.2; else command sleep "$@"; fi
  }
fi
if [[ "$0" == x && "${1:-}" == codex && "${4:-}" == /home/agaminggod/Desktop/Projects/arena-beat-game/sub/long/d39-travel3-* && -n "${SLOT_PORT_BASE:-}" ]]; then
  python3 /tmp/d39-travel3/wait-ports.py "$SLOT_PORT_BASE" || exit $?
fi
