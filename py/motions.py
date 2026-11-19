"""
Motions (the artisan's last step: short animations made from the model's parameters, Live2D .motion3.json).

Each motion is a set of parameter curves, key times in seconds; the exported file is Live2D motion3 with linear
segments (segment type 0), so the CAPSULE contract ({group, file}) can name it. Parameters a motion does not
name keep what the face / tracking / expression gives them. Arms use the wrist offsets (arm<s>X / arm<s>Y, arm
lengths) and hand<s>; the engine's IK does the joints.

Group: 'Idle' (loops) or 'Tap' (reactions), like Live2D sample models.
Raising an arm overhead goes out to the side first (an arc, like a person): a wrist moving straight up would
pass the shoulder and fold the arm.
"""
import json
import os

import numpy as np


def wave_keys(t0, t1, freq, amp, base=0.0, step=None):
    """Keys of a sine between t0 and t1 (sampled, linear segments)."""
    step = step or 1.0 / (freq * 8)
    ts = np.arange(t0, t1 + 1e-6, step)
    return [(float(t), float(base + amp * np.sin(2 * np.pi * freq * (t - t0)))) for t in ts]


def arc(t0, t1, th0, th1, n=6, r=0.96):
    """Wrist keys for a straight arm swinging about the shoulder from th0 to th1 degrees (0 = hanging, 90 = out to
    the side, 180 = straight up), as offsets from the hanging wrist in arm lengths: (x keys, y keys)."""
    ts = np.linspace(t0, t1, n + 1)
    th = np.radians(np.linspace(th0, th1, n + 1))
    xs = r * np.sin(th)
    ys = r * (1 - np.cos(th))
    return ([(float(t), float(x)) for t, x in zip(ts, xs)], [(float(t), float(y)) for t, y in zip(ts, ys)])


def ease(keys_in):
    return [(float(t), float(v)) for t, v in keys_in]


def motions(has_arms=True):
    M = {}
    M['idle'] = ('대기', 'Idle', 6.0, True, {
        'angleX': ease([(0, 0), (1.5, 0.12), (3, 0), (4.5, -0.1), (6, 0)]),
        'angleY': ease([(0, 0), (2, 0.06), (4, -0.04), (6, 0)]),
        'bodyZ': ease([(0, 0), (1.5, -0.08), (3, 0), (4.5, 0.08), (6, 0)]),
        'bodyX': ease([(0, 0), (3, 0.06), (6, 0)]),
        'angleZ': ease([(0, 0), (1.6, 0.12), (3.2, 0), (4.8, -0.1), (6, 0)]),
        'eyeX': ease([(0, 0), (2.4, 0), (2.6, 0.35), (3.8, 0.35), (4, 0), (6, 0)]),
    })
    if has_arms:                                      # the arms hang and lag a little behind the body's sway
        M['idle'][4].update({
            'armLX': ease([(0, 0), (1.8, 0.03), (3.3, 0), (4.8, -0.025), (6, 0)]),
            'armRX': ease([(0, 0), (1.8, -0.025), (3.3, 0), (4.8, 0.03), (6, 0)]),
            'handL': ease([(0, 0), (2.0, 0.08), (5.0, -0.06), (6, 0)]),
            'handR': ease([(0, 0), (2.0, -0.06), (5.0, 0.08), (6, 0)]),
        })
    M['nod'] = ('끄덕', 'Tap', 1.4, False, {
        'angleY': ease([(0, 0), (0.25, -0.7), (0.5, 0.05), (0.75, -0.55), (1.0, 0), (1.4, 0)]),
        'bodyY': ease([(0, 0), (0.25, -0.2), (0.5, 0), (0.75, -0.15), (1.0, 0)]),
    })
    M['shake'] = ('도리도리', 'Tap', 1.6, False, {
        'angleX': ease([(0, 0), (0.25, -0.75), (0.55, 0.75), (0.85, -0.6), (1.15, 0.45), (1.4, 0), (1.6, 0)]),
        'bodyX': ease([(0, 0), (0.3, -0.15), (0.6, 0.15), (0.9, -0.1), (1.2, 0.08), (1.6, 0)]),
    })
    M['bow'] = ('인사', 'Tap', 2.4, False, {
        'angleY': ease([(0, 0), (0.6, -1.0), (1.4, -1.0), (2.0, 0.05), (2.4, 0)]),
        'bodyY': ease([(0, 0), (0.6, -1.0), (1.4, -1.0), (2.0, 0.1), (2.4, 0)]),
        'eyeOpenL': ease([(0, 1), (0.6, 0.35), (1.4, 0.35), (2.0, 1)]),
        'eyeOpenR': ease([(0, 1), (0.6, 0.35), (1.4, 0.35), (2.0, 1)]),
    })
    chatter = [(0.0, 0.0)]
    for i, (a, b) in enumerate(((0.15, 0.55), (0.3, 0.2), (0.45, 0.7), (0.62, 0.1), (0.78, 0.5), (0.95, 0.25),
                                (1.1, 0.65), (1.28, 0.15), (1.45, 0.45), (1.6, 0.0))):
        chatter.append((a, b))
    M['talk'] = ('말하기', 'Tap', 1.8, False, {
        'mouthOpen': chatter + [(1.8, 0.0)],
        'mouthWide': ease([(0, 0), (0.15, 0.1), (0.3, 0.7), (0.45, -0.1), (0.62, -0.7), (0.78, 0.4), (0.95, 0.6),
                           (1.1, -0.5), (1.28, 0.5), (1.45, 0), (1.8, 0)]),
        'angleY': ease([(0, 0), (0.4, 0.12), (0.9, -0.05), (1.4, 0.1), (1.8, 0)]),
        'angleX': ease([(0, 0), (0.6, 0.08), (1.2, -0.06), (1.8, 0)]),
    })
    M['doubleNod'] = ('두 번 끄덕', 'Tap', 1.2, False, {
        'angleY': ease([(0, 0), (0.18, -0.6), (0.36, 0.05), (0.54, -0.5), (0.75, 0), (1.2, 0)]),
        'bodyY': ease([(0, 0), (0.18, -0.15), (0.36, 0), (0.54, -0.12), (0.75, 0)]),
        'eyeSmile': ease([(0, 0), (0.2, 0.4), (0.9, 0.4), (1.2, 0)]),
    })
    M['glance'] = ('힐끔', 'Tap', 2.2, False, {
        'eyeX': ease([(0, 0.6), (0.3, 0.6), (0.45, 0), (1.4, 0), (1.6, 0.6), (2.2, 0)]),
        'angleX': ease([(0, 0.35), (0.5, 0.15), (1.4, 0.15), (1.7, 0.35), (2.2, 0)]),
        'eyeOpenL': ease([(0, 0.8), (0.45, 0.65), (1.4, 0.65), (2.2, 1)]),
        'eyeOpenR': ease([(0, 0.8), (0.45, 0.65), (1.4, 0.65), (2.2, 1)]),
    })
    M['tiltTalk'] = ('갸웃하며 말하기', 'Tap', 2.2, False, {
        'angleZ': ease([(0, 0), (0.35, 0.55), (1.8, 0.55), (2.2, 0)]),
        'angleX': ease([(0, 0), (0.35, 0.2), (1.8, 0.2), (2.2, 0)]),
        'mouthOpen': [(0.0, 0.0), (0.3, 0.0)] + [(t + 0.3, v) for t, v in chatter[1:]] + [(2.2, 0.0)],
        'bodyZ': ease([(0, 0), (0.4, 0.15), (1.8, 0.15), (2.2, 0)]),
    })
    M['lookAround'] = ('두리번', 'Tap', 3.2, False, {
        'angleX': ease([(0, 0), (0.5, -0.7), (1.1, -0.7), (1.7, 0.7), (2.4, 0.7), (3.2, 0)]),
        'eyeX': ease([(0, 0), (0.4, -0.8), (1.1, -0.8), (1.6, 0.8), (2.4, 0.8), (3.2, 0)]),
        'angleY': ease([(0, 0), (0.5, 0.15), (1.7, 0.1), (2.4, 0.15), (3.2, 0)]),
        'bodyX': ease([(0, 0), (0.6, -0.2), (1.8, 0.2), (2.5, 0.2), (3.2, 0)]),
    })
    M['perkUp'] = ('반짝 깨기', 'Tap', 1.5, False, {
        'bodyY': ease([(0, 0), (0.15, 0.9), (0.6, 0.4), (1.5, 0)]),
        'angleY': ease([(0, 0), (0.15, 0.45), (0.7, 0.2), (1.5, 0)]),
        'eyeBall': ease([(0, 0), (0.12, 0.6), (1.0, 0.3), (1.5, 0)]),
        'browLY': ease([(0, 0), (0.15, 0.7), (1.0, 0.3), (1.5, 0)]),
        'browRY': ease([(0, 0), (0.15, 0.7), (1.0, 0.3), (1.5, 0)]),
    })
    M['turnAway'] = ('고개 돌리기', 'Tap', 2.6, False, {
        'angleX': ease([(0, 0), (0.35, -1.0), (2.0, -1.0), (2.6, 0)]),
        'angleY': ease([(0, 0), (0.35, 0.25), (2.0, 0.25), (2.6, 0)]),
        'bodyX': ease([(0, 0), (0.5, -0.6), (2.0, -0.6), (2.6, 0)]),
        'eyeX': ease([(0, 0), (0.3, -0.8), (1.2, -0.8), (1.4, 0.3), (1.7, -0.8), (2.0, -0.8), (2.6, 0)]),
        'eyeOpenL': ease([(0, 1), (0.35, 0.6), (2.0, 0.6), (2.6, 1)]),
        'eyeOpenR': ease([(0, 1), (0.35, 0.6), (2.0, 0.6), (2.6, 1)]),
    })
    M['sad'] = ('시무룩', 'Tap', 3.0, False, {
        'angleY': ease([(0, 0), (0.8, -0.6), (2.4, -0.6), (3.0, 0)]),
        'bodyY': ease([(0, 0), (0.8, -0.8), (2.4, -0.8), (3.0, 0)]),
        'angleX': ease([(0, 0), (0.8, 0.2), (2.4, 0.2), (3.0, 0)]),
    })
    M['surprise'] = ('깜짝', 'Tap', 1.4, False, {
        'bodyY': ease([(0, 0), (0.12, 1.0), (0.5, 0.6), (1.4, 0)]),
        'angleY': ease([(0, 0), (0.12, 0.5), (0.6, 0.3), (1.4, 0)]),
        'eyeBall': ease([(0, 0), (0.1, -1), (1.0, -0.6), (1.4, 0)]),
    })
    if has_arms:
        M['wave'] = ('손 흔들기', 'Tap', 3.2, False, {
            'armRX': ease([(0, 0), (0.45, 0.15), (2.7, 0.15), (3.2, 0)]),
            'armRY': ease([(0, 0), (0.45, 1.05), (2.7, 1.05), (3.2, 0)]),
            'handR': [(0.0, 0.0)] + wave_keys(0.45, 2.7, 1.6, 0.55) + [(3.2, 0.0)],
            'bodyZ': ease([(0, 0), (0.45, -0.18), (2.7, -0.18), (3.2, 0)]),
            'angleX': ease([(0, 0), (0.5, 0.2), (2.7, 0.2), (3.2, 0)]),
            'eyeSmile': ease([(0, 0), (0.5, 0.6), (2.6, 0.6), (3.2, 0)]),
            'mouthForm': ease([(0, 0), (0.5, 1), (2.7, 1), (3.2, 0)]),
        })
        M['cheer'] = ('만세', 'Tap', 2.4, False, {
            'armLX': arc(0, 0.35, 0, 160, 5)[0] + [(1.1, 0.4), (1.4, 0.33)] + arc(1.9, 2.4, 160, 0, 5)[0],
            'armLY': arc(0, 0.35, 0, 160, 5)[1] + [(1.1, 1.7), (1.4, 1.86)] + arc(1.9, 2.4, 160, 0, 5)[1],
            'armRX': arc(0, 0.35, 0, 160, 5)[0] + [(1.1, 0.4), (1.4, 0.33)] + arc(1.9, 2.4, 160, 0, 5)[0],
            'armRY': arc(0, 0.35, 0, 160, 5)[1] + [(1.1, 1.7), (1.4, 1.86)] + arc(1.9, 2.4, 160, 0, 5)[1],
            'handL': ease([(0, 0), (0.35, -0.4), (1.9, -0.4), (2.4, 0)]),
            'handR': ease([(0, 0), (0.35, -0.4), (1.9, -0.4), (2.4, 0)]),
            'bodyY': ease([(0, 0), (0.35, 0.8), (0.8, 0.2), (1.2, 0.8), (1.9, 0.5), (2.4, 0)]),
            'angleY': ease([(0, 0), (0.35, 0.5), (1.9, 0.4), (2.4, 0)]),
            'eyeSmile': ease([(0, 0), (0.35, 1), (1.9, 1), (2.4, 0)]),
            'mouthOpen': ease([(0, 0), (0.35, 0.7), (1.9, 0.7), (2.4, 0)]),
            'mouthForm': ease([(0, 0), (0.35, 1), (1.9, 1), (2.4, 0)]),
        })
        clap = [(0.0, 0.0), (0.4, -0.32)]
        for i in range(6):
            clap += [(0.5 + i * 0.28, -0.22), (0.64 + i * 0.28, -0.34)]
        clap += [(2.6, -0.32), (3.0, 0.0)]
        M['clap'] = ('박수', 'Tap', 3.0, False, {
            'armLX': clap, 'armRX': clap,
            'armLY': ease([(0, 0), (0.4, 0.62), (2.6, 0.62), (3.0, 0)]),
            'armRY': ease([(0, 0), (0.4, 0.62), (2.6, 0.62), (3.0, 0)]),
            'eyeSmile': ease([(0, 0), (0.4, 1), (2.6, 1), (3.0, 0)]),
            'mouthOpen': ease([(0, 0), (0.4, 0.5), (2.6, 0.5), (3.0, 0)]),
            'mouthForm': ease([(0, 0), (0.4, 1), (2.6, 1), (3.0, 0)]),
            'bodyZ': [(0.0, 0.0)] + wave_keys(0.4, 2.6, 0.9, 0.15) + [(3.0, 0.0)],
        })
        M['stretch'] = ('기지개', 'Tap', 3.6, False, {
            'armLX': arc(0, 0.8, 0, 175)[0] + arc(2.6, 3.6, 175, 0)[0][1:],
            'armLY': arc(0, 0.8, 0, 175)[1] + arc(2.6, 3.6, 175, 0)[1][1:],
            'armRX': arc(0, 0.8, 0, 175)[0] + arc(2.6, 3.6, 175, 0)[0][1:],
            'armRY': arc(0, 0.8, 0, 175)[1] + arc(2.6, 3.6, 175, 0)[1][1:],
            'handL': ease([(0, 0), (0.8, -0.6), (2.6, -0.6), (3.6, 0)]),
            'handR': ease([(0, 0), (0.8, -0.6), (2.6, -0.6), (3.6, 0)]),
            'bodyY': ease([(0, 0), (0.8, 1.0), (2.6, 1.0), (3.6, 0)]),
            'angleY': ease([(0, 0), (0.8, 0.6), (2.6, 0.6), (3.6, 0)]),
            'bodyZ': ease([(0, 0), (1.2, 0.3), (2.0, -0.3), (2.6, 0), (3.6, 0)]),
            'eyeOpenL': ease([(0, 1), (0.8, 0), (2.6, 0), (3.2, 1)]),
            'eyeOpenR': ease([(0, 1), (0.8, 0), (2.6, 0), (3.2, 1)]),
            'mouthOpen': ease([(0, 0), (0.9, 0.9), (2.4, 0.9), (2.9, 0)]),
        })
        M['think'] = ('생각', 'Tap', 3.6, False, {
            'armRX': ease([(0, 0), (0.6, -0.42), (3.0, -0.42), (3.6, 0)]),
            'armRY': ease([(0, 0), (0.6, 0.82), (3.0, 0.82), (3.6, 0)]),
            'handR': ease([(0, 0), (0.6, 0.5), (3.0, 0.5), (3.6, 0)]),
            'angleX': ease([(0, 0), (0.7, -0.3), (3.0, -0.3), (3.6, 0)]),
            'angleY': ease([(0, 0), (0.7, 0.3), (3.0, 0.3), (3.6, 0)]),
            'angleZ': ease([(0, 0), (0.7, 0.5), (3.0, 0.5), (3.6, 0)]),
            'eyeX': ease([(0, 0), (0.7, -0.6), (3.0, -0.6), (3.6, 0)]),
            'eyeY': ease([(0, 0), (0.7, 0.6), (3.0, 0.6), (3.6, 0)]),
            'bodyZ': ease([(0, 0), (0.7, 0.15), (3.0, 0.15), (3.6, 0)]),
        })
        M['shy'] = ('수줍음', 'Tap', 3.0, False, {
            'armLX': ease([(0, 0), (0.5, -0.25), (2.5, -0.25), (3.0, 0)]),
            'armLY': ease([(0, 0), (0.5, 0.28), (2.5, 0.28), (3.0, 0)]),
            'armRX': ease([(0, 0), (0.5, -0.25), (2.5, -0.25), (3.0, 0)]),
            'armRY': ease([(0, 0), (0.5, 0.28), (2.5, 0.28), (3.0, 0)]),
            'angleY': ease([(0, 0), (0.5, -0.45), (2.5, -0.45), (3.0, 0)]),
            'angleX': ease([(0, 0), (0.5, 0.25), (2.5, 0.25), (3.0, 0)]),
            'angleZ': ease([(0, 0), (0.5, -0.4), (2.5, -0.4), (3.0, 0)]),
            'bodyZ': [(0.0, 0.0), (0.5, 0.1)] + wave_keys(0.5, 2.5, 0.75, 0.08, 0.1) + [(3.0, 0.0)],
            'cheek': ease([(0, 0), (0.5, 1), (2.5, 1), (3.0, 0)]),
            'eyeY': ease([(0, 0), (0.5, -0.5), (2.5, -0.5), (3.0, 0)]),
        })
        M['happy'] = ('신남', 'Tap', 2.4, False, {
            'bodyZ': [(0.0, 0.0)] + wave_keys(0.1, 2.1, 1.25, 0.45) + [(2.4, 0.0)],
            'angleX': [(0.0, 0.0)] + wave_keys(0.1, 2.1, 1.25, -0.25) + [(2.4, 0.0)],
            'bodyY': [(0.0, 0.0)] + [(float(t), float(abs(v))) for t, v in wave_keys(0.1, 2.1, 1.25, 0.6)] + [(2.4, 0.0)],
            'armLX': ease([(0, 0), (0.3, 0.12), (2.1, 0.12), (2.4, 0)]),
            'armLY': ease([(0, 0), (0.3, 0.35), (2.1, 0.35), (2.4, 0)]),
            'armRX': ease([(0, 0), (0.3, 0.12), (2.1, 0.12), (2.4, 0)]),
            'armRY': ease([(0, 0), (0.3, 0.35), (2.1, 0.35), (2.4, 0)]),
            'eyeSmile': ease([(0, 0), (0.3, 1), (2.1, 1), (2.4, 0)]),
            'mouthOpen': ease([(0, 0), (0.3, 0.6), (2.1, 0.6), (2.4, 0)]),
            'mouthForm': ease([(0, 0), (0.3, 1), (2.1, 1), (2.4, 0)]),
        })
    return M


def write_motions(out, param_ids, has_arms):
    """motions/<name>.motion3.json (Live2D motion3, linear segments) + the list for model.json."""
    os.makedirs(os.path.join(out, 'motions'), exist_ok=True)
    listed = []
    for name, (label, group, dur, loop, curves) in motions(has_arms).items():
        curves = {k: v for k, v in curves.items() if k in param_ids}
        if not curves:
            continue
        mc = []
        for pid, keys in curves.items():
            seg = [keys[0][0], keys[0][1]]
            for t, v in keys[1:]:
                seg += [0, round(t, 4), round(v, 4)]
            mc.append({'Target': 'Parameter', 'Id': pid, 'Segments': seg})
        fn = f'motions/{name}.motion3.json'
        with open(os.path.join(out, fn), 'w', encoding='utf-8') as f:
            json.dump({'Version': 3, 'Meta': {'Duration': dur, 'Fps': 30.0, 'Loop': loop, 'CurveCount': len(mc),
                                              'FadeInTime': 0.3, 'FadeOutTime': 0.3},
                       'Curves': mc}, f, ensure_ascii=False)
        listed.append(dict(name=name, label=label, group=group, file=fn, duration=dur, loop=loop,
                           curves={k: [[round(t, 4), round(v, 4)] for t, v in ks] for k, ks in curves.items()}))
    return listed
