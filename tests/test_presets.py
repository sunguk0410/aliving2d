"""v2 expressions and motions name only parameters the models have (a typo would silently do nothing)."""
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'py'))
HAVE = all(importlib.util.find_spec(m) for m in ('numpy', 'scipy', 'PIL'))


@unittest.skipUnless(HAVE, 'needs numpy / scipy / Pillow (the see-through Python has them)')
class PresetTests(unittest.TestCase):
    def ids(self):
        from export_bundle import PARAMS
        from face_expr import EXPR_PARAMS
        from body_rig import BODY_PARAMS
        from arm_rig import ARM_PARAMS
        return {p['id'] for p in PARAMS + EXPR_PARAMS + BODY_PARAMS + ARM_PARAMS}

    def test_expressions_use_known_params(self):
        from face_expr import EXPRESSIONS
        ids = self.ids()
        for name, (label, vals) in EXPRESSIONS.items():
            self.assertTrue(label)
            self.assertEqual(set(vals) - ids, set(), name)

    def test_motions_use_known_params_and_sorted_keys(self):
        from motions import motions
        ids = self.ids()
        for name, (label, group, dur, loop, curves) in motions(True).items():
            self.assertIn(group, ('Idle', 'Tap'))
            self.assertEqual(set(curves) - ids, set(), name)
            for pid, keys in curves.items():
                ts = [t for t, _ in keys]
                self.assertEqual(ts, sorted(ts), f'{name}.{pid}')
                self.assertLessEqual(ts[-1], dur + 1e-6, f'{name}.{pid}')

    def test_live2d_aliases_point_at_params(self):
        import re
        js = (ROOT / 'engine' / 'engine.js').read_text(encoding='utf-8')
        table = js[js.index('const LIVE2D = {'):js.index('};', js.index('const LIVE2D = {'))]
        targets = re.findall(r"Param\w+: \['(\w+)'", table)
        self.assertGreater(len(targets), 10)
        self.assertEqual(set(targets) - self.ids(), set())

    def test_motion3_files(self):
        from motions import write_motions
        with tempfile.TemporaryDirectory() as d:
            listed = write_motions(d, self.ids(), True)
            self.assertTrue(listed)
            m = json.loads((Path(d) / listed[0]['file']).read_text(encoding='utf-8'))
            self.assertEqual(m['Version'], 3)
            seg = m['Curves'][0]['Segments']
            self.assertEqual((len(seg) - 2) % 3, 0)          # t0 v0, then (type, t, v) per linear segment


if __name__ == '__main__':
    unittest.main()
