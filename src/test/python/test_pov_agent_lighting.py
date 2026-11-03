"""F33: execute each port's actual arm handler with distinct operator/agent light.

Optional POV_LIGHT_261_JAR and POV_LIGHT_262_JAR enable upstream bytecode checks.
The Java fixture uses doubles; it does not launch Minecraft or apply mixins.
"""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]


class PovAgentLightingRegression(unittest.TestCase):
    def test_arm_handlers_use_agent_light_at_partial_tick(self):
        for version in ("26.1", "26.2"):
            with self.subTest(version=version):
                source = (ROOT / f"src/compat/{version}/clientJava/dev/agaminggod/"
                          "arenaagents/client/compat/mixin/ItemInHandRendererPovMixin.java").read_text()
                handler = re.search(r'private void arenaagents\$povArm\(.*?\n\t\}', source, re.S)[0]
                fixture = r'''
public class AgentLightingFixture {
    static class AbstractClientPlayer { int light; }
    static class LocalPlayer extends AbstractClientPlayer {}
    static class ItemInHandRenderer {}
    static class InteractionHand {}
    static class ItemStack {}
    static class PoseStack {}
    static class SubmitNodeCollector {}
    interface Operation<T> { T call(Object... args); }
    static class PovClient {
        static boolean active, hidden;
        static AbstractClientPlayer agent;
        static boolean isActive() { return active; }
        static boolean handsHidden() { return hidden; }
        static AbstractClientPlayer agentPlayer() { return agent; }
    }
    static class EntityRenderDispatcher {
        int calls;
        int getPackedLightCoords(AbstractClientPlayer player, float partialTick) {
            if (player != PovClient.agent || partialTick != .375F)
                throw new AssertionError("Lighting must sample the agent at the render partial tick");
            calls++;
            return player.light;
        }
    }
    static class Minecraft {
        static final Minecraft INSTANCE = new Minecraft();
        final EntityRenderDispatcher dispatcher = new EntityRenderDispatcher();
        static Minecraft getInstance() { return INSTANCE; }
        EntityRenderDispatcher getEntityRenderDispatcher() { return dispatcher; }
    }
    HANDLER
    public static void main(String[] args) {
        var fixture = new AgentLightingFixture();
        var operator = new LocalPlayer();
        var agent = new AbstractClientPlayer();
        var renderer = new ItemInHandRenderer();
        var hand = new InteractionHand();
        var stack = new ItemStack();
        var pose = new PoseStack();
        var collector = new SubmitNodeCollector();
        int cases = 0;
        for (boolean active : new boolean[]{false, true})
        for (boolean available : new boolean[]{false, true})
        for (boolean hidden : new boolean[]{false, true})
        for (int operatorLight : new int[]{0, 15728880})
        for (int agentLight : new int[]{15728880, 0}) {
            PovClient.active = active;
            PovClient.hidden = hidden;
            PovClient.agent = available ? agent : null;
            agent.light = agentLight;
            var dispatcher = Minecraft.INSTANCE.dispatcher;
            dispatcher.calls = 0;
            int[] draws = {0};
            boolean useAgent = active && available && !hidden;
            Operation<Void> original = values -> {
                draws[0]++;
                Object[] expected = {renderer, useAgent ? agent : operator, .375F, 13F,
                    hand, .6F, stack, .2F, pose, collector, useAgent ? agentLight : operatorLight};
                if (!java.util.Arrays.equals(expected, values))
                    throw new AssertionError("Wrong arm arguments: expected light=" + expected[10]
                        + ", actual=" + values[10] + ", active=" + active);
                return null;
            };
            fixture.arenaagents$povArm(renderer, operator, .375F, 13F, hand, .6F,
                stack, .2F, pose, collector, operatorLight, original);
            if (draws[0] != (!active || useAgent ? 1 : 0))
                throw new AssertionError("Wrong arm draw count");
            if (dispatcher.calls != (useAgent ? 1 : 0))
                throw new AssertionError("Unexpected light lookup count");
            cases++;
        }
        System.out.println(cases + " arm lighting cases passed");
    }
}
'''.replace('HANDLER', handler)
                with tempfile.TemporaryDirectory(prefix="f33-agent-light-") as temporary:
                    path = Path(temporary) / "AgentLightingFixture.java"
                    path.write_text(fixture)
                    subprocess.run(["javac", str(path)], check=True, capture_output=True, text=True)
                    result = subprocess.run(["java", "-cp", temporary, "AgentLightingFixture"],
                                            capture_output=True, text=True)
                    self.assertEqual(0, result.returncode, result.stderr)
                    self.assertIn("32 arm lighting cases passed", result.stdout)

    def test_available_vanilla_callers_derive_light_from_operator(self):
        checked = 0
        for env, entry in (("POV_LIGHT_261_JAR", "renderHandsWithItems"),
                           ("POV_LIGHT_262_JAR", "submitHandsWithItems")):
            if not os.environ.get(env):
                continue
            with self.subTest(target=env):
                bytecode = subprocess.run([
                    "javap", "-c", "-p", "-classpath", os.environ[env],
                    "net.minecraft.client.renderer.GameRenderer"],
                    check=True, capture_output=True, text=True).stdout
                self.assertRegex(bytecode, r'Minecraft\.player:.*\n\s+\d+: fload_2\n'
                                 r'\s+\d+: invokevirtual .*EntityRenderDispatcher\.getPackedLightCoords:'
                                 r'\(Lnet/minecraft/world/entity/Entity;F\)I\n'
                                 r'\s+\d+: invokevirtual .*ItemInHandRenderer\.' + entry + ':')
                checked += 1
        if not checked:
            self.skipTest("exact-target jars not supplied")


if __name__ == "__main__":
    unittest.main(verbosity=2)
