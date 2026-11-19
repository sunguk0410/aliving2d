"""engine/player.js: the reaction table picks by intensity, and every name it uses exists in the presets."""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which('node')

SCRIPT = r"""
global.window = global; global.requestAnimationFrame = () => 0; global.cancelAnimationFrame = () => {};
require(process.argv[1]);
const P = CapsuleV2Player, t = require(process.argv[2]);
const out = {
  gaze2: P.pickReaction(t, 'GAZE_AWAY', 2, () => 0).motion,
  greet: P.pickReaction(t, 'GREETING', 3, () => 0).motion,
  none: P.pickReaction(t, 'NOPE', 1),
  curve: P.curveAt([[0, 0], [1, 2]], 0.25),
};
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, 'needs node')
class PlayerTests(unittest.TestCase):
    def test_pick_reaction(self):
        r = subprocess.run([NODE, '-e', SCRIPT, str(ROOT / 'engine/player.js'), str(ROOT / 'engine/reactions.default.json')],
                           capture_output=True, text=True, check=True)
        out = json.loads(r.stdout)
        self.assertEqual(out['gaze2'], 'tiltTalk')
        self.assertEqual(out['greet'], 'wave')          # no intensity 3 row: the rows without an intensity
        self.assertIsNone(out['none'])
        self.assertAlmostEqual(out['curve'], 0.5)

    def test_reaction_names_exist(self):
        try:
            import sys
            sys.path.insert(0, str(ROOT / 'py'))
            from face_expr import EXPRESSIONS
            from motions import motions
        except ImportError:
            self.skipTest('needs numpy / scipy')
        t = json.loads((ROOT / 'engine/reactions.default.json').read_text(encoding='utf-8'))
        mos = set(motions(True))
        for trig, rows in t['reactions'].items():
            for c in rows:
                if 'motion' in c:
                    self.assertIn(c['motion'], mos, trig)
                for k in ('expression', 'then'):
                    if k in c:
                        self.assertIn(c[k], EXPRESSIONS, trig)


if __name__ == '__main__':
    unittest.main()
