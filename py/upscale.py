"""
Anime upscaler: Real-ESRGAN x4plus_anime_6B (RRDBNet, 6 blocks), defined here so no extra package is needed.

Weights: .local/models/RealESRGAN_x4plus_anime_6B.pth
  https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth (BSD-3-Clause)

  python py/upscale.py in.png out.png [--scale 4]
"""
import argparse
import os
import sys

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
WEIGHTS = os.path.join(ROOT, '.local', 'models', 'RealESRGAN_x4plus_anime_6B.pth')


class ResidualDenseBlock(nn.Module):
    def __init__(self, nf=64, gc=32):
        super().__init__()
        self.conv1 = nn.Conv2d(nf, gc, 3, 1, 1)
        self.conv2 = nn.Conv2d(nf + gc, gc, 3, 1, 1)
        self.conv3 = nn.Conv2d(nf + 2 * gc, gc, 3, 1, 1)
        self.conv4 = nn.Conv2d(nf + 3 * gc, gc, 3, 1, 1)
        self.conv5 = nn.Conv2d(nf + 4 * gc, nf, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(0.2, inplace=True)

    def forward(self, x):
        x1 = self.lrelu(self.conv1(x))
        x2 = self.lrelu(self.conv2(torch.cat((x, x1), 1)))
        x3 = self.lrelu(self.conv3(torch.cat((x, x1, x2), 1)))
        x4 = self.lrelu(self.conv4(torch.cat((x, x1, x2, x3), 1)))
        x5 = self.conv5(torch.cat((x, x1, x2, x3, x4), 1))
        return x5 * 0.2 + x


class RRDB(nn.Module):
    def __init__(self, nf, gc=32):
        super().__init__()
        self.rdb1 = ResidualDenseBlock(nf, gc)
        self.rdb2 = ResidualDenseBlock(nf, gc)
        self.rdb3 = ResidualDenseBlock(nf, gc)

    def forward(self, x):
        return self.rdb3(self.rdb2(self.rdb1(x))) * 0.2 + x


class RRDBNet(nn.Module):
    def __init__(self, in_nc=3, out_nc=3, nf=64, nb=6, gc=32):
        super().__init__()
        self.conv_first = nn.Conv2d(in_nc, nf, 3, 1, 1)
        self.body = nn.Sequential(*[RRDB(nf, gc) for _ in range(nb)])
        self.conv_body = nn.Conv2d(nf, nf, 3, 1, 1)
        self.conv_up1 = nn.Conv2d(nf, nf, 3, 1, 1)
        self.conv_up2 = nn.Conv2d(nf, nf, 3, 1, 1)
        self.conv_hr = nn.Conv2d(nf, nf, 3, 1, 1)
        self.conv_last = nn.Conv2d(nf, out_nc, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(0.2, inplace=True)

    def forward(self, x):
        feat = self.conv_first(x)
        feat = feat + self.conv_body(self.body(feat))
        feat = self.lrelu(self.conv_up1(F.interpolate(feat, scale_factor=2, mode='nearest')))
        feat = self.lrelu(self.conv_up2(F.interpolate(feat, scale_factor=2, mode='nearest')))
        return self.conv_last(self.lrelu(self.conv_hr(feat)))


_model = None


def load(device='cuda'):
    global _model
    if _model is None:
        sd = torch.load(WEIGHTS, map_location='cpu', weights_only=True)
        sd = sd.get('params_ema', sd.get('params', sd))
        m = RRDBNet()
        m.load_state_dict(sd, strict=True)
        _model = m.eval().to(device).half()
    return _model


@torch.no_grad()
def upscale(img, scale=4, tile=256, pad=16):
    """PIL image -> PIL image upscaled 4x by the network (alpha, if any, upscaled with Lanczos), then resized to `scale`."""
    rgba = img.convert('RGBA')
    rgb = np.asarray(rgba.convert('RGB'), np.float32) / 255.0
    h, w = rgb.shape[:2]
    m = load()
    x = torch.from_numpy(rgb).permute(2, 0, 1)[None].cuda().half()
    out = torch.zeros((1, 3, h * 4, w * 4), dtype=torch.float32)
    for y0 in range(0, h, tile):
        for x0 in range(0, w, tile):
            ya, xa = max(0, y0 - pad), max(0, x0 - pad)
            yb, xb = min(h, y0 + tile + pad), min(w, x0 + tile + pad)
            o = m(x[:, :, ya:yb, xa:xb]).float().cpu()
            oy, ox = (y0 - ya) * 4, (x0 - xa) * 4
            th, tw = min(tile, h - y0) * 4, min(tile, w - x0) * 4
            out[:, :, y0 * 4:y0 * 4 + th, x0 * 4:x0 * 4 + tw] = o[:, :, oy:oy + th, ox:ox + tw]
    arr = (out[0].clamp(0, 1).permute(1, 2, 0).numpy() * 255 + 0.5).astype(np.uint8)
    res = Image.fromarray(arr, 'RGB').convert('RGBA')
    res.putalpha(rgba.getchannel('A').resize(res.size, Image.LANCZOS))
    if scale != 4:
        res = res.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
    return res if img.mode == 'RGBA' else res.convert('RGB')


def unload():
    global _model
    _model = None
    torch.cuda.empty_cache()


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('--scale', type=float, default=4)
    a = ap.parse_args()
    upscale(Image.open(a.src), a.scale).save(a.dst)
    print(a.dst, file=sys.stderr)
