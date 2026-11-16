"""seethrough/model_edit.py: the AI's actions are kept only where the model has them, scale / undo round-trip."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'seethrough'))
import model_edit  # noqa: E402

MODEL = {'params': [{'id': 'eyeSmile', 'min': 0, 'max': 1}, {'id': 'angleX', 'min': -1, 'max': 1}],
         'parts': [{'name': 'face', 'keys': {'angleX': {'values': [-1, 0, 1], 'disp': [[-2, 4], [0, 0], [2, -4]]}}}],
         'motions': [{'name': 'nod', 'group': 'Tap'}]}


class ModelEditTests(unittest.TestCase):
    def test_clean(self):
        out = model_edit.clean({'reply': 'ok', 'actions': [
            {'type': 'set_params', 'params': {'eyeSmile': 3, 'nope': 1}},
            {'type': 'save_expression', 'name': 'Shy Smile!', 'label': '수줍음', 'params': {'eyeSmile': 0.5, 'angleX': 0.3}},
            {'type': 'play_motion', 'name': 'missing'},
            {'type': 'scale_param', 'param': 'angleX', 'factor': 9},
            {'type': 'scale_param', 'param': 'eyeSmile', 'factor': 1.2},
            {'type': 'set_options', 'extras': ['physics', 'bogus']},
        ]}, MODEL, {'rerig': False})
        self.assertEqual(out['actions'], [
            {'type': 'set_params', 'params': {'eyeSmile': 1.0}},
            {'type': 'save_expression', 'name': 'shy_smile', 'label': '수줍음', 'params': {'eyeSmile': 0.5}},
            {'type': 'scale_param', 'param': 'angleX', 'factor': 1.8},
        ])

    def test_set_options_only_when_the_rig_can_run_again(self):
        out = model_edit.clean({'actions': [{'type': 'set_options', 'extras': ['physics', 'bogus'], 'ears': False}]}, MODEL, {'rerig': True})
        self.assertEqual(out['actions'], [{'type': 'set_options', 'extras': ['physics'], 'ears': False}])

    def test_scale_and_undo(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / 'model.json'
            f.write_text(json.dumps(MODEL), encoding='utf-8')
            self.assertEqual(model_edit.scale(d, 'angleX', 1.5), 1)
            self.assertEqual(json.loads(f.read_text())['parts'][0]['keys']['angleX']['disp'][2], [3.0, -6.0])
            self.assertTrue(model_edit.undo(d))
            self.assertEqual(json.loads(f.read_text())['parts'][0]['keys']['angleX']['disp'][2], [2, -4])
            self.assertFalse(model_edit.undo(d))


if __name__ == '__main__':
    unittest.main()
