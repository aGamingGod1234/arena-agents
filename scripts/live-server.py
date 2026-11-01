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
        if self._send(3, password) == -1:
            raise RuntimeError('RCON login was refused')

    def _packet(self):
        def read(count):
            data = b''
            while len(data) < count:
                chunk = self.socket.recv(count - len(data))
                if not chunk:
                    raise ConnectionError('RCON connection closed')
                data += chunk
            return data
        length = struct.unpack('<i', read(4))[0]
        body = read(length)
        request, _ = struct.unpack('<ii', body[:8])
        return request, body[8:-2].decode('utf-8', 'replace')

    def _send(self, kind, text):
        self.request += 1
        payload = struct.pack('<ii', self.request, kind) + text.encode('utf-8') + b'\x00\x00'
        self.socket.sendall(struct.pack('<i', len(payload)) + payload)
        request, body = self._packet()
        return request if kind == 3 else body

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
        args = ['./gradlew']
        if self.target != properties(None)['mc_compat']:
            args.append(f'-Pmc={self.target}')
        return args + list(tasks) + ['--offline', '--no-daemon', '--console=plain']

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
        self.prepare()
        relative = os.path.relpath(self.run_dir, ROOT)
        self.log = open(self.log_path, 'w', encoding='utf-8')
        extra = [f"-PserverJvmArgs={' '.join(self.jvm_args)}"] if self.jvm_args else []
        self.process = subprocess.Popen(self._gradle(':runServer', f'-PserverRunDir={relative}', *extra, '--args=nogui'),
                                        cwd=ROOT, stdout=self.log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        deadline = time.time() + timeout
        while time.time() < deadline:
            text = self.read_log()
            if re.search(r' Done \([0-9.]+s\)! For help', text):
                self.rcon = Rcon(self.rcon_port, self.password)
                return self
            if self.process.poll() is not None:
                raise RuntimeError(f'server exited with {self.process.returncode} before it was ready; see {self.log_path}')
            time.sleep(1)
        raise TimeoutError(f'server was not ready in {timeout} s; see {self.log_path}')

    def read_log(self):
        with open(self.log_path, encoding='utf-8', errors='replace') as handle:
            return handle.read()

    def command(self, text):
        return self.rcon.command(text)

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
                self.process.wait(timeout)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
            self.log.close()
        return self.process.returncode if self.process else None


# Log lines that mean a mod, mixin or the server itself failed while the boot "succeeded".
FAILURE_PATTERNS = [r'Mixin apply failed', r'MixinTransformerError', r'InjectionError', r'Critical injection failure',
                    r'Incompatible mods found', r'Exception in server tick loop', r'ClassNotFoundException',
                    r'NoSuchMethodError', r'NoSuchFieldError', r'NoClassDefFoundError', r'/ERROR\]', r'/FATAL\]']


# Expected on an offline machine: Mojang's auth services cannot be reached.
OFFLINE_NOISE = [r'Failed to request yggdrasil public key']


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
        status = server.command('agent status')
        checks.append(('/agent command answers', bool(status.strip()) and 'Unknown or incomplete command' not in status))
        server.command('player LiveCheck spawn at 0 -60 0')
        time.sleep(3)
        listed = server.command('list')
        checks.append(('Carpet fake player joins', 'LiveCheck' in listed))
        # A 10-block drop: the body must land alive and hurt (vanilla takes 7 of 20), the server must not crash.
        # Spawned players are invulnerable for their first 60 ticks, so wait that out on the ground, then drop.
        # Carpet spawns console-summoned bodies in creative, so switch to survival like an agent body.
        server.command('player LiveFall spawn at 3 -60 3')
        time.sleep(2)  # Carpet adds the body to the world a moment after the command returns
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
