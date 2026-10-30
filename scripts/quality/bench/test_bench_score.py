import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('bench_score', Path(__file__).with_name('bench-score.py'))
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


class BenchScoreTest(unittest.TestCase):
    def test_completed_pending_failed_and_unknown_telemetry(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run = root / 'tag-claude-R-TOOLBREAK-r1'
            run.mkdir()
            (run / 'results.json').write_text(json.dumps({'runs': [{
                'scenario': 'R-TOOLBREAK', 'profile': {'provider': 'claude'},
                'evaluation': {'status': 'EVALUATED', 'pass': True},
                'measurementStatus': 'MEASURED',
                'metrics': {'playWallTimeMs': 60000, 'deaths': 2,
                            'deathEvents': [{'cause': 'fell'}], 'reflexFirings': 4}}]}))
            (root / 'tag-claude-R-BLAZE-r1.log').touch()
            (root / 'tag-claude-R-GHAST-r1.done').touch()
            (root / 'other-claude-R-FLOOD-r1.log').touch()
            rows = bench.score(root, 'tag')
            self.assertEqual(len(rows), 3)
            by_room = {r[0]: r for r in rows}
            completed = by_room['R-TOOLBREAK']
            self.assertEqual(completed[2:5], ['PASS', 1, 2])
            self.assertEqual(completed[5], 'fell: 1, unknown: 1')
            self.assertEqual(completed[6], 4)
            self.assertEqual(by_room['R-BLAZE'][2], 'PENDING')
            self.assertIsNone(by_room['R-BLAZE'][6])
            self.assertEqual(by_room['R-GHAST'][2], 'UNAVAILABLE')

    def test_failed_evaluator_overrides_agent_claim(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run = root / 'tag-codex-R-VOID-r1'
            run.mkdir()
            (run / 'results.json').write_text(json.dumps({'runs': [{
                'scenario': 'R-VOID', 'goalCompleted': True,
                'evaluation': {'status': 'EVALUATED', 'pass': False},
                'measurementStatus': 'INCOMPLETE', 'metrics': None}]}))
            row = bench.score(root, 'tag')[0]
            self.assertEqual(row[2], 'FAIL/INCOMPLETE')
            self.assertIsNone(row[4])
            self.assertIsNone(row[6])


if __name__ == '__main__':
    unittest.main()
