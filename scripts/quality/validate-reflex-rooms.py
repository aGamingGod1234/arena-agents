#!/usr/bin/env python3
"""Launch an owned provider-free validation server inside slot.sh live.
Usage: slot.sh live python3 scripts/quality/validate-reflex-rooms.py JAR TEMPLATE OUT
OUT must be a fresh directory. Requires Java 25 and installed coordinator dependencies.
"""
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys

if len(sys.argv) != 4 or 'SLOT_PORT_BASE' not in os.environ:
    sys.exit(__doc__)
jar, template, out = (Path(p).resolve() for p in sys.argv[1:])
root = Path(__file__).resolve().parents[2]
out.mkdir(parents=True, exist_ok=False)
server = out / 'server'
shutil.copytree(template, server)
shutil.copy2(jar, server / 'mods' / 'arena-agents.jar')
password = secrets.token_hex(24)
password_file = out / 'rcon-password.txt'
password_file.write_text(password)
password_file.chmod(0o600)
port = int(os.environ['SLOT_PORT_BASE'])
with (server / 'server.properties').open('a') as file:
    file.write(f'\nserver-ip=127.0.0.1\nserver-port={port}\nenable-rcon=true\nrcon.port={port+2}\nrcon.password={password}\nlevel-name=validation-world\nlevel-seed=20261009\n')
java = str(Path(os.environ['JAVA_HOME']) / 'bin/java') if 'JAVA_HOME' in os.environ else 'java'
with (out / 'server.log').open('w') as log:
    process = subprocess.Popen([java, '-Darenaagents.coordinatorAutoStart=false', '-Xms512M', '-Xmx2G', '-jar', 'fabric-server-launch.jar', 'nogui'], cwd=server, stdout=log, stderr=subprocess.STDOUT)
    try:
        result = subprocess.run(['node', str(root / 'scripts/quality/validate-reflex-rooms.mjs'), '--rcon-port', str(port+2), '--password-file', str(password_file), '--out', str(out / 'validation.json')], cwd=root)
    finally:
        process.terminate()
        try:
            process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
sys.exit(result.returncode)
