"""Owned subprocess-tree regressions through LiveServer.start()/stop(), without Gradle."""
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('live_server_cleanup', ROOT / 'scripts/live-server.py')
live_server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(live_server)

# The launcher owns a child which itself owns a grandchild, like Gradle and runServer.
LAUNCHER = '''
import json, os, pathlib, signal, subprocess, sys, time
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
child = subprocess.Popen([sys.executable, '-c', ''' + repr('''
import os, pathlib, subprocess, sys, time
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
pathlib.Path(sys.argv[1]).write_text(str(child.pid))
time.sleep(60)
''') + ''', sys.argv[1] + '.grandchild'])
path = pathlib.Path(sys.argv[1] + '.grandchild')
while not path.exists():
    time.sleep(.01)
pathlib.Path(sys.argv[1]).write_text(json.dumps([child.pid, int(path.read_text())]))
print(' Done (1.0s)! For help', flush=True)
time.sleep(60)
'''


def running(pid):
    try:
        # A killed orphan can remain a zombie until its new parent reaps it.
        stat = Path(f'/proc/{pid}/stat')
        if stat.exists() and stat.read_text().split(') ', 1)[1].startswith('Z'):
            return False
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


@unittest.skipUnless(os.name == 'posix', 'real POSIX process group tests')
class ProcessTreeCleanupTest(unittest.TestCase):
    def setUp(self):
        if sys.platform == 'linux':
            # Reap fixture orphans ourselves, including when testing the broken implementation.
            libc = ctypes.CDLL(None, use_errno=True)
            previous = ctypes.c_int()
            self.assertEqual(0, libc.prctl(37, ctypes.byref(previous), 0, 0, 0))
            self.assertEqual(0, libc.prctl(36, 1, 0, 0, 0))
            self.addCleanup(lambda: libc.prctl(36, previous.value, 0, 0, 0))
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.pids_file = Path(directory.name) / 'pids.json'
        self.server = live_server.LiveServer(run_dir=directory.name)
        self.addCleanup(self.cleanup_tree)
        self.patches = [mock.patch.object(self.server, 'prepare'),
                        mock.patch.object(self.server, '_gradle', return_value=[
                            sys.executable, '-u', '-c', LAUNCHER, str(self.pids_file)])]
        for patch in self.patches:
            patch.start()
            self.addCleanup(patch.stop)

    def descendants(self):
        return json.loads(self.pids_file.read_text()) if self.pids_file.exists() else []

    def cleanup_tree(self):
        pids = self.descendants()
        if self.server.process:
            pids.insert(0, self.server.process.pid)
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if self.server.process:
            self.server.process.wait(timeout=5)
        for pid in pids[1:]:
            try:
                os.waitpid(pid, 0)
            except ChildProcessError:
                pass
        if hasattr(self.server, 'log'):
            self.server.log.close()

    def start_tree(self):
        with mock.patch.object(live_server, 'Rcon', return_value=mock.Mock()):
            self.server.start(timeout=5)
        self.assertEqual(2, len(self.descendants()))
        self.assertTrue(all(running(pid) for pid in self.descendants()))

    def assert_tree_stopped(self):
        deadline = time.monotonic() + 3
        while any(running(pid) for pid in self.descendants()) and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertFalse(any(running(pid) for pid in self.descendants()),
                         'server descendants survived stop()')
        self.assertIsNotNone(self.server.process.returncode)
        self.assertTrue(self.server.log.closed)

    def test_shutdown_timeout_kills_descendants_but_not_unrelated_process(self):
        unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        def cleanup_unrelated():
            unrelated.kill()
            unrelated.wait(timeout=5)
        self.addCleanup(cleanup_unrelated)
        self.start_tree()
        rcon = self.server.rcon
        self.server.stop(timeout=.02)
        rcon.command.assert_called_once_with('stop')
        rcon.close.assert_called_once_with()
        self.assert_tree_stopped()
        self.assertIsNone(unrelated.poll())
        self.server.stop(timeout=.02)  # repeated cleanup must be harmless

    def test_startup_without_rcon_is_cleaned_on_shutdown_timeout(self):
        with mock.patch.object(live_server, 'Rcon', side_effect=ConnectionRefusedError()):
            with self.assertRaises(TimeoutError):
                self.server.start(timeout=.5)
        self.assertEqual(2, len(self.descendants()))
        self.server.stop(timeout=.02)
        self.assert_tree_stopped()

    def test_exited_launcher_does_not_hide_surviving_descendants(self):
        self.start_tree()
        self.server.process.terminate()
        self.server.process.wait(timeout=5)
        self.assertTrue(all(running(pid) for pid in self.descendants()))
        self.server.stop(timeout=.02)
        self.assert_tree_stopped()

    def test_graceful_rcon_shutdown_retains_successful_exit(self):
        self.start_tree()
        def graceful_stop(command):
            for pid in reversed(self.descendants()):
                os.kill(pid, signal.SIGTERM)
            self.server.process.terminate()
        self.server.rcon.command.side_effect = graceful_stop
        code = self.server.stop(timeout=5)
        self.assertEqual(0, code)
        self.assert_tree_stopped()


class WindowsTreeCleanupContractTest(unittest.TestCase):
    def test_timeout_uses_only_launched_pid_and_tree_switch(self):
        with tempfile.TemporaryDirectory() as directory:
            server = live_server.LiveServer(run_dir=directory)
            process = mock.Mock(pid=12345, returncode=0)
            process.wait.side_effect = [subprocess.TimeoutExpired('fixture', .02), 0]
            with mock.patch.object(server, 'prepare'), \
                    mock.patch.object(server, 'read_log', return_value=' Done (1.0s)! For help'), \
                    mock.patch.object(live_server, 'Rcon'), \
                    mock.patch.object(live_server.os, 'name', 'nt'), \
                    mock.patch.object(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0x200, create=True), \
                    mock.patch.object(subprocess, 'Popen', return_value=process) as launch, \
                    mock.patch.object(subprocess, 'run') as kill_tree:
                try:
                    server.start(timeout=5)
                    self.assertEqual(0, server.stop(timeout=.02))
                    self.assertEqual(0x200, launch.call_args.kwargs['creationflags'])
                    self.assertNotIn('start_new_session', launch.call_args.kwargs)
                    kill_tree.assert_called_once_with(
                        ['taskkill', '/PID', '12345', '/T', '/F'], check=True,
                        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                    self.assertEqual([mock.call(.02), mock.call()], process.wait.call_args_list)
                    process.kill.assert_not_called()
                finally:
                    if hasattr(server, 'log'):
                        server.log.close()

    def test_graceful_exit_does_not_invoke_taskkill(self):
        server = live_server.LiveServer()
        server.process = mock.Mock(returncode=0)
        server.rcon = mock.Mock()
        server.log = mock.Mock()
        with mock.patch.object(live_server.os, 'name', 'nt'), \
                mock.patch.object(subprocess, 'run') as kill_tree:
            self.assertEqual(0, server.stop(timeout=5))
            kill_tree.assert_not_called()
        server.process.wait.assert_called_once_with(5)
        server.log.close.assert_called_once_with()


if __name__ == '__main__':
    unittest.main()
