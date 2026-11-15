"""
Check AI head-turn candidates: SIFT matches against the neutral picture, median motion of the eye band relative
to the neck band. A turn to the viewer's right moves the face features right (dx > 0).

  python v2/py/turn_check.py <neutral.png> <eye band y0 y1> <neck band y0 y1> <candidate.png>...
prints one JSON line per candidate: {"path", "eye_dx", "neck_dx", "turn_dx", "n"}
"""
import json
import sys

import cv2
import numpy as np
from PIL import Image


def gray(path, size=None):
    im = Image.open(path).convert('RGB')
    if size:
        im = im.resize(size)
    return cv2.cvtColor(np.asarray(im), cv2.COLOR_RGB2GRAY)


def measure(neutral, cand, eye_band, neck_band):
    N = gray(neutral)
    T = gray(cand, (N.shape[1], N.shape[0]))
    sift = cv2.SIFT_create(4000)
    kn, dn = sift.detectAndCompute(N, None)
    kt, dt = sift.detectAndCompute(T, None)
    good = [a for a, b in cv2.BFMatcher().knnMatch(dn, dt, k=2) if a.distance < 0.7 * b.distance]
    P = np.float32([kn[g.queryIdx].pt for g in good])
    Q = np.float32([kt[g.trainIdx].pt for g in good])
    D = Q - P
    band = lambda b: (P[:, 1] >= b[0]) & (P[:, 1] < b[1])
    e, k = band(eye_band), band(neck_band)
    eye = float(np.median(D[e, 0])) if e.sum() >= 5 else float('nan')
    neck = float(np.median(D[k, 0])) if k.sum() >= 3 else 0.0
    return dict(path=cand, eye_dx=round(eye, 1), neck_dx=round(neck, 1), turn_dx=round(eye - neck, 1), n=int(e.sum()))


if __name__ == '__main__':
    neutral = sys.argv[1]
    eb = (float(sys.argv[2]), float(sys.argv[3]))
    nb = (float(sys.argv[4]), float(sys.argv[5]))
    for c in sys.argv[6:]:
        print(json.dumps(measure(neutral, c, eb, nb)))
