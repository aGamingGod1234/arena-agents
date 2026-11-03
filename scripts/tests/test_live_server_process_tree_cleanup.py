"""Owned subprocess-tree regressions through LiveServer.start()/stop(), without Gradle."""
import ctypes
import base64
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
pathlib.Path(sys.argv[1] + '.writing').write_text(str(child.pid))
os.replace(sys.argv[1] + '.writing', sys.argv[1])
time.sleep(60)
''') + ''', sys.argv[1] + '.grandchild'])
path = pathlib.Path(sys.argv[1] + '.grandchild')
while not path.exists():
    time.sleep(.01)
pathlib.Path(sys.argv[1] + '.writing').write_text(json.dumps([child.pid, int(path.read_text())]))
os.replace(sys.argv[1] + '.writing', sys.argv[1])
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


@unittest.skipUnless(sys.platform == 'linux', 'real Linux owned-process tests')
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
            try:
                os.killpg(self.server.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
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
        # The deliberately short startup budget may expire before the fixture publishes its children.
        deadline = time.monotonic() + 5
        while not self.pids_file.exists() and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertEqual(2, len(self.descendants()))
        self.server.stop(timeout=.02)
        self.assert_tree_stopped()

    def test_exited_launcher_does_not_hide_surviving_descendants(self):
        self.start_tree()
        launcher = int(Path(f'/proc/{self.server.process.pid}/task/{self.server.process.pid}/children').read_text().split()[0])
        os.kill(launcher, signal.SIGTERM)
        self.server.stop(timeout=5)
        self.assert_tree_stopped()

    def test_graceful_rcon_shutdown_retains_successful_exit(self):
        self.start_tree()
        def graceful_stop(command):
            for pid in reversed(self.descendants()):
                os.kill(pid, signal.SIGTERM)
            launcher = int(Path(f'/proc/{self.server.process.pid}/task/{self.server.process.pid}/children').read_text().split()[0])
            os.kill(launcher, signal.SIGTERM)
        self.server.rcon.command.side_effect = graceful_stop
        code = self.server.stop(timeout=5)
        self.assertEqual(0, code)
        self.assert_tree_stopped()

    @unittest.skipUnless(sys.platform == 'linux', 'checks real Gradle process groups on Linux')
    def test_real_gradle_daemon_stays_in_owned_group(self):
        cache = Path.home() / '.gradle/wrapper/dists'
        if not list(cache.glob('gradle-9.8.2-bin/*/gradle-9.8.2/bin/gradle')):
            self.skipTest('requires the pinned Gradle distribution already cached')
        directory = self.pids_file.parent
        (directory / 'settings.gradle').write_text("rootProject.name = 'owned-process-regression'\n")
        (directory / 'gradle.properties').write_text('org.gradle.jvmargs=-Xmx1G\n')
        (directory / 'build.gradle').write_text('''tasks.register('hold') { doLast {
            def child = new ProcessBuilder(PYTHON, '-c', 'import time; time.sleep(60)').start()
            new File(PIDS).text = '[' + ProcessHandle.current().pid() + ',' + child.pid() + ']'
            println(' Done (1.0s)! For help')
            Thread.sleep(60000)
        } }
'''.replace('PYTHON', json.dumps(sys.executable)).replace('PIDS', json.dumps(str(self.pids_file))))
        command = live_server.LiveServer._gradle(self.server, '-p', str(directory), 'hold')
        with mock.patch.object(self.server, '_gradle', return_value=command), \
                mock.patch.object(live_server, 'Rcon', return_value=mock.Mock()):
            try:
                self.server.start(timeout=60)
            except Exception:
                print(self.server.read_log(), file=sys.stderr)
                raise
        self.assertEqual(2, len(self.descendants()))
        self.assertNotEqual(self.server.process.pid, os.getpgid(self.descendants()[0]),
                            'exercise the real detached Gradle daemon')
        self.server.stop(timeout=.02)
        self.assert_tree_stopped()


class WindowsTreeCleanupContractTest(unittest.TestCase):
    def test_timeout_terminates_the_owned_job_wrapper(self):
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
                    command = launch.call_args.args[0]
                    self.assertIn('owned-windows-job.ps1', command[command.index('-File') + 1])
                    invocation = json.loads(base64.b64decode(command[-1]))
                    self.assertIn('args', invocation)
                    self.assertNotIn('env', invocation)
                    kill_tree.assert_not_called()
                    self.assertEqual([mock.call(.02), mock.call()], process.wait.call_args_list)
                    process.kill.assert_called_once_with()
                finally:
                    if hasattr(server, 'log'):
                        server.log.close()

    def test_exited_wrapper_has_already_closed_its_owned_job(self):
        server = live_server.LiveServer()
        server.process = mock.Mock(returncode=0)
        server.rcon = mock.Mock()
        server.log = mock.Mock()
        with mock.patch.object(live_server.os, 'name', 'nt'), \
                mock.patch.object(subprocess, 'run') as kill_tree:
            self.assertEqual(0, server.stop(timeout=5))
            kill_tree.assert_not_called()
        server.process.wait.assert_called_once_with(5)
        server.process.kill.assert_not_called()
        server.log.close.assert_called_once_with()
        wrapper = (ROOT / 'coordinator/src/owned-windows-job.ps1').read_text()
        self.assertLess(wrapper.index('[ArenaOwnedJob]::Attach()'), wrapper.index('[ArenaOwnedJob]::Run('))
        self.assertIn('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE', wrapper)
        self.assertIn('child.WaitForExit();\n            StopRemainingMembers();', wrapper)


if __name__ == '__main__':
    unittest.main()
