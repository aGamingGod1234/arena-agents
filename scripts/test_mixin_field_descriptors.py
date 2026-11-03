"""F21 regressions against compiled fields and the real checker CLI (stdlib only)."""
import importlib.util
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location(
    'field_mixin_checker', pathlib.Path(__file__).with_name('check-mixin-targets.py'))
checker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checker)


class FieldDescriptorsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.root = pathlib.Path(cls.temporary.name)
        java = cls.root / 'Target.java'
        java.write_text('''package fixture;
interface Fields { String LABEL = "label"; }
class Parent implements Fields { public float inherited; public float hidden; }
public class Target extends Parent {
    public float xBobO;
    public int hidden;
    public String[] names;
    public void draw() {}
}
''')
        classes = cls.root / 'classes'
        subprocess.run(['javac', '-d', str(classes), str(java)], check=True, capture_output=True)
        cls.jar = cls.root / 'fixture.jar'
        subprocess.run(['jar', '--create', '--file', str(cls.jar), '-C', str(classes), '.'],
                       check=True, capture_output=True)
        (cls.root / 'scripts').mkdir()
        cls.script = cls.root / 'scripts/check-mixin-targets.py'
        shutil.copyfile(SPEC.origin, cls.script)
        resources = cls.root / 'src/main/resources'
        resources.mkdir(parents=True)
        (resources / 'arenaagents.mixins.json').write_text(
            json.dumps({'package': 'fixture', 'mixins': ['Hands']}))
        cls.source = cls.root / 'src/main/java/fixture/Hands.java'
        cls.source.parent.mkdir(parents=True)

    def run_cli(self, field, descriptor):
        self.source.write_text('@Mixin(targets = "fixture.Target") class Hands { '
            '@Inject(method = "draw", at = @At(value = "FIELD", target = '
            '"Lfixture/Target;' + field + ':' + descriptor + '")) void hook() {} '
            '@Accessor("xBobO") abstract float bob(); }')
        return subprocess.run([sys.executable, str(self.script), 'fixture', str(self.jar)],
                              text=True, capture_output=True)

    def test_same_name_wrong_primitive_descriptor_fails_cli(self):
        valid = self.run_cli('xBobO', 'F')
        self.assertEqual(valid.returncode, 0, valid.stdout + valid.stderr)
        invalid = self.run_cli('xBobO', 'I')
        self.assertEqual(invalid.returncode, 1, invalid.stdout + invalid.stderr)
        self.assertIn('@At field fixture.Target.xBobO:I has no matching descriptor', invalid.stdout)

    def test_inherited_field_descriptors_are_checked(self):
        for name, descriptor in [('inherited', 'F'), ('LABEL', 'Ljava/lang/String;'),
                                 ('hidden', 'F'), ('hidden', 'I'), ('names', '[Ljava/lang/String;')]:
            with self.subTest(name=name, descriptor=descriptor):
                result = self.run_cli(name, descriptor)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for name, descriptor in [('inherited', 'I'), ('LABEL', 'I'),
                                 ('hidden', 'J'), ('names', 'Ljava/lang/String;')]:
            with self.subTest(name=name, descriptor=descriptor):
                result = self.run_cli(name, descriptor)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn('has no matching descriptor', result.stdout)

    def test_members_preserve_descriptors_through_inheritance(self):
        jar = checker.Jar([str(self.jar)], 'javap')
        _, fields = jar.members('fixture.Target')
        self.assertEqual(set(fields['hidden']), {'I', 'F'})
        self.assertEqual(fields['inherited'], ['F'])
        self.assertEqual(fields['LABEL'], ['Ljava/lang/String;'])
        self.assertEqual(fields['names'], ['[Ljava/lang/String;'])
        _, parent_fields = jar.members('fixture.Parent')
        self.assertEqual(parent_fields['hidden'], ['F'])

    def test_missing_field_keeps_existing_diagnostic(self):
        result = self.run_cli('missing', 'F')
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn('@At field fixture.Target.missing does not exist', result.stdout)


if __name__ == '__main__':
    unittest.main()
