#!/usr/bin/env python3
"""Boot a real Fabric dedicated server with Arena Agents for one Minecraft 26.x target and drive it over RCON.

The server is Loom's development server (./gradlew -Pmc=<target> runServer), so the mod runs from this checkout,
with that target's Fabric API, and with Carpet, Simple Voice Chat and the voice add-on loaded from the run
directory's mods folder, as a player's install would have them. It runs offline, on a flat world, bound to
localhost. Nothing here talks to a model provider.

    python3 scripts/live-server.py [--target 26.2]          # boot, check the mods and commands, stop cleanly

Other scripts import LiveServer to run commands against a live world (see scripts/live-body-benchmark.py).
"""
import argparse
import base64
import json
import os
import re
import secrets
import shutil
import socket
import struct
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def properties(target):
    """gradle.properties overlaid with gradle/mc/<target>.properties, as settings.gradle does."""
    values = {}
    def load(path):
        with open(path, encoding='utf-8') as handle:
            for line in handle:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, value = line.split('=', 1)
                    values[key.strip()] = value.strip()
    load(os.path.join(ROOT, 'gradle.properties'))
    if target and target != values['mc_compat']:
        load(os.path.join(ROOT, 'gradle', 'mc', f'{target}.properties'))
    return values


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


class Rcon:
    """The Source RCON protocol Minecraft speaks: login (type 3), then commands (type 2)."""

    def __init__(self, port, password, timeout=30):
        self.socket = socket.create_connection(('127.0.0.1', port), timeout=timeout)
        self.request = 0
        try:
            if self._send(3, password) == -1:
                raise RuntimeError('RCON login was refused')
        except Exception:
            self.socket.close()
            raise

    def _packet(self, deadline):
        def read(count):
            data = b''
            while len(data) < count:
                if deadline is not None:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError('RCON response timed out')
                    self.socket.settimeout(remaining)
                chunk = self.socket.recv(count - len(data))
                if not chunk:
                    raise ConnectionError('RCON connection closed')
                data += chunk
            return data
        length = struct.unpack('<i', read(4))[0]
        if not 10 <= length <= 1024 * 1024:
            raise ConnectionError('Malformed RCON packet length')
        body = read(length)
        if body[-2:] != b'\x00\x00':
            raise ConnectionError('Malformed RCON string terminators')
        request, kind = struct.unpack('<ii', body[:8])
        return request, kind, body[8:-2]

    def _write(self, kind, text):
        self.request += 1
        payload = struct.pack('<ii', self.request, kind) + text.encode('utf-8') + b'\x00\x00'
        self.socket.sendall(struct.pack('<i', len(payload)) + payload)
        return self.request

    def _send(self, kind, text):
        timeout = self.socket.gettimeout()
        deadline = None if timeout is None else time.monotonic() + timeout
        try:
            expected = self._write(kind, text)
            request, reply_kind, body = self._packet(deadline)
            if kind == 3:
                if reply_kind != 2 or request not in (expected, -1):
                    raise ConnectionError('Unexpected RCON authentication response')
                self.socket.settimeout(timeout)
                return request
            chunks = []
            marker = None
            while True:
                if reply_kind != 0:
                    raise ConnectionError('Unexpected RCON command response type')
                if request == expected:
                    chunks.append(body)
                    if marker is None:
                        # Minecraft processes one request per read. Send only after its first
                        # reply; the unsupported type-0 reply follows every command chunk.
                        marker = self._write(0, '')
                elif marker is not None and request == marker:
                    self.socket.settimeout(timeout)
                    return b''.join(chunks).decode('utf-8', 'replace')
                else:
                    raise ConnectionError('Unexpected RCON response request ID')
                request, reply_kind, body = self._packet(deadline)
        except Exception:
            # A failed read leaves the command boundary unknown; never reuse this stream.
            self.socket.close()
            raise

    def command(self, text):
        return self._send(2, text)

    def close(self):
        self.socket.close()


class LiveServer:
    def __init__(self, target=None, run_dir=None, extra_properties=None, jvm_args=None):
        self.props = properties(target)
        self.target = target or self.props['mc_compat']
        self.run_dir = run_dir or os.path.join(ROOT, 'build', 'live-server', self.target)
        self.extra_properties = extra_properties or {}
        self.jvm_args = jvm_args or []
        self.password = secrets.token_hex(16)
        self.rcon_port = free_port()
        self.process = None
        self.rcon = None
        self.log_path = os.path.join(self.run_dir, 'live-server.log')

    def _gradle(self, *tasks):
        if os.name == 'nt':
            java_home = os.environ.get('JAVA_HOME')
            java = os.path.join(java_home, 'bin', 'java.exe') if java_home else shutil.which('java')
            if not java:
                raise RuntimeError('Java is required to launch the Gradle wrapper')
            args = [java, '-classpath', os.path.join(ROOT, 'gradle', 'wrapper', 'gradle-wrapper.jar'),
                    'org.gradle.wrapper.GradleWrapperMain']
        else:
            args = ['./gradlew']
        if self.target != properties(None)['mc_compat']:
            args.append(f'-Pmc={self.target}')
        return args + list(tasks) + ['--offline', '--no-daemon', '--console=plain']

    def _owned_command(self, command):
        if sys.platform == 'linux' and os.name != 'nt':
            return [sys.executable, os.path.join(os.path.dirname(__file__), 'owned-live-server.py'), *command]
        if os.name != 'nt':
            raise RuntimeError('Live-server process ownership is supported on Linux and Windows')
        # The existing wrapper attaches itself before spawning work and retains its kill-on-close job handle.
        invocation = base64.b64encode(json.dumps({'command': command[0], 'args': command[1:]}).encode()).decode()
        powershell = os.path.join(os.environ.get('SystemRoot', r'C:\Windows'), 'System32',
                                  'WindowsPowerShell', 'v1.0', 'powershell.exe')
        return [powershell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
                os.path.join(ROOT, 'coordinator', 'src', 'owned-windows-job.ps1'), '-CommandJson', invocation]

    def prepare(self):
        """A fresh offline flat world with the target's companion mods, built from this checkout."""
        if os.path.isdir(self.run_dir):
            shutil.rmtree(self.run_dir)
        mods = os.path.join(self.run_dir, 'mods')
        os.makedirs(mods)
        subprocess.run(self._gradle(':voice-addon:jar'), cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
        version = self.props['mod_version'] + ('' if self.target == properties(None)['mc_compat'] else f'+mc{self.target}')
        for jar in [os.path.join(ROOT, 'libs', f"fabric-carpet-{self.props['carpet_version']}.jar"),
                    os.path.join(ROOT, 'libs', f"voicechat-fabric-{self.props['voicechat_version']}.jar"),
                    os.path.join(ROOT, 'voice-addon', 'build', 'libs', f'arena-agents-voice-{version}.jar')]:
            if not os.path.isfile(jar):
                raise FileNotFoundError(f'{jar} (run scripts/fetch-libs.sh {self.target})')
            shutil.copy(jar, mods)
        with open(os.path.join(self.run_dir, 'eula.txt'), 'w') as handle:
            handle.write('eula=true\n')  # accepted for an offline, local verification server
        server = {
            'online-mode': 'false', 'server-ip': '127.0.0.1', 'server-port': str(free_port()),
            'enable-rcon': 'true', 'rcon.port': str(self.rcon_port), 'rcon.password': self.password,
            'level-type': 'minecraft\\:flat', 'generate-structures': 'false', 'spawn-protection': '0',
            # Bedrock, two dirt and grass: the surface is y=-60.
            'generator-settings': json.dumps({'layers': [{'block': 'minecraft:bedrock', 'height': 1}, {'block': 'minecraft:dirt', 'height': 2},
                                                         {'block': 'minecraft:grass_block', 'height': 1}], 'biome': 'minecraft:plains'}),
            'view-distance': '4', 'simulation-distance': '4', 'difficulty': 'normal', 'spawn-monsters': 'false',
            'max-tick-time': '-1', 'pause-when-empty-seconds': '-1', 'enable-query': 'false',
        }
        server.update(self.extra_properties)
        with open(os.path.join(self.run_dir, 'server.properties'), 'w') as handle:
            handle.writelines(f'{key}={value}\n' for key, value in server.items())

    def start(self, timeout=900):
        if os.name != 'nt' and sys.platform != 'linux':
            raise RuntimeError('Live-server process ownership is supported on Linux and Windows')
        self.prepare()
        relative = os.path.relpath(self.run_dir, ROOT)
        self.log = open(self.log_path, 'w', encoding='utf-8')
        extra = [f'-PserverJvmArgs={json.dumps(self.jvm_args)}'] if self.jvm_args else []
        ownership = ({'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == 'nt'
                     else {'start_new_session': True})
        self.process = subprocess.Popen(self._owned_command(self._gradle(':runServer', f'-PserverRunDir={relative}', *extra, '--args=nogui')),
                                        cwd=ROOT, stdout=self.log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                        **ownership)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            text = self.read_log()
            if re.search(r' Done \([0-9.]+s\)! For help', text):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                try:
                    # Minecraft logs Done before starting RCON. Keep polling until login succeeds.
                    self.rcon = Rcon(self.rcon_port, self.password, timeout=min(1, remaining))
                except OSError:
                    pass
                else:
                    self.rcon.socket.settimeout(30)
                    return self
            if self.process.poll() is not None:
                raise RuntimeError(f'server exited with {self.process.returncode} before it was ready; see {self.log_path}')
            time.sleep(min(1, max(0, deadline - time.monotonic())))
        raise TimeoutError(f'server was not ready in {timeout} s; see {self.log_path}')

    def read_log(self):
        with open(self.log_path, encoding='utf-8', errors='replace') as handle:
            return handle.read()

    def command(self, text):
        return self.rcon.command(text)

    def wait_for_player(self, name, timeout=30):
        """Whether the player is in the world within timeout s (Carpet's profile lookup can take seconds online)."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if re.search(rf'\b{re.escape(name)}\b', self.command('list')):
                return True
            time.sleep(0.5)
        return False

    def _kill_process_tree(self):
        if os.name == 'nt':
            # Terminating the wrapper closes the retained job handle, including after the workload launcher exits.
            self.process.kill()
        else:
            # The Linux supervisor must remain alive to adopt and reap detached descendants.
            self.process.terminate()

    def stop(self, timeout=180):
        if self.rcon is not None:
            try:
                self.rcon.command('stop')
            except (OSError, ConnectionError):
                pass
            self.rcon.close()
            self.rcon = None
        if self.process is not None:
            try:
                try:
                    self.process.wait(timeout)
                except subprocess.TimeoutExpired:
                    self._kill_process_tree()
                    self.process.wait()
            finally:
                self.log.close()
        return self.process.returncode if self.process else None


# Log lines that mean a mod, mixin or the server itself failed while the boot "succeeded".
FAILURE_PATTERNS = [r'Mixin apply failed', r'MixinTransformerError', r'InjectionError', r'Critical injection failure',
                    r'Incompatible mods found', r'Exception in server tick loop', r'ClassNotFoundException',
                    r'NoSuchMethodError', r'NoSuchFieldError', r'NoClassDefFoundError', r'/ERROR\]', r'/FATAL\]']


# Mojang's services, which the server and Carpet's profile lookup call: unreachable offline, and rate limited or
# answering with an error page on shared CI runners. Neither says anything about the mod.
OFFLINE_NOISE = [r'Failed to request yggdrasil public key', r'error with a html body connecting to https://api\.mojang\.com/',
                 r'Couldn.t look up profile', r'connecting to https://(api|sessionserver)\.mojang\.com/']


def hold(target):
    """Boot a server whose Arena Agents bridge waits for a coordinator on a local port, print how to reach it as one JSON
    line, and stop the server when stdin closes. The coordinator is not started: the caller connects as it."""
    bridge_port = free_port()
    secret = secrets.token_hex(32)
    server = LiveServer(target)
    secret_file = os.path.join(server.run_dir + '-bridge-secret.txt')
    os.makedirs(os.path.dirname(secret_file), exist_ok=True)
    with open(os.open(secret_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as handle:
        handle.write(secret)
    server.jvm_args = [f'-Darenaagents.bridgePort={bridge_port}', '-Darenaagents.coordinatorAutoStart=false',
                       f'-Darenaagents.bridgeSecretFile={secret_file}']
    try:
        server.start()
        print(json.dumps({'target': server.target, 'minecraftVersion': server.props['minecraft_version'], 'rconPort': server.rcon_port,
                          'rconPassword': server.password, 'bridgePort': bridge_port, 'bridgeSecret': secret, 'log': server.log_path}), flush=True)
        sys.stdin.read()
    finally:
        server.stop()


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--target', help='26.1, 26.2 or 26.3 (default: gradle.properties)')
    parser.add_argument('--hold', action='store_true', help='keep the server up for a coordinator-side client until stdin closes')
    args = parser.parse_args()
    if args.hold:
        hold(args.target)
        return
    server = LiveServer(args.target)
    started = time.time()
    checks = []
    try:
        server.start()
        boot = time.time() - started
        text = server.read_log()
        loaded = re.search(r'Loading (\d+) mods:', text)
        for mod in ['arenaagents', 'carpet', 'voicechat', 'fabric-api', 'minecraft']:
            checks.append((f'mod {mod} loaded', re.search(rf'^\s*- {re.escape(mod)} ', text, re.M) is not None))
        game = re.search(r'^\s*- minecraft (\S+)', text, re.M)
        checks.append((f"runs Minecraft {server.props['minecraft_version']}", bool(game) and game.group(1) == server.props['minecraft_version']))
        status = server.command('codex status')
        # prepare() creates a fresh world; statusAll must report its empty agent registry.
        checks.append(('/codex status answers', status.strip() == 'You have not created any agents yet.'))
        server.command('player LiveCheck spawn at 0 -60 0')
        checks.append(('Carpet fake player joins', server.wait_for_player('LiveCheck')))
        # A 10-block drop: the body must land alive and hurt (vanilla takes 7 of 20), the server must not crash.
        # Spawned players are invulnerable for their first 60 ticks, so wait that out on the ground, then drop.
        # Carpet spawns console-summoned bodies in creative, so switch to survival like an agent body.
        server.command('player LiveFall spawn at 3 -60 3')
        server.wait_for_player('LiveFall')  # Carpet adds the body a moment (online: seconds) after the command returns
        server.command('gamemode survival LiveFall')
        time.sleep(3)
        server.command('tp LiveFall 3 -50 3')
        time.sleep(4)
        health = re.search(r'(-?[0-9.]+)f', server.command('data get entity LiveFall Health') or '')
        checks.append((f"fall damage applies to a fake player (health {health.group(1) if health else '?'} of 20)",
                       bool(health) and 0 < float(health.group(1)) < 20))
        checks.append(('server survives fake-player ticks', server.process.poll() is None and 'LiveFall' in server.command('list')))
        server.command('player LiveCheck kill')
        server.command('player LiveFall kill')
    finally:
        code = server.stop()
    text = server.read_log()
    failures = [line for line in text.splitlines() if any(re.search(pattern, line) for pattern in FAILURE_PATTERNS)
                and not any(re.search(pattern, line) for pattern in OFFLINE_NOISE)]
    checks.append(('server stopped cleanly', code == 0 and 'Stopping server' in text))
    checks.append(('no mixin, linkage or tick-loop errors in the log', not failures))
    print(f"Minecraft {server.props['minecraft_version']} (target {server.target}): ready in {boot:.1f} s, {loaded.group(1) if loaded else '?'} mods")
    for name, ok in checks:
        print(f"  {'PASS' if ok else 'FAIL'}: {name}")
    for line in failures[:20]:
        print(f'    {line}')
    sys.exit(0 if all(ok for _, ok in checks) else 1)


if __name__ == '__main__':
    main()
