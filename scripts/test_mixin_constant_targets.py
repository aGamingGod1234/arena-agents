"""F20 regressions for constant-valued @At targets (stdlib only)."""
import importlib.util
import pathlib
import shutil
import subprocess
import sys
import json
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('mixin_checker', pathlib.Path(__file__).with_name('check-mixin-targets.py'))
checker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checker)


class FixtureJar:
    classes = {'fixture.Renderer'}

    def members(self, owner):
        return {'draw': ['()V'], 'arm': ['()V']}, set()


class ConstantTargetsTest(unittest.TestCase):
    def check_source(self, declarations, expression):
        source = ('@Mixin(targets = "fixture.Renderer") class Hands {\n' + declarations
                  + '\n@Inject(method = "draw", at = @At(value = "INVOKE", target = '
                  + expression + ')) void hook() {}\n}')
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory, 'Hands.java')
            path.write_text(source)
            with patch.object(checker, 'configs', return_value=['Hands']), patch.object(checker, 'source_for', return_value=str(path)):
                return checker.check(FixtureJar(), 'fixture')

    def test_missing_constant_method_is_reported(self):
        checked, problems = self.check_source('static final String ARM = "Lfixture/Renderer;missing()V";', 'ARM')
        self.assertEqual(checked, 3)
        self.assertTrue(any('@At method fixture.Renderer.missing does not exist' in p for p in problems), problems)

    def test_aliases_parentheses_and_concatenation(self):
        checked, problems = self.check_source('''static final String OWNER = "Lfixture/Renderer;";
            static final String ARM = OWNER + ("arm" + "()V");''', '(ARM)')
        self.assertEqual((checked, problems), (3, []))

    def test_literal_prefix_must_not_hide_unsupported_suffix(self):
        _, problems = self.check_source('', '"Lfixture/Renderer;arm()V" + Other.SUFFIX')
        self.assertTrue(any('unsupported @At target expression' in p for p in problems), problems)

    def test_unresolved_and_cyclic_constants_fail_visibly(self):
        for declarations, expression in [('', 'Other.ARM'),
                ('static final String A = B; static final String B = A;', 'A'),
                ('static final String ARM = makeTarget();', 'ARM')]:
            with self.subTest(expression=expression, declarations=declarations):
                _, problems = self.check_source(declarations, expression)
                self.assertTrue(any('unsupported @At target expression' in p for p in problems), problems)

    def test_real_arm_constants_are_resolved(self):
        root = pathlib.Path(SPEC.origin).resolve().parent.parent
        for target, method in [('26.1', 'renderArmWithItem'), ('26.2', 'submitArmWithItem')]:
            with self.subTest(target=target):
                path = root / 'src/compat' / target / 'clientJava/dev/agaminggod/arenaagents/client/compat/mixin/ItemInHandRendererPovMixin.java'
                values = list(checker.at_target_values(path.read_text()))
                self.assertFalse([error for _, error in values if error])
                self.assertTrue(any(value and ';' + method + '(' in value for value, _ in values))

    def test_qualified_annotation_is_checked(self):
        values = list(checker.at_target_values('@org.spongepowered.asm.mixin.injection.At(target = UNKNOWN)'))
        self.assertEqual(len(values), 1)
        self.assertIn('unsupported @At target expression', values[0][1])

    def test_comments_are_ignored(self):
        checked, problems = self.check_source('/* @At(target = UNKNOWN) */ static final String ARM = /* note */ "Lfixture/Renderer;arm()V";', 'ARM // note\n')
        self.assertEqual((checked, problems), (3, []))


class ConstantTargetsCliTest(unittest.TestCase):
    def test_imported_target_cannot_resolve_an_unrelated_local_constant(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source = root / 'Hands.java'
            source.write_text('''package fixture;
import static fixture.External.ARM;
@Mixin(targets = "fixture.Renderer") class Hands {
    @Inject(method = "draw", at = @At(target = ARM)) void hook() {}
    void helper() { final String ARM = "Lfixture/Renderer;arm()V"; }
}
class Renderer { void draw() {} void arm() {} }
@interface Mixin { String targets(); }
@interface Inject { String method(); At at(); }
@interface At { String target(); }
''')
            classes = root / 'classes'
            external = root / 'External.java'
            external.write_text('package fixture; class External { static final String ARM = "Lfixture/Renderer;missing()V"; }')
            subprocess.run(['javac', '-d', str(classes), str(source), str(external)], check=True, capture_output=True)
            compiled = subprocess.run(['javap', '-v', '-p', '-cp', str(classes), 'fixture.Hands'],
                                      check=True, capture_output=True, text=True).stdout
            self.assertIn('target="Lfixture/Renderer;missing()V"', compiled)
            jar = root / 'fixture.jar'
            subprocess.run(['jar', '--create', '--file', str(jar), '-C', str(classes), '.'], check=True, capture_output=True)
            with patch.object(checker, 'configs', return_value=['fixture.Hands']), \
                    patch.object(checker, 'source_for', return_value=str(source)):
                _, problems = checker.check(checker.Jar([str(jar)], 'javap'), 'fixture')
            self.assertTrue(any('unsupported @At target expression' in p for p in problems), problems)

    def test_real_jar_and_cli_exit_status(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'scripts').mkdir()
            script = root / 'scripts/check-mixin-targets.py'
            shutil.copyfile(SPEC.origin, script)
            java = root / 'Renderer.java'
            java.write_text('package fixture; public class Renderer { public void draw() {} public void arm() {} }')
            subprocess.run(['javac', '-d', str(root / 'classes'), str(java)], check=True, capture_output=True)
            jar = root / 'fixture.jar'
            subprocess.run(['jar', '--create', '--file', str(jar), '-C', str(root / 'classes'), '.'], check=True, capture_output=True)
            resources = root / 'src/main/resources'
            resources.mkdir(parents=True)
            (resources / 'arenaagents.mixins.json').write_text(json.dumps({'package': 'fixture', 'mixins': ['Hands']}))
            source = root / 'src/main/java/fixture/Hands.java'
            source.parent.mkdir(parents=True)
            for method, expression, expected, diagnostic in [
                    ('arm', 'ARM', 0, '3 mixin targets checked'),
                    ('missing', 'ARM', 1, '@At method fixture.Renderer.missing does not exist'),
                    ('arm', 'External.ARM', 1, 'unsupported @At target expression')]:
                with self.subTest(expression=expression, method=method):
                    source.write_text('@Mixin(targets = "fixture.Renderer") class Hands { '
                        'static final String ARM = "Lfixture/Renderer;" + "' + method + '()V"; '
                        '@Inject(method = "draw", at = @At(value = "INVOKE", target = ' + expression + ')) void hook() {} }')
                    result = subprocess.run([sys.executable, str(script), 'fixture', str(jar)], text=True, capture_output=True)
                    self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                    self.assertIn(diagnostic, result.stdout)


if __name__ == '__main__':
    unittest.main()
