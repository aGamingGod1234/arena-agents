"""F31 transport regressions: real socket peers, no Minecraft/Gradle process."""
import importlib.util
import itertools
from pathlib import Path
import socket
import struct
import threading
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('f31_live_server', Path(__file__).resolve().parents[1] / 'live-server.py')
live = importlib.util.module_from_spec(spec)
spec.loader.exec_module(live)


def frame(request, kind, body=b''):
    if isinstance(body, str):
        body = body.encode()
    payload = struct.pack('<ii', request, kind) + body + b'\0\0'
    return struct.pack('<i', len(payload)) + payload


def receive(sock):
    def read(count):
        data = b''
        while len(data) < count:
            chunk = sock.recv(count - len(data))
            if not chunk:
                raise EOFError('fixture peer closed')
            data += chunk
        return data
    payload = read(struct.unpack('<i', read(4))[0])
    return (*struct.unpack('<ii', payload[:8]), payload[8:-2])


class MultipartRconTest(unittest.TestCase):
    def peer(self, script, auth=None, timeout=1):
        client, peer = socket.socketpair()
        client.settimeout(timeout)
        peer.settimeout(2)
        errors = []

        def run():
            try:
                request, kind, password = receive(peer)
                self.assertEqual((3, b'fixture-password'), (kind, password))
                if auth is None:
                    peer.sendall(frame(request, 2))
                else:
                    auth(peer, request)
                script(peer)
            except BaseException as error:
                errors.append(error)
            finally:
                peer.close()

        worker = threading.Thread(target=run, daemon=True)
        worker.start()

        def cleanup():
            client.close()
            worker.join(3)
            self.assertFalse(worker.is_alive(), 'socket fixture did not finish')
            if errors:
                raise errors[0]
        self.addCleanup(cleanup)
        return client

    def connect(self, connection):
        with mock.patch.object(live.socket, 'create_connection', return_value=connection):
            return live.Rcon(12345, 'fixture-password')

    def marker(self, peer, command_id):
        request, kind, text = receive(peer)
        self.assertNotEqual(command_id, request)
        self.assertEqual((0, b''), (kind, text))
        return request

    def test_multipart_and_consecutive_commands_through_live_server(self):
        def script(peer):
            first, kind, text = receive(peer)
            self.assertEqual((2, b'large'), (kind, text))
            peer.sendall(frame(first, 0, 'first chunk') + frame(first, 0, ' stale second chunk'))
            marker = self.marker(peer, first)
            peer.sendall(frame(marker, 0, 'Unknown request 0'))
            second, kind, text = receive(peer)
            self.assertEqual((2, b'list'), (kind, text))
            self.assertNotIn(second, (first, marker))
            peer.sendall(frame(second, 0, 'There are 0 players'))
            peer.sendall(frame(self.marker(peer, second), 0, 'Unknown request 0'))
        server = live.LiveServer()
        server.rcon = self.connect(self.peer(script))
        self.assertEqual('first chunk stale second chunk', server.command('large'))
        self.assertEqual('There are 0 players', server.command('list'))

    def test_marker_is_after_first_packet_and_drains_later_fragmented_utf8(self):
        def script(peer):
            request, _, _ = receive(peer)
            # Minecraft handles one request per read: no pipelined marker here.
            peer.setblocking(False)
            with self.assertRaises(BlockingIOError):
                peer.recv(1)
            peer.settimeout(2)
            packet = frame(request, 0, b'prefix \xf0\x9f')
            for byte in packet:
                peer.sendall(bytes([byte]))
            marker = self.marker(peer, request)
            tail = frame(request, 0, b'\x98\x80 tail') + frame(request, 0, '') + frame(marker, 0, 'marker')
            for byte in tail:
                peer.sendall(bytes([byte]))
        class ByteReads:
            # Force recv fragmentation even if the OS coalesces the peer's writes.
            def __init__(self, connection):
                self.connection = connection

            def __getattr__(self, name):
                return getattr(self.connection, name)

            def recv(self, count):
                return self.connection.recv(min(count, 1))

        rcon = self.connect(ByteReads(self.peer(script)))
        self.assertEqual('prefix 😀 tail', rcon.command('unicode'))
        self.assertEqual(1, rcon.socket.gettimeout())

    def test_valid_empty_and_short_replies(self):
        def script(peer):
            for body in ('', 'ok', 'x' * 4096):
                request, _, _ = receive(peer)
                peer.sendall(frame(request, 0, body))
                peer.sendall(frame(self.marker(peer, request), 0, 'marker'))
        rcon = self.connect(self.peer(script))
        for body in ('', 'ok', 'x' * 4096):
            self.assertEqual(body, rcon.command('command'))

    def test_authentication_refused_or_wrong_identity_or_type(self):
        for reply_id, kind, exception in ((-1, 2, RuntimeError), (999, 2, ConnectionError), (1, 0, ConnectionError)):
            with self.subTest(reply_id=reply_id, kind=kind):
                connection = self.peer(lambda peer: None, auth=lambda peer, request: peer.sendall(frame(reply_id, kind)))
                with self.assertRaises(exception):
                    self.connect(connection)
                self.assertEqual(-1, connection.fileno())

    def assert_broken_command(self, script, exception=ConnectionError, timeout=1):
        rcon = self.connect(self.peer(script, timeout=timeout))
        with self.assertRaises(exception):
            rcon.command('broken')
        self.assertEqual(-1, rcon.socket.fileno())
        with self.assertRaises(OSError):
            rcon.command('must not reuse unknown boundary')

    def test_wrong_command_id_or_type_is_not_returned(self):
        for wrong_id, kind in ((999, 0), (-1, 0), (2, 2)):
            with self.subTest(wrong_id=wrong_id, kind=kind):
                self.assert_broken_command(lambda peer: (receive(peer), peer.sendall(frame(wrong_id, kind, 'wrong'))))

    def test_wrong_marker_id_or_type_is_not_completion(self):
        for wrong_id, kind in ((999, 0), (3, 2)):
            with self.subTest(wrong_id=wrong_id, kind=kind):
                def script(peer):
                    request, _, _ = receive(peer)
                    peer.sendall(frame(request, 0, 'partial'))
                    self.marker(peer, request)
                    peer.sendall(frame(wrong_id, kind, 'not a boundary'))
                self.assert_broken_command(script)

    def test_malformed_frames_close_connection(self):
        for malformed in (struct.pack('<i', -1), struct.pack('<i', 9), struct.pack('<i', 1024 * 1024 + 1), frame(2, 0, 'bad')[:-1] + b'x'):
            with self.subTest(malformed=malformed):
                self.assert_broken_command(lambda peer: (receive(peer), peer.sendall(malformed)))

    def test_eof_during_header_body_and_before_marker(self):
        for partial in (b'\x10\0', frame(2, 0, 'incomplete')[:-3], frame(2, 0, 'complete chunk')):
            with self.subTest(partial=partial):
                def script(peer):
                    receive(peer)
                    peer.sendall(partial)
                    if partial == frame(2, 0, 'complete chunk'):
                        self.marker(peer, 2)
                self.assert_broken_command(script)

    def test_missing_marker_times_out_and_closes_connection(self):
        def script(peer):
            request, _, _ = receive(peer)
            peer.sendall(frame(request, 0, 'partial'))
            self.marker(peer, request)
            self.assertEqual(b'', peer.recv(1))
        self.assert_broken_command(script, TimeoutError, timeout=0.1)

    def test_multipart_progress_does_not_reset_command_deadline(self):
        def script(peer):
            request, _, _ = receive(peer)
            peer.sendall(frame(request, 0, 'first'))
            marker = self.marker(peer, request)
            peer.sendall(b''.join(frame(request, 0, 'more') for _ in range(10)) + frame(marker, 0))
        rcon = self.connect(self.peer(script))
        # Deterministic elapsed time between real socket reads, no sleeps or idle guesses.
        clock = itertools.count(0, 0.1)
        with mock.patch.object(live.time, 'monotonic', side_effect=lambda: next(clock)), \
                self.assertRaises(TimeoutError):
            rcon.command('streaming')
        self.assertEqual(-1, rcon.socket.fileno())

    def test_live_server_stop_tolerates_eof_before_completion_marker(self):
        def script(peer):
            request, kind, text = receive(peer)
            self.assertEqual((2, b'stop'), (kind, text))
            peer.sendall(frame(request, 0, 'Stopping the server'))
            self.marker(peer, request)
            # A server shutting down can close without answering the marker.
        server = live.LiveServer()
        server.rcon = self.connect(self.peer(script))
        connection = server.rcon.socket
        server.process = mock.Mock(returncode=0)
        server.log = mock.Mock()
        self.assertEqual(0, server.stop(timeout=1))
        server.process.wait.assert_called_once_with(1)
        server.log.close.assert_called_once_with()
        self.assertIsNone(server.rcon)
        self.assertEqual(-1, connection.fileno())


if __name__ == '__main__':
    unittest.main()
