"""Exercise the smoke CLI without launching Gradle or a Minecraft server."""
import contextlib
import importlib.util
import io
from pathlib import Path
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('live_smoke_status', ROOT / 'scripts/live-server.py')
live_server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(live_server)


class LiveSmokeStatusCommandTest(unittest.TestCase):
    def run_smoke(self, status):
        server = mock.Mock()
        server.props = {'minecraft_version': '26.3'}
        server.target = '26.3'
        server.read_log.return_value = (
            'Loading 5 mods:\n - arenaagents 1\n - carpet 1\n - voicechat 1\n'
            ' - fabric-api 1\n - minecraft 26.3\nStopping server\n'
        )
        server.process.poll.return_value = None
        server.stop.return_value = 0
        server.wait_for_player.return_value = True

        def command(text):
            if text in ('agent status', 'codex status'):
                return status
            if text == 'data get entity LiveFall Health':
                return 'LiveFall has the following entity data: 13.0f'
            if text == 'list':
                return 'LiveCheck, LiveFall'
            return ''

        server.command.side_effect = command
        output = io.StringIO()
        with mock.patch.object(live_server, 'LiveServer', return_value=server), \
                mock.patch.object(live_server.sys, 'argv', ['live-server.py']), \
                mock.patch.object(live_server.time, 'sleep'), \
                contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as exited:
            live_server.main()
        server.stop.assert_called_once_with()
        return exited.exception.code, output.getvalue(), server

    def test_fresh_server_status_passes_and_uses_registered_command(self):
        code, output, server = self.run_smoke('You have not created any agents yet.')
        self.assertEqual(0, code, output)
        server.command.assert_any_call('codex status')
        self.assertNotIn(mock.call('agent status'), server.command.call_args_list)
        self.assertIn('PASS: /codex status answers', output)

    def test_errors_and_unexpected_responses_fail_smoke(self):
        for status in (
            'Incorrect argument for command at position 6: agent <--[HERE]',
            'Unknown or incomplete command, see below for error',
            'An unexpected error occurred trying to execute that command',
            'Command accepted',
            '',
            '   ',
        ):
            with self.subTest(status=status):
                code, output, _ = self.run_smoke(status)
                self.assertEqual(1, code, output)
                self.assertIn('FAIL: /codex status answers', output)

    def test_rcon_surrounding_whitespace_is_accepted(self):
        code, output, _ = self.run_smoke('  You have not created any agents yet.\n')
        self.assertEqual(0, code, output)


if __name__ == '__main__':
    unittest.main()
