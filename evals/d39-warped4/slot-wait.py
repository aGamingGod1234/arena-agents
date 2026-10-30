#!/usr/bin/env python3
"""Hold one of slot.sh's live slots (same lock files and count), waiting in the kernel on every lock at once, after first
taking one of this helper's own tokens (two for games, one for stand-in trials).
usage: slot-wait.py <command...>   Exports SLOT and SLOT_PORT_BASE like slot.sh."""
import fcntl, os, subprocess, sys, threading
D = '/home/agaminggod/Desktop/Projects/arena-beat-game/locks'
def first(paths):
    won = threading.Event(); guard = threading.Lock(); chosen = []
    def wait(i, p):
        fd = os.open(p, os.O_WRONLY | os.O_CREAT, 0o664)
        fcntl.flock(fd, fcntl.LOCK_EX)
        with guard:
            if not chosen:
                chosen.append(i); won.set(); return
        fcntl.flock(fd, fcntl.LOCK_UN); os.close(fd)
    for i, p in enumerate(paths): threading.Thread(target=wait, args=(i, p), daemon=True).start()
    won.wait(); return chosen[0]
# Own tokens: games take the two 'own' tokens; the model-free stand-in takes its single 'phys' token (SLOT_TOKENS=phys:1).
name, count = os.environ.get('SLOT_TOKENS', 'own:2').split(':')
first([f'/tmp/d39-pearls4-{name}-{i}.lock' for i in range(int(count))])
n = int(open(f'{D}/live-slots').read().strip() or 3)
i = first([f'{D}/live-{i}.lock' for i in range(n)])
print(f'[slot-wait] holding live-{i}', file=sys.stderr, flush=True)
env = dict(os.environ, SLOT=str(i), SLOT_PORT_BASE=str(28000 + i * 100))
os._exit(subprocess.call(sys.argv[1:], env=env))
