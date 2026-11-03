"""F22: run the actual map visibility handlers with small player/POV doubles.

Run from any directory with python3 <this file>. Set POV_MAP_MINECRAFT_JAR
for an additional javap check against a cached exact-target client jar.
This does not boot Minecraft or prove transformed-mixin application.
"""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
MAP_METHODS = {"renderOneHandedMap", "renderTwoHandedMap"}
TARGET = "Lnet/minecraft/client/player/LocalPlayer;isInvisible()Z"


class PovMapVisibilityRegression(unittest.TestCase):
    def test_both_ports_use_agent_visibility_and_preserve_vanilla_fallback(self):
        for version in ("26.1", "26.2"):
            with self.subTest(version=version):
                source = (ROOT / f"src/compat/{version}/clientJava/dev/agaminggod/"
                          "arenaagents/client/compat/mixin/ItemInHandRendererPovMixin.java").read_text()
                match = re.search(
                    r'@WrapOperation\(method\s*=\s*\{([^}]+)\},\s*at\s*=\s*'
                    r'@At\(value\s*=\s*"INVOKE",\s*target\s*=\s*"' + re.escape(TARGET)
                    + r'"\)\)\s*(private boolean [\w$]+\(LocalPlayer player, '
                    r'Operation<Boolean> original\)\s*\{.*?\n\t\})', source, re.S)
                self.assertIsNotNone(match, f"{version}: both map visibility reads need a POV hook")
                self.assertEqual(MAP_METHODS, set(re.findall(r'"([^"]+)"', match[1])))
                handler = match[2]
                name = re.search(r'boolean ([\w$]+)\(', handler)[1]
                fixture = r'''
public class MapVisibilityFixture {
    static class AbstractClientPlayer {
        boolean invisible;
        boolean isInvisible() { return invisible; }
    }
    static class LocalPlayer extends AbstractClientPlayer {}
    interface Operation<T> { T call(Object... args); }
    static class PovClient {
        static boolean active;
        static AbstractClientPlayer agent;
        static boolean isActive() { return active; }
        static AbstractClientPlayer agentPlayer() { return agent; }
    }
    HANDLER
    public static void main(String[] args) {
        var fixture = new MapVisibilityFixture();
        var operator = new LocalPlayer();
        var agent = new AbstractClientPlayer();
        int cases = 0;
        for (boolean active : new boolean[]{false, true})
        for (boolean available : new boolean[]{false, true})
        for (boolean operatorInvisible : new boolean[]{false, true})
        for (boolean agentInvisible : new boolean[]{false, true}) {
            PovClient.active = active;
            PovClient.agent = available ? agent : null;
            operator.invisible = operatorInvisible;
            agent.invisible = agentInvisible;
            int[] calls = {0};
            Operation<Boolean> original = values -> {
                if (values.length != 1 || values[0] != operator)
                    throw new AssertionError("Vanilla receiver changed");
                calls[0]++;
                return operator.isInvisible();
            };
            boolean result = fixture.NAME(operator, original);
            boolean useAgent = active && available;
            if (result != (useAgent ? agentInvisible : operatorInvisible))
                throw new AssertionError("Wrong map arm visibility");
            if (calls[0] != (useAgent ? 0 : 1))
                throw new AssertionError("Wrong vanilla fallback calls");
            cases++;
        }
        System.out.println(cases + " map visibility cases passed");
    }
}
'''.replace('HANDLER', handler).replace('NAME', name)
                with tempfile.TemporaryDirectory(prefix="f22-map-visibility-") as temporary:
                    path = Path(temporary) / "MapVisibilityFixture.java"
                    path.write_text(fixture)
                    subprocess.run(["javac", str(path)], check=True, capture_output=True, text=True)
                    result = subprocess.run(["java", "-cp", temporary, "MapVisibilityFixture"],
                                            check=True, capture_output=True, text=True)
                    self.assertIn("16 map visibility cases passed", result.stdout)

    @unittest.skipUnless(os.environ.get("POV_MAP_MINECRAFT_JAR"), "exact-target jar not supplied")
    def test_exact_target_map_visibility_invocations(self):
        bytecode = subprocess.run([
            "javap", "-c", "-p", "-classpath", os.environ["POV_MAP_MINECRAFT_JAR"],
            "net.minecraft.client.renderer.ItemInHandRenderer"],
            check=True, capture_output=True, text=True).stdout
        for name in MAP_METHODS:
            with self.subTest(method=name):
                body = re.search(r'^  private void ' + name
                                 + r'\(.*?(?=^  (?:private|public|protected)|\Z)', bytecode, re.M | re.S)
                self.assertIsNotNone(body, f"Missing exact-target method {name}")
                self.assertEqual(1, body[0].count("LocalPlayer.isInvisible:()Z"))
                self.assertRegex(body[0], r'LocalPlayer\.isInvisible:\(\)Z\s+\d+: ifne')


if __name__ == "__main__":
    unittest.main(verbosity=2)
