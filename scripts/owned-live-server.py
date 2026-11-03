#!/usr/bin/env python3
"""Own one Linux workload, including Gradle descendants that detach or outlive its launcher."""
import ctypes
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def children(pid):
    try:
        return [int(value) for value in Path(f'/proc/{pid}/task/{pid}/children').read_text().split()]
    except FileNotFoundError:
        return []


def descendants(owner):
    found = children(owner)
    for pid in found:
        found.extend(children(pid))
    return found


def belongs_to(pid, owner):
    while pid > 1 and pid != owner:
        try:
            pid = int(Path(f'/proc/{pid}/stat').read_text().split(') ', 1)[1].split()[1])
        except FileNotFoundError:
            return False
    return pid == owner


def stop_descendants(owner):
    for pid in reversed(descendants(owner)):
        try:
            descriptor = os.pidfd_open(pid)
        except ProcessLookupError:
            continue
        try:
            # Check ancestry after retaining identity; a recycled, unrelated PID must never be signalled.
            if belongs_to(pid, owner):
                try:
                    signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        finally:
            os.close(descriptor)


def main(command):
    if sys.platform != 'linux' or not hasattr(os, 'pidfd_open'):
        raise RuntimeError('Owned live-server supervision requires Linux with pidfd support')
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER, before any workload can detach.
        raise OSError(ctypes.get_errno(), 'Cannot establish live-server child ownership')
    stopping = False

    def terminate(*_):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    launcher = subprocess.Popen(command)
    try:
        while launcher.poll() is None and not stopping:
            time.sleep(.02)
    finally:
        stop_descendants(os.getpid())
        launcher.wait()
        # Detached grandchildren are adopted here. Repeat to cover forks concurrent with shutdown.
        while True:
            stop_descendants(os.getpid())
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                break
            if pid == 0:
                time.sleep(.01)
    return launcher.returncode


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
