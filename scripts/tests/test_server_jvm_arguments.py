"""Focused Python -> Gradle/Groovy -> JVM argument transport regression.

Uses Groovy from an existing Gradle wrapper cache; never downloads dependencies
or starts Minecraft. Loom's vmArg/vmArgs sinks are captured by a small fixture.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('live_server', ROOT / 'scripts/live-server.py')
live_server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(live_server)


class ServerJvmArgumentsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.java = shutil.which('java')
        cache = Path(os.environ.get('GRADLE_USER_HOME', Path.home() / '.gradle'))
        jars = sorted(cache.glob('wrapper/dists/**/lib/groovy-[0-9]*.jar'))
        if not cls.java or not jars:
            raise unittest.SkipTest('requires Java and Groovy in an existing Gradle wrapper cache')
        lib = jars[-1].parent
        cls.classpath = os.pathsep.join(str(p) for p in lib.glob('groovy*.jar'))

    def capture_launch(self, root, jvm_args):
        """Exercise start() without preparing mods, spawning Gradle or waiting on RCON."""
        with mock.patch.object(live_server, 'ROOT', str(root)), \
                mock.patch.object(live_server, 'properties', return_value={'mc_compat': '26.3'}):
            server = live_server.LiveServer(jvm_args=jvm_args)
            Path(server.run_dir).mkdir(parents=True)
            with mock.patch.object(server, 'prepare'), \
                    mock.patch.object(server, 'read_log', return_value=' Done (1.0s)! For help'), \
                    mock.patch.object(live_server, 'Rcon'), \
                    mock.patch.object(live_server.subprocess, 'Popen') as popen:
                try:
                    self.assertIs(server.start(), server)
                    return popen.call_args.args[0]
                finally:
                    server.log.close()

    def parse_with_build(self, root, command):
        # Execute the current server configuration, not a duplicate parser in Python.
        build = (ROOT / 'build.gradle').read_text()
        body = build.split('\n\t\tserver {', 1)[1].split('\n\t\t}', 1)[0]
        properties = dict(arg[2:].split('=', 1) for arg in command if arg.startswith('-P'))
        data = root / 'arguments.json'
        data.write_text(json.dumps(properties))
        fixture = root / 'parse.groovy'
        fixture.write_text('''
def properties = new groovy.json.JsonSlurper().parse(new File(args[0]))
def captured = []
def binding = new Binding([
    project: new Expando(findProperty: { name -> properties[name] }),
    developmentBridgeSecret: '/development/bridge-secret.txt',
    vmArg: { arg -> captured.add(arg.toString()) },
    vmArgs: { Object... values -> captured.addAll(values.collect { it.toString() }) }
])
new GroovyShell(binding).evaluate(new File(args[1]))
println groovy.json.JsonOutput.toJson(captured)
''')
        source = root / 'server.groovy'
        source.write_text(body)
        result = subprocess.run([self.java, '-cp', self.classpath, 'groovy.ui.GroovyMain',
                                 str(fixture), str(data), str(source)],
                                capture_output=True, text=True, check=True)
        return json.loads(result.stdout)

    def test_argument_boundaries_through_java(self):
        with tempfile.TemporaryDirectory(prefix='Arena Agents ') as directory:
            root = Path(directory)
            secret = root / 'build/live-server/26.3-bridge-secret.txt'
            expected = ['-Darenaagents.bridgePort=12345',
                        '-Darenaagents.coordinatorAutoStart=false',
                        f'-Darenaagents.bridgeSecretFile={secret}',
                        '-Darenaagents.argumentProbe=C:\\Arena Agents\\"quoted"\\雪\tvalue']
            command = self.capture_launch(root, expected)
            actual = self.parse_with_build(root, command)
            self.assertEqual(expected, actual[1:])
            result = subprocess.run([self.java, *actual, '-XshowSettings:properties', '-version'],
                                    capture_output=True, text=True)
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertIn(f'arenaagents.bridgeSecretFile = {secret}', result.stderr)

    def test_no_extra_arguments(self):
        with tempfile.TemporaryDirectory(prefix='Arena Agents ') as directory:
            root = Path(directory)
            command = self.capture_launch(root, [])
            self.assertFalse(any(arg.startswith('-PserverJvmArgs=') for arg in command))
            self.assertEqual(['-Darenaagents.bridgeSecretFile=/development/bridge-secret.txt'],
                             self.parse_with_build(root, command))


if __name__ == '__main__':
    unittest.main()
