#!/bin/bash
# Headless Sol long runs on the Windows machines (desktop, laptop); same flags as long-sub.sh, build 95e3b0fb, files under %USERPROFILE%\arena-runner.
#   win-long.sh <host> start <tag> <checkpoint.json|-> <minutes> <max-cost> <port-base>   (refuses if < 6 GB RAM free)
#   win-long.sh <host> status
#   win-long.sh <host> stop <tag> [reason...]
#   win-long.sh <host> sync <tag>      copies <tag>-codex.log/.ledger.json/.done, the out dir and run artifacts (with arena-watch) to sub/long/
#   win-long.sh <host> sync-all        sync every game on that machine (safe to rerun, also mid-game)
#   win-long.sh <host> clean [0]       AA storage cleanup (bin/clean.ps1): reports what it would free; pass 0 to act
#   win-long.sh <host> install        re-copies the scripts in winrunner/bin to the machine
set -eu
h=$1; cmd=$2; shift 2
B=/home/agaminggod/Desktop/Projects/arena-beat-game; BIN=$B/api/winrunner/bin
ps() { local f=$1; shift; ssh -o BatchMode=yes "$h" "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File arena-runner\\bin\\$f $*"; }
case $cmd in
  install) ssh -o BatchMode=yes "$h" 'powershell -NoProfile -Command "New-Item -ItemType Directory -Force arena-runner/bin | Out-Null"' && scp -q "$BIN"/*.ps1 "$h":arena-runner/bin/ && echo installed;;
  start) cp=$2; [ "$cp" = - ] && cp=; ps start.ps1 -Tag "$1" ${cp:+-Checkpoint "$cp"} -Minutes "$3" -MaxCost "$4" -PortBase "$5";;
  status) ps status.ps1;;
  clean) ps clean.ps1 -Dry "${1:-1}";;
  stop) tag=$1; shift; reason=${*:-operator requested stop (no explanation supplied)}
    reason64=$(printf '%s' "$reason" | base64 -w0)
    # Use the local reviewed stop source; the Desktop may still have an older runner installed.
    stop64=$(python3 - "$BIN/stop.ps1" "$tag" "$reason64" <<'STOPPY'
import base64, pathlib, sys
quote = lambda value: "'" + value.replace("'", "''") + "'"
source = pathlib.Path(sys.argv[1]).read_text()
command = '& {\n' + source + '\n} -Tag ' + quote(sys.argv[2]) + ' -ReasonBase64 ' + quote(sys.argv[3])
print(base64.b64encode(command.encode('utf-16le')).decode())
STOPPY
    )
    ssh -o BatchMode=yes "$h" "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $stop64";;
  sync) tag=$1; dest=$(mktemp -d)
    ps pack.ps1 -Tag "$tag" >/dev/null || { echo "pack failed for $tag" >&2; exit 1; }
    scp -q "$h:arena-runner/sync/$tag-codex.tar" "$dest/$tag-codex.tar"
    # sub/long/* lands beside the Mini PC games; run artifacts go under sub/long/<tag>-codex/run-artifacts.
    tar -xf "$dest/$tag-codex.tar" -C "$B" sub/long
    mkdir -p "$B/sub/long/$tag-codex/run-artifacts"; tar -xf "$dest/$tag-codex.tar" -C "$B/sub/long/$tag-codex/run-artifacts" --strip-components=1 --wildcards 'r/*' 2>/dev/null || true
    [ -n "$(find "$B/sub/long/$tag-codex" -name auth.json -print -delete)" ] && echo "warning: removed a synced auth.json" >&2
    rm -rf "$dest"; echo "synced to $B/sub/long/$tag-codex{,.log,.ledger.json}";;
  sync-all) for tag in $(ps status.ps1 | sed -n 's/^\(.*\)-codex \[.*/\1/p'); do "$0" "$h" sync "$tag"; done;;
  *) echo "unknown command $cmd" >&2; exit 1;;
esac
