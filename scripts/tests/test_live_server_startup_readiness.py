"""Focused startup regressions through LiveServer.start(), without Gradle/Minecraft."""
import importlib.util
from pathlib import Path
import tempfile
import socket
import struct
import threading
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('live_server_readiness', ROOT / 'scripts/live-server.py')
live_server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(live_server)
DONE = ' Done (1.0s)! For help'


class StartupReadinessTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.server = live_server.LiveServer(run_dir=directory.name)
        self.addCleanup(lambda: getattr(self.server, 'log', None) and self.server.log.close())
        self.process = mock.Mock(returncode=17)
        self.process.poll.return_value = None
        self.now = 0
        for patch in (
            mock.patch.object(self.server, 'prepare'),
            mock.patch.object(self.server, 'read_log', return_value=DONE),
            mock.patch.object(live_server.subprocess, 'Popen', return_value=self.process),
            mock.patch.object(live_server.time, 'time', side_effect=lambda: self.now),
            mock.patch.object(live_server.time, 'monotonic', side_effect=lambda: self.now),
            mock.patch.object(live_server.time, 'sleep', side_effect=self.sleep),
        ):
            patch.start()
            self.addCleanup(patch.stop)

    def sleep(self, seconds):
        self.now += seconds

    def test_done_before_listener_retries_until_authenticated(self):
        authenticated = mock.Mock()
        with mock.patch.object(live_server, 'Rcon', side_effect=[
            ConnectionRefusedError(), ConnectionRefusedError(), authenticated,
        ]) as connect:
            self.assertIs(self.server.start(timeout=900), self.server)
        self.assertEqual(3, connect.call_count)
        self.assertIs(authenticated, self.server.rcon)
        self.assertEqual(2, self.now)

    def test_process_exit_after_done_is_reported_during_retry(self):
        self.process.poll.side_effect = [None, 17]
        with mock.patch.object(live_server, 'Rcon', side_effect=ConnectionRefusedError()), \
                self.assertRaisesRegex(RuntimeError, 'server exited with 17'):
            self.server.start(timeout=900)
        self.assertLess(self.now, 900)

    def test_retry_completes_real_rcon_authentication(self):
        client, peer = socket.socketpair()
        self.addCleanup(client.close)
        self.addCleanup(peer.close)
        peer.settimeout(2)
        packets = []

        def authenticate():
            # Exercise the production framing and authentication on real sockets.
            with peer.makefile('rb') as stream:
                length = struct.unpack('<i', stream.read(4))[0]
                packet = stream.read(length)
                packets.append(packet)
                request, kind = struct.unpack('<ii', packet[:8])
                reply = struct.pack('<ii', request, 2) + b'\x00\x00'
                peer.sendall(struct.pack('<i', len(reply)) + reply)

        worker = threading.Thread(target=authenticate, daemon=True)
        worker.start()
        with mock.patch.object(live_server.socket, 'create_connection', side_effect=[
            ConnectionRefusedError(), client,
        ]) as connect:
            self.assertIs(self.server.start(timeout=5), self.server)
        worker.join(timeout=2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(2, connect.call_count)
        self.assertEqual(3, struct.unpack('<ii', packets[0][:8])[1])
        self.assertEqual(self.server.password, packets[0][8:-2].decode())
        self.assertEqual(30, client.gettimeout())

    def test_retry_uses_remaining_deadline(self):
        def unavailable(port, password, timeout):
            self.assertGreater(timeout, 0)
            self.assertLessEqual(timeout, 2.5 - self.now)
            self.sleep(timeout)
            raise TimeoutError('RCON authentication did not answer')

        with mock.patch.object(live_server, 'Rcon', side_effect=unavailable), \
                self.assertRaisesRegex(TimeoutError, 'server was not ready in 2.5 s'):
            self.server.start(timeout=2.5)
        self.assertEqual(2.5, self.now)
        self.assertIsNone(self.server.rcon)

    def test_no_rcon_attempt_before_done(self):
        self.server.read_log.return_value = 'Preparing world'
        with mock.patch.object(live_server, 'Rcon') as connect, \
                self.assertRaisesRegex(TimeoutError, 'server was not ready'):
            self.server.start(timeout=2)
        connect.assert_not_called()

    def test_login_refusal_is_not_retried(self):
        with mock.patch.object(live_server, 'Rcon', side_effect=RuntimeError('RCON login was refused')) as connect, \
                self.assertRaisesRegex(RuntimeError, 'RCON login was refused'):
            self.server.start()
        self.assertEqual(1, connect.call_count)

    def test_failed_authentication_closes_socket(self):
        connection = mock.Mock()
        with mock.patch.object(live_server.socket, 'create_connection', return_value=connection), \
                mock.patch.object(live_server.Rcon, '_send', side_effect=TimeoutError()), \
                self.assertRaises(TimeoutError):
            live_server.Rcon(12345, 'fixture-password')
        connection.close.assert_called_once_with()


if __name__ == '__main__':
    unittest.main()
