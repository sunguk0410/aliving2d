/*!
 * Capsule Model Studio — rigger.js (based on Anime2.5DRig, MIT)
 * PSD (parsed by ag-psd, useImageData mode) -> rig definition.
 * Pure typed-array implementation: runs in browser and Node (testable).
 * MIT License
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Rigger = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- layer naming ----------
  // Aliases are keyed by a "squashed" form (NFKC, lower case, no spaces,
  // underscores, hyphens or middle dots) so that "Front_Hair", "front-hair",
  // "前髪" and "bangs" all resolve to the same semantic slot.
  var ALIAS_GROUPS = {
    'front hair':  'fronthair hairfront bangs fringe 前髪 まえがみ',
    'back hair':   'backhair hairback 後ろ髪 後髪 うしろがみ',
    'side hair':   'sidehair hairside sidelock sidelocks 横髪 サイド髪 もみあげ',
    'ahoge':       'ahoge アホ毛 あほ毛',
    'hair':        'hair 髪 髪の毛 かみ',
    'face':        'face 顔 かお 輪郭 facebase',
    'facedetail':  'facedetail blush cheek cheeks 頬 頬染め チーク',
    'eyewhite':    'eyewhite eyewhites sclera 白目',
    'irides':      'irides iris irises pupil pupils 瞳 黒目 虹彩',
    'eyelash':     'eyelash eyelashes lash lashes eyeline まつ毛 まつげ 睫毛 アイライン',
    'eyebrow':     'eyebrow eyebrows brow brows 眉 眉毛 まゆ まゆげ',
    'eye_close':   'eyeclose eyeclosed eyesclosed closedeye closedeyes 閉じ目 目閉じ 閉眼',
    'mouth_open':  'mouthopen openmouth 口 開き口 口開き 開口',
    'mouth_close': 'mouthclose mouthclosed closedmouth 閉じ口 口閉じ',
    'eye_smile':   'eyesmile smileeye smileeyes 웃는눈 笑い目',
    'mouth_grin':  'mouthgrin grin 웃는입',
    'mouth_o':     'moutho omouth 오입',
    'mouth_smile': 'mouthsmile smilemouth 미소입',
    'nose':        'nose 鼻 はな',
    'ears':        'ears ear 耳',
    'earwear':     'earwear earring earrings イヤリング ピアス 耳飾り',
    'neck':        'neck 首',
    'neckwear':    'neckwear necktie tie necklace choker ネクタイ ネックレス チョーカー 首飾り',
    'topwear':     'topwear top tops shirt body torso clothes 服 上着 体 胴体 上半身 トップス',
    'bottomwear':  'bottomwear bottom bottoms skirt pants スカート ズボン ボトムス 下半身',
    'handwear':    'handwear hand hands arm arms gloves 手 腕 手袋',
    'legwear':     'legwear leg legs socks tights 脚 足 靴下 ソックス タイツ',
    'footwear':    'footwear shoes shoe boots 靴 ブーツ',
    'headwear':    'headwear hat cap hairpin hairband 帽子 カチューシャ 髪飾り ヘアピン',
    'eyewear':     'eyewear glasses 眼鏡 メガネ めがね',
    'tail':        'tail しっぽ 尻尾 シッポ',
    'wings':       'wings wing 羽 翼 羽根',
    'objects':     'objects object 小物 持ち物',
    // capsule effect layers (hidden until an expression turns them on)
    'fx_blush':    'fxblush blushfx 홍조 照れ 赤面',
    'fx_sweat':    'fxsweat sweat sweatdrop 땀 汗',
    'fx_tears':    'fxtears tears tear 눈물 涙',
    'fx_anger':    'fxanger anger angermark 화남 怒りマーク 怒り',
    'fx_gloom':    'fxgloom gloom 그늘 縦線'
  };
  var ALIASES = Object.create(null);
  Object.keys(ALIAS_GROUPS).forEach(function (canon) {
    ALIAS_GROUPS[canon].split(' ').forEach(function (a) { ALIASES[squash(a)] = canon; });
  });
  function squash(s) { return String(s).replace(/[\s_\-・･.]+/g, ''); }
  function canonical(base) { return ALIASES[squash(base)] || null; }

  function normName(n) {
    n = String(n || '').normalize('NFKC').trim()
      .replace(/\s*のコピー\s*\d*$/, '').replace(/\s+copy(\s*\d+)?$/i, '')
      .toLowerCase().replace(/\s+/g, ' ');
    // Legacy and special names first.
    if (n === 'eyelash_c') return 'eye_close';
    if (n === 'mouth_c') return 'mouth_close';
    if (n === 'レイヤー 1') return 'facedetail';
    if (n === 'mouth' || /^mouth[ _-]?\d+$/.test(n)) return 'mouth_open';   // see-through raw output
    // "eye_close2" / "eyeclose2" / "閉じ目2" select the long closed-eye variant.
    // A separator before the number ("eye_close_2") is a numbered part instead.
    if (/^(eye_?close|eye close|閉じ目)2$/.test(n)) return 'eye_close2';
    var direct = canonical(n);
    if (direct) return direct;
    // see-through --tblr_split writes "handwear-l" / "irides-r"; sides are re-detected from pixels
    var lr = /^(.+?)[ _-](l|r|left|right)$/.exec(n);
    if (lr && canonical(lr[1])) return canonical(lr[1]);
    var m = /^(.+?)[ _-]?(\d+)$/.exec(n);
    if (m) {
      var base = canonical(m[1].trim()) || (SLOTS[m[1].trim()] ? m[1].trim() : null);
      if (base) return base + '_' + m[2];
    }
    return n;
  }
  function baseName(n) { return n === 'eye_close2' ? n : n.replace(/_\d+$/, ''); }

  // PSD folders are only an authoring convenience.  Leaf coordinates emitted by
  // ag-psd are canvas-relative, so flattening the tree does not alter placement.
  function imageLayersOf(psd) {
    var out = [];
    function visit(nodes, parentVisible) {
      (nodes || []).forEach(function (c) {
        var visible = parentVisible && c.hidden !== true;
        if (!visible) return;
        if (c.children) visit(c.children, visible);
        else if (c.imageData) out.push(c);
      });
    }
    visit(psd.children, true);
    return out;
  }

  function validatePsd(psd) {
    if (!psd || !Number.isInteger(psd.width) || !Number.isInteger(psd.height) || psd.width < 2 || psd.height < 2)
      throw new Error('PSD 캔버스 크기가 올바르지 않습니다');
    if (psd.width * psd.height > 24000000 || Math.max(psd.width, psd.height) > 16384)
      throw new Error('캔버스가 너무 큽니다 (최대 2400만 화소, 한 변 16384px)');
    var pixels = 0, count = 0;
    function visit(nodes, depth) {
      if (depth > 64) throw new Error('폴더 단계가 너무 깊습니다');
      (nodes || []).forEach(function (c) {
        if (++count > 1000) throw new Error('레이어가 너무 많습니다 (최대 1000개)');
        if (c.children) visit(c.children, depth + 1);
        var w = c.imageData ? c.imageData.width : Math.max(0, (c.right || 0) - (c.left || 0));
        var h = c.imageData ? c.imageData.height : Math.max(0, (c.bottom || 0) - (c.top || 0));
        if (!Number.isInteger(w) || !Number.isInteger(h) || w < 0 || h < 0 || w * h > 24000000)
          throw new Error('이미지 레이어 크기가 올바르지 않거나 너무 큽니다');
        pixels += w * h;
        if (c.imageData && (!c.imageData.data || c.imageData.data.length !== w * h * 4))
          throw new Error('이미지 레이어의 픽셀 데이터가 올바르지 않습니다');
      });
    }
    visit(psd.children, 0);
    if (pixels > 96000000) throw new Error('레이어 이미지 합계가 너무 큽니다 (최대 9600만 화소)');
    return psd;
  }

  var SLOTS = {
    'wings':       { depth: 0.48, group: 'body' },
    'tail':        { depth: 0.50, group: 'body', phys: 'sway' },
    'back hair':   { depth: 0.55, group: 'head', phys: 'hair' },
    'footwear':    { depth: 0.83, group: 'body' },
    'legwear':     { depth: 0.84, group: 'body' },
    'bottomwear':  { depth: 0.88, group: 'body' },
    'neck':        { depth: 0.95, group: 'body' },
    'topwear':     { depth: 0.90, group: 'body' },
    'neckwear':    { depth: 0.98, group: 'body' },
    'handwear':    { depth: 0.86, group: 'body', arm: true },
    'objects':     { depth: 1.00, group: 'auto' },
    'earwear':     { depth: 0.97, group: 'head', phys: 'sway' },
    'ears':        { depth: 0.96, group: 'head' },
    'face':        { depth: 1.00, group: 'head' },
    'facedetail':  { depth: 1.02, group: 'head' },
    'headwear':    { depth: 1.20, group: 'head' },
    'mouth_close': { depth: 1.08, group: 'head', fade: 'mouthClose' },
    'mouth_open':  { depth: 1.08, group: 'head', fade: 'mouthOpen' },
    'nose':        { depth: 1.15, group: 'head' },
    'eyewhite':    { depth: 1.06, group: 'head', split: true, fade: 'eyeOpen' },
    'eyebrow':     { depth: 1.14, group: 'head', split: true },
    'irides':      { depth: 1.08, group: 'head', split: true, fade: 'eyeOpen' },
    'eyelash':     { depth: 1.12, group: 'head', split: true, fade: 'eyeOpen' },
    'eye_close':   { depth: 1.12, group: 'head', split: true, fade: 'eyeClose' },
    'eye_close2':  { depth: 1.12, group: 'head', split: true, fade: 'eyeClose2' },
    'eye_smile':   { depth: 1.12, group: 'head', split: true, fade: 'eyeSmile' },
    'eye_lid':     { depth: 1.12, group: 'head', fade: 'eyeLid' },
    'mouth_grin':  { depth: 1.08, group: 'head', fade: 'mouthGrin' },
    'mouth_o':     { depth: 1.08, group: 'head', fade: 'mouthO' },
    'mouth_smile': { depth: 1.08, group: 'head', fade: 'mouthSmile' },
    // capsule: rigged mouth parts (synthMouth); the engine opens them with mouthOpen
    'mouth_inner':     { depth: 1.08, group: 'head', fade: 'mouthRig' },
    'mouth_teeth':     { depth: 1.08, group: 'head', fade: 'mouthRig' },
    'mouth_tongue':    { depth: 1.08, group: 'head', fade: 'mouthRig' },
    'mouth_lip_lower': { depth: 1.08, group: 'head', fade: 'mouthRig' },
    'mouth_lip_upper': { depth: 1.08, group: 'head', fade: 'mouthRig' },
    'eyewear':    { depth: 1.18, group: 'head' },
    'side hair':   { depth: 1.22, group: 'head', phys: 'hair' },
    'front hair':  { depth: 1.28, group: 'head', phys: 'hair' },
    'ahoge':       { depth: 1.30, group: 'head', phys: 'hair' },
    'fx_blush':    { depth: 1.03, group: 'head', fade: 'fx', fx: 'fxBlush' },
    'fx_tears':    { depth: 1.13, group: 'head', fade: 'fx', fx: 'fxTears' },
    'fx_gloom':    { depth: 1.29, group: 'head', fade: 'fx', fx: 'fxGloom' },
    'fx_sweat':    { depth: 1.32, group: 'head', fade: 'fx', fx: 'fxSweat' },
    'fx_anger':    { depth: 1.32, group: 'head', fade: 'fx', fx: 'fxAnger' }
  };
  var FX_SLOTS = ['fx_blush', 'fx_tears', 'fx_gloom', 'fx_sweat', 'fx_anger'];
  // Human readable role names used by the editor and diagnostics.
  var ROLE_LABELS = {
    'wings': '날개', 'tail': '꼬리', 'back hair': '뒷머리', 'footwear': '신발', 'legwear': '다리',
    'bottomwear': '하의', 'neck': '목', 'topwear': '상의', 'neckwear': '목장식',
    'handwear': '팔·손', 'objects': '소품', 'earwear': '귀걸이', 'ears': '귀', 'face': '얼굴',
    'facedetail': '얼굴 디테일', 'headwear': '머리 장식', 'mouth_close': '다문 입', 'mouth_open': '벌린 입',
    'nose': '코', 'eyewhite': '흰자', 'eyebrow': '눈썹', 'irides': '눈동자', 'eyelash': '속눈썹',
    'eye_close': '감은 눈', 'eye_close2': '긴 감은 눈', 'eye_lid': '눈꺼풀 (자동)', 'eyelash_crease': '쌍꺼풀 선', 'eyelash_lower': '아래 속눈썹', 'eye_smile': '웃는 눈 (^ ^)', 'mouth_grin': '활짝 웃는 입', 'mouth_o': '오 입', 'mouth_smile': '미소 입',
    'mouth_inner': '입 안 (자동)', 'mouth_teeth': '윗니 (자동)', 'mouth_tongue': '혀 (자동)', 'mouth_lip_lower': '아랫입술 선 (자동)', 'mouth_lip_upper': '윗입술 선', 'eyewear': '안경', 'side hair': '옆머리',
    'front hair': '앞머리', 'ahoge': '바보털',
    'fx_blush': '효과: 홍조', 'fx_sweat': '효과: 땀', 'fx_tears': '효과: 눈물', 'fx_anger': '효과: 화남 표시', 'fx_gloom': '효과: 그늘'
  };

  // ---------- image ops (full-canvas alpha as Uint8Array) ----------
  function fullAlphaOf(layer, W, H) {
    var a = new Uint8Array(W * H);
    var img = layer.imageData, lw = img.width, lh = img.height;
    var lx = layer.left | 0, ly = layer.top | 0, d = img.data;
    for (var y = 0; y < lh; y++) {
      var cy = y + ly; if (cy < 0 || cy >= H) continue;
      var ro = cy * W, lo = y * lw;
      for (var x = 0; x < lw; x++) {
        var cx = x + lx; if (cx < 0 || cx >= W) continue;
        a[ro + cx] = d[(lo + x) * 4 + 3];
      }
    }
    return a;
  }

  function labelComponents(alpha, W, H, thr) {
    var lab = new Int32Array(W * H), sizes = [0], sumX = [0], cnt = 0;
    var stack = new Int32Array(W * H);
    for (var s = 0; s < W * H; s++) {
      if (lab[s] || alpha[s] <= thr) continue;
      cnt++; var sp = 0; stack[sp++] = s; lab[s] = cnt;
      var size = 0, sx = 0;
      while (sp) {
        var q = stack[--sp]; size++; sx += q % W;
        var x = q % W, y = (q / W) | 0;
        if (x > 0        && !lab[q - 1] && alpha[q - 1] > thr) { lab[q - 1] = cnt; stack[sp++] = q - 1; }
        if (x < W - 1    && !lab[q + 1] && alpha[q + 1] > thr) { lab[q + 1] = cnt; stack[sp++] = q + 1; }
        if (y > 0        && !lab[q - W] && alpha[q - W] > thr) { lab[q - W] = cnt; stack[sp++] = q - W; }
        if (y < H - 1    && !lab[q + W] && alpha[q + W] > thr) { lab[q + W] = cnt; stack[sp++] = q + W; }
      }
      sizes.push(size); sumX.push(sx);
    }
    return { lab: lab, count: cnt, sizes: sizes, sumX: sumX };
  }

  function dilate(mask, W, H, r) {
    var tmp = new Uint8Array(W * H), out = new Uint8Array(W * H), x, y, k;
    for (y = 0; y < H; y++) {
      var o = y * W;
      for (x = 0; x < W; x++) {
        var v = 0;
        for (k = -r; k <= r; k++) { var xx = x + k; if (xx >= 0 && xx < W && mask[o + xx]) { v = 1; break; } }
        tmp[o + x] = v;
      }
    }
    for (x = 0; x < W; x++) for (y = 0; y < H; y++) {
      var v2 = 0;
      for (k = -r; k <= r; k++) { var yy = y + k; if (yy >= 0 && yy < H && tmp[yy * W + x]) { v2 = 1; break; } }
      out[y * W + x] = v2;
    }
    return out;
  }

  // kill stray dust: keep components >= minPx (on alpha>16), dilate, zero the rest
  function cleanAlpha(alpha, W, H, minPx) {
    var L = labelComponents(alpha, W, H, 16);
    if (!L.count) return alpha;
    var keepComp = new Uint8Array(L.count + 1), any = false, i;
    for (i = 1; i <= L.count; i++) if (L.sizes[i] >= minPx) { keepComp[i] = 1; any = true; }
    if (!any) return alpha;
    var mask = new Uint8Array(W * H);
    for (i = 0; i < W * H; i++) if (keepComp[L.lab[i]]) mask[i] = 1;
    mask = dilate(mask, W, H, 3);
    for (i = 0; i < W * H; i++) if (!mask[i]) alpha[i] = 0;
    return alpha;
  }

  // split into left/right masks by component centroid vs face center x
  function splitSides(alpha, W, H, faceCx) {
    var L = labelComponents(alpha, W, H, 16);
    var side = new Uint8Array(L.count + 1); // 1=left 2=right
    for (var c = 1; c <= L.count; c++) {
      if (L.sizes[c] < 20) continue;
      side[c] = (L.sumX[c] / L.sizes[c]) < faceCx ? 1 : 2;
    }
    var ml = new Uint8Array(W * H), mr = new Uint8Array(W * H), i;
    for (i = 0; i < W * H; i++) {
      if (side[L.lab[i]] === 1) ml[i] = 1; else if (side[L.lab[i]] === 2) mr[i] = 1;
    }
    var out = {};
    var nl = 0, nr = 0;
    for (i = 0; i < W * H; i++) { nl += ml[i]; nr += mr[i]; }
    if (nl) out.l = dilate(ml, W, H, 3);
    if (nr) out.r = dilate(mr, W, H, 3);
    return out;
  }

  function bboxOf(alpha, W, H, thr) {
    var x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (var y = 0; y < H; y++) {
      var o = y * W;
      for (var x = 0; x < W; x++) if (alpha[o + x] > thr) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    return x1 < 0 ? null : { x0: x0, y0: y0, x1: x1, y1: y1 };
  }

  function centroidOf(alpha, W, H) {
    var sx = 0, sy = 0, s = 0;
    for (var y = 0; y < H; y++) {
      var o = y * W;
      for (var x = 0; x < W; x++) { var a = alpha[o + x]; if (a) { sx += x * a; sy += y * a; s += a; } }
    }
    return s ? { cx: sx / s, cy: sy / s } : null;
  }

  function mergeAlphas(entries, W, H) {
    if (!entries || !entries.length) return null;
    var out = new Uint8Array(W * H);
    for (var e = 0; e < entries.length; e++) {
      var a = entries[e].alpha;
      for (var i = 0; i < out.length; i++) if (a[i] > out[i]) out[i] = a[i];
    }
    return out;
  }

  // ---------- generic close-diff synthesis ----------
  function resampleRGBA(src, tw, th) {   // bilinear
    var out = new Uint8ClampedArray(tw * th * 4);
    var sw = src.width, sh = src.height, d = src.data;
    for (var y = 0; y < th; y++) {
      var sy = Math.max(0, Math.min(sh - 1, (y + 0.5) * sh / th - 0.5));
      var y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(sh - 1, y0 + 1), fy = sy - y0;
      for (var x = 0; x < tw; x++) {
        var sx = Math.max(0, Math.min(sw - 1, (x + 0.5) * sw / tw - 0.5));
        var x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(sw - 1, x0 + 1), fx = sx - x0;
        var o = (y * tw + x) * 4;
        var ids = [(y0 * sw + x0) * 4, (y0 * sw + x1) * 4, (y1 * sw + x0) * 4, (y1 * sw + x1) * 4];
        var ws = [(1-fx)*(1-fy), fx*(1-fy), (1-fx)*fy, fx*fy], a = 0;
        for (var k = 0; k < 4; k++) a += d[ids[k]+3] * ws[k];
        out[o+3] = a;
        for (var c = 0; c < 3; c++) {
          var value = 0;
          for (var q = 0; q < 4; q++) value += d[ids[q]+c] * d[ids[q]+3] * ws[q];
          out[o+c] = a ? value/a : 0;
        }
      }
    }
    return out;
  }
  function meanColorOfImg(img, darkWeight) {   // alpha-weighted mean RGB
    var d = img.data, r = 0, g = 0, b = 0, s = 0;
    for (var i = 0; i < d.length; i += 4) {
      var a = d[i + 3]; if (a < 24) continue;
      var w = a;
      if (darkWeight) { var lum = (d[i] + d[i + 1] + d[i + 2]) / 3; w = a * Math.pow(1 - lum / 255, 2); }
      r += d[i] * w; g += d[i + 1] * w; b += d[i + 2] * w; s += w;
    }
    return s ? [r / s, g / s, b / s] : null;
  }
  function recolorTo(data, target) {   // flat recolor preserving relative luminance
    var lumSum = 0, n = 0, i;
    for (i = 0; i < data.length; i += 4) if (data[i + 3] > 24) { lumSum += (data[i] + data[i + 1] + data[i + 2]) / 3; n++; }
    if (!n) return;
    var mean = Math.max(8, lumSum / n);
    for (i = 0; i < data.length; i += 4) {
      if (!data[i + 3]) continue;
      var f = Math.min(2.2, ((data[i] + data[i + 1] + data[i + 2]) / 3) / mean);
      data[i] = target[0] * f; data[i + 1] = target[1] * f; data[i + 2] = target[2] * f;
    }
  }
  function synthPart(name, gimg, targetW, cx, anchorY, vAlign, tint, slot, side) {
    var scale = targetW / gimg.width;
    var tw = Math.max(2, Math.round(targetW)), th = Math.max(2, Math.round(gimg.height * scale));
    var data = resampleRGBA(gimg, tw, th);
    if (tint) recolorTo(data, tint);
    return { name: name, source: '', x: Math.round(cx - tw / 2), y: Math.round(anchorY - vAlign * th),
             w: tw, h: th, z: 0, depth: slot.depth, group: 'head', phys: null,
             fade: slot.fade || null, side: side || null, strands: null, synthetic: true,
             img: { width: tw, height: th, data: data } };
  }
  function lastIndexWhere(arr, pred) {
    for (var i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
    return -1;
  }

  // ---------- flat-image utilities (custom generic-diff PSDs) ----------
  function trimImg(img, thr) {
    thr = thr || 8;
    var W = img.width, H = img.height, d = img.data;
    var x0 = W, y0 = H, x1 = -1, y1 = -1, x, y;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++)
      if (d[(y * W + x) * 4 + 3] > thr) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    if (x1 < 0) return null;
    var w = x1 - x0 + 1, h = y1 - y0 + 1;
    var out = new Uint8ClampedArray(w * h * 4);
    for (y = 0; y < h; y++) out.set(d.subarray(((y + y0) * W + x0) * 4, ((y + y0) * W + x0 + w) * 4), y * w * 4);
    return { width: w, height: h, data: out };
  }
  // alpha-over composite of all layers, trimmed
  function flattenPsdToImg(psd) {
    validatePsd(psd);
    var W = psd.width, H = psd.height;
    var buf = new Uint8ClampedArray(W * H * 4);
    imageLayersOf(psd).forEach(function (c) {
      if (!c.imageData) return;
      var img = c.imageData, lw = img.width, lh = img.height, lx = c.left | 0, ly = c.top | 0, d = img.data;
      for (var y = 0; y < lh; y++) {
        var cy = y + ly; if (cy < 0 || cy >= H) continue;
        for (var x = 0; x < lw; x++) {
          var cx = x + lx; if (cx < 0 || cx >= W) continue;
          var si = (y * lw + x) * 4, di = (cy * W + cx) * 4, a = d[si + 3] / 255 * (c.opacity == null ? 1 : c.opacity);
          if (!a) continue;
          var da = buf[di+3]/255, oa = a + da*(1-a);
          for (var k = 0; k < 3; k++) buf[di + k] = (d[si+k]*a + buf[di+k]*da*(1-a))/oa;
          buf[di + 3] = oa * 255;
        }
      }
    });
    return trimImg({ width: W, height: H, data: buf });
  }
  // split a both-eyes image into L/R at the widest interior empty-column gap
  function splitImgLR(img) {
    var W = img.width, H = img.height, d = img.data;
    var col = new Uint8Array(W), x, y;
    for (x = 0; x < W; x++) for (y = 0; y < H; y++) if (d[(y * W + x) * 4 + 3] > 16) { col[x] = 1; break; }
    var best = null, start = -1;
    for (x = 0; x < W; x++) {
      if (!col[x]) { if (start < 0) start = x; }
      else { if (start > 0 && (!best || x - start > best[1] - best[0])) best = [start, x]; start = -1; }
    }
    if (!best) return null;
    var mid = (best[0] + best[1]) >> 1;
    function cut(a, b) {
      var w = b - a, out = new Uint8ClampedArray(w * H * 4);
      for (var yy = 0; yy < H; yy++) out.set(d.subarray((yy * W + a) * 4, (yy * W + b) * 4), yy * w * 4);
      return trimImg({ width: w, height: H, data: out });
    }
    var l = cut(0, mid), r = cut(mid, W);
    return (l && r) ? { l: l, r: r } : null;
  }

  // ---------- strand detection ----------
  function findPeaks(a, minDist, minProm) {
    var n = a.length, cand = [], i;
    for (i = 1; i < n - 1; i++) {
      if (!(a[i] > a[i - 1] && a[i] >= a[i + 1])) continue;
      // A flat top (common after box smoothing of narrow parts) peaks at its centre.
      var e = i; while (e + 1 < n && a[e + 1] === a[i]) e++;
      if (e + 1 < n && a[e + 1] > a[i]) continue;
      cand.push((i + e) >> 1); i = e;
    }
    var peaks = [];
    for (var ci = 0; ci < cand.length; ci++) {
      var p = cand[ci], lmin = a[p], rmin = a[p], j;
      for (j = p - 1; j >= 0; j--) { if (a[j] > a[p]) break; if (a[j] < lmin) lmin = a[j]; }
      for (j = p + 1; j < n; j++) { if (a[j] > a[p]) break; if (a[j] < rmin) rmin = a[j]; }
      var prom = a[p] - Math.max(lmin, rmin);
      if (prom >= minProm) peaks.push({ x: p, prom: prom });
    }
    peaks.sort(function (u, v) { return v.prom - u.prom; });
    var kept = [];
    for (var k = 0; k < peaks.length; k++) {
      var pk = peaks[k], ok = true;
      for (var m = 0; m < kept.length; m++) if (Math.abs(kept[m].x - pk.x) < minDist) { ok = false; break; }
      if (ok) kept.push(pk);
    }
    return kept; // prominence-ordered
  }

  function detectStrands(alpha, W, H, minSep, want) {
    var bottom = new Float32Array(W), top = new Float32Array(W);
    var minX = W, maxX = -1, x, y;
    for (x = 0; x < W; x++) {
      top[x] = -1; bottom[x] = 0;
      for (y = 0; y < H; y++) if (alpha[y * W + x] > 16) { top[x] = y; break; }
      if (top[x] < 0) continue;
      for (y = H - 1; y >= 0; y--) if (alpha[y * W + x] > 16) { bottom[x] = y; break; }
      if (x < minX) minX = x; if (x > maxX) maxX = x;
    }
    if (maxX < 0) return [];
    // box smooth k=41, zero-padded 'same'
    var k = 41, hk = 20, sm = new Float32Array(W);
    var pre = new Float32Array(W + 1);
    for (x = 0; x < W; x++) pre[x + 1] = pre[x] + bottom[x];
    for (x = 0; x < W; x++) {
      var a0 = Math.max(0, x - hk), a1 = Math.min(W - 1, x + hk);
      sm[x] = (pre[a1 + 1] - pre[a0]) / k;
    }
    var pk = findPeaks(sm, minSep, 10);
    var xs = [];
    for (var i = 0; i < pk.length && xs.length < want; i++) xs.push(pk[i].x);
    // fill up: farthest-from-existing candidates with content
    var guard = 0;
    while (xs.length < want && guard++ < 50) {
      var best = -1, bestD = -1;
      for (var t = 0; t < 40; t++) {
        var inset = Math.min(30, (maxX - minX) / 4);
        var cx = Math.round(minX + inset + (maxX - minX - 2 * inset) * t / 39);
        if (cx < 0 || cx >= W || top[cx] < 0) continue;
        var dmin = 1e9;
        for (var m = 0; m < xs.length; m++) dmin = Math.min(dmin, Math.abs(cx - xs[m]));
        if (xs.length === 0) dmin = 1e9 - t;
        if (dmin > bestD) { bestD = dmin; best = cx; }
      }
      if (best < 0 || (xs.length && bestD < Math.max(1, minSep))) break;
      xs.push(best);
    }
    xs.sort(function (a, b) { return a - b; });
    var strands = [], used = Object.create(null);
    for (var s = 0; s < xs.length; s++) {
      var sx = xs[s];
      // Smoothing can move a peak off the painted columns; snap to the nearest one.
      for (var r = 0; top[sx] < 0 && r < W; r++) {
        if (xs[s] - r >= 0 && top[xs[s] - r] >= 0) sx = xs[s] - r;
        else if (xs[s] + r < W && top[xs[s] + r] >= 0) sx = xs[s] + r;
      }
      if (top[sx] < 0 || used[sx]) continue;
      used[sx] = true;
      strands.push({ x: sx, tipY: bottom[sx], rootY: top[sx] });
    }
    strands.sort(function (a, b) { return a.x - b.x; });
    return strands;
  }

  // ---------- arms (capsule) ----------
  // Split an arm layer into image-left / image-right masks. Components are
  // assigned by centroid; a component that straddles the face center (hands
  // joined in front) is cut at the face center column.
  // Returns {torso: true} when the layer is not arms only (see-through
  // sometimes puts the whole upper body into handwear): splitting that
  // down the middle would tear the body apart.
  function splitArms(alpha, W, H, FACE) {
    var faceCx = FACE.cx, band = Math.max(4, (FACE.x1 - FACE.x0) * 0.15);
    var tot = 0, mid = 0, k;
    for (k = 0; k < W * H; k++) if (alpha[k] > 128) { tot++; if (Math.abs((k % W) - faceCx) < band) mid++; }
    if (!tot || mid > tot * 0.1) return { torso: !!tot };
    var L = labelComponents(alpha, W, H, 16);
    var ml = new Uint8Array(W * H), mr = new Uint8Array(W * H), c, i;
    var nLeft = new Int32Array(L.count + 1);
    for (i = 0; i < W * H; i++) { var lb = L.lab[i]; if (lb && (i % W) < faceCx) nLeft[lb]++; }
    var mode = new Uint8Array(L.count + 1);   // 1 left, 2 right, 3 cut at faceCx
    for (c = 1; c <= L.count; c++) {
      if (L.sizes[c] < 20) continue;
      var fl = nLeft[c] / L.sizes[c];
      mode[c] = fl > 0.8 ? 1 : fl < 0.2 ? 2 : 3;
    }
    var nl = 0, nr = 0;
    for (i = 0; i < W * H; i++) {
      var m = mode[L.lab[i]];
      if (!m) continue;
      if (m === 1 || (m === 3 && (i % W) < faceCx)) { ml[i] = 1; nl++; } else { mr[i] = 1; nr++; }
    }
    var out = {};
    if (nl) out.l = dilate(ml, W, H, 3);
    if (nr) out.r = dilate(mr, W, H, 3);
    return out;
  }

  // Tilt of one eye: the line through its two corners (the white's left- and right-most
  // columns, each at the middle of its opaque run), within ±35°. Eye smiles bend along this
  // line, so a tilted eye smiles along its own axis.
  function eyeAxis(alpha, W, H, b) {
    var w = b.x1 - b.x0 + 1;
    if (w < 6) return 0;
    var band = Math.max(1, Math.round(w * 0.08));
    function cornerY(x0, x1) {
      var sy = 0, n = 0;
      for (var x = x0; x <= x1; x++) for (var y = b.y0; y <= b.y1; y++) if (alpha[y * W + x] > 64) { sy += y; n++; }
      return n ? sy / n : null;
    }
    var yl = cornerY(b.x0, b.x0 + band), yr = cornerY(b.x1 - band, b.x1);
    if (yl === null || yr === null) return 0;
    var ang = Math.atan2(yr - yl, w - band), lim = 35 * Math.PI / 180;
    return Math.round(Math.max(-lim, Math.min(lim, ang)) * 1000) / 1000;
  }

  // Arms painted into the torso layer (see-through sometimes emits the whole
  // upper body as handwear). Each arm is the outer strip of the silhouette:
  // below the shoulder line, a seam is searched inside a band next to the
  // silhouette edge, following the strongest painted line (the fold / outline
  // between arm and body) with dynamic programming. Behind each arm the torso
  // is extended a little with its own edge colours, so a raised arm does not
  // leave a hole. Returns null when the layer does not look like that.
  function carveArms(layer, alpha, W, H, FACE) {
    var fw = Math.max(20, FACE.x1 - FACE.x0), x, y, i;
    var xl = new Int32Array(H).fill(-1), xr = new Int32Array(H).fill(-1);
    for (y = 0; y < H; y++) {
      var o = y * W;
      for (x = 0; x < W; x++) if (alpha[o + x] > 128) { xl[y] = x; break; }
      if (xl[y] < 0) continue;
      for (x = W - 1; x >= 0; x--) if (alpha[o + x] > 128) { xr[y] = x; break; }
    }
    var rows = [];
    for (y = 0; y < H; y++) if (xl[y] >= 0) rows.push(y);
    if (rows.length < 20) return null;
    var widths = rows.map(function (r) { return xr[r] - xl[r]; }).sort(function (a, b) { return a - b; });
    var full = widths[Math.floor(widths.length * 0.75)];
    if (full < fw * 1.6) return null;   // not a torso: too narrow
    // shoulder line: first row (below the face centre) whose width reaches 85% of the body width
    var ys = -1;
    for (i = 0; i < rows.length; i++) { y = rows[i]; if (y > FACE.cy && xr[y] - xl[y] >= full * 0.85) { ys = y; break; } }
    if (ys < 0) return null;
    var ye = rows[rows.length - 1];
    if (ye - ys < fw * 0.8) return null;
    // luminance edges (alpha-weighted so transparent pixels count as dark)
    var img = layer.imageData, lw = img.width, lh = img.height, lx = layer.left | 0, ly = layer.top | 0, d = img.data;
    var lum = new Float32Array(W * H);
    for (y = 0; y < lh; y++) { var cy = y + ly; if (cy < 0 || cy >= H) continue;
      for (x = 0; x < lw; x++) { var cx = x + lx; if (cx < 0 || cx >= W) continue;
        var q = (y * lw + x) * 4; lum[cy * W + cx] = (0.3 * d[q] + 0.59 * d[q + 1] + 0.11 * d[q + 2]) * d[q + 3] / 255; } }
    var grad = function (px, py) {
      if (px < 1 || py < 1 || px >= W - 1 || py >= H - 1) return 0;
      var k = py * W + px;
      var gx = (lum[k - W + 1] + 2 * lum[k + 1] + lum[k + W + 1]) - (lum[k - W - 1] + 2 * lum[k - 1] + lum[k + W - 1]);
      return Math.abs(gx) / 1020;
    };
    // anime upper arms are ~0.2-0.5 face widths wide; edges saturate so a dark fold
    // line counts as much as a high-contrast lapel further in
    var lo = Math.round(fw * 0.16), hi = Math.round(fw * 0.5), mid = Math.round(fw * 0.32), nb = hi - lo + 1;
    function seam(side) {   // side -1 = image-left arm, +1 = right
      var n = ye - ys + 1, cost = new Float32Array(n * nb), from = new Int8Array(n * nb);
      for (var r = 0; r < n; r++) {
        var yy = ys + r, edge = side < 0 ? xl[yy] : xr[yy];
        for (var b = 0; b < nb; b++) {
          var px = edge - side * (lo + b);
          var c = -Math.min(1, grad(px, yy) / 0.12) + Math.abs(lo + b - mid) / fw * 1.2;
          if (alpha[yy * W + px] <= 128) c += 1;   // stay inside the body
          if (r === 0) { cost[b] = c; continue; }
          var best = Infinity, bi = 0;
          for (var dd = -2; dd <= 2; dd++) { var pb = b + dd; if (pb < 0 || pb >= nb) continue; var v = cost[(r - 1) * nb + pb] + Math.abs(dd) * 0.3; if (v < best) { best = v; bi = dd; } }
          cost[r * nb + b] = best + c; from[r * nb + b] = bi;
        }
      }
      var bb = 0, bc = Infinity;
      for (var b2 = 0; b2 < nb; b2++) if (cost[(n - 1) * nb + b2] < bc) { bc = cost[(n - 1) * nb + b2]; bb = b2; }
      var off = new Int32Array(n);
      for (var r2 = n - 1; r2 >= 0; r2--) { off[r2] = lo + bb; if (r2) bb += from[r2 * nb + bb]; }
      return off;   // inset from the silhouette edge, per row
    }
    var sl = seam(-1), sr = seam(1);
    var ml = new Uint8Array(W * H), mr = new Uint8Array(W * H), torso = new Uint8Array(W * H);
    var rgba = new Uint8ClampedArray(W * H * 4);
    for (y = 0; y < lh; y++) { var cy2 = y + ly; if (cy2 < 0 || cy2 >= H) continue;
      for (x = 0; x < lw; x++) { var cx2 = x + lx; if (cx2 < 0 || cx2 >= W) continue; var s = (y * lw + x) * 4, t = (cy2 * W + cx2) * 4;
        rgba[t] = d[s]; rgba[t + 1] = d[s + 1]; rgba[t + 2] = d[s + 2]; rgba[t + 3] = alpha[cy2 * W + cx2]; } }
    var torsoAlpha = new Uint8Array(alpha);
    var nl = 0, nr = 0, n = ye - ys + 1;
    // Fill width and colour per row, smoothed over neighbouring rows so the
    // filled side of the torso has a clean edge instead of row streaks.
    function sideFill(side, off) {
      var wRaw = new Float32Array(n), col = new Float32Array(n * 3), ok = new Uint8Array(n);
      for (var r = 0; r < n; r++) {
        var yy = ys + r; if (xl[yy] < 0) continue;
        var cut = side < 0 ? xl[yy] + off[r] : xr[yy] - off[r], cnt = 0, c0 = 0, c1 = 0, c2 = 0;
        for (var k = 3; k <= 8; k++) { var sx = cut - side * k; if (sx < 0 || sx >= W || alpha[yy * W + sx] <= 128) continue; var q = (yy * W + sx) * 4; c0 += rgba[q]; c1 += rgba[q + 1]; c2 += rgba[q + 2]; cnt++; }
        if (!cnt) continue;
        ok[r] = 1; wRaw[r] = off[r] * 0.45; col[r * 3] = c0 / cnt; col[r * 3 + 1] = c1 / cnt; col[r * 3 + 2] = c2 / cnt;
      }
      var R = Math.max(4, Math.round(fw * 0.04)), wS = new Float32Array(n), cS = new Float32Array(n * 3);
      for (var r2 = 0; r2 < n; r2++) {
        var sw = 0, s0 = 0, s1 = 0, s2 = 0, sn = 0;
        for (var j = Math.max(0, r2 - R); j <= Math.min(n - 1, r2 + R); j++) if (ok[j]) { sw += wRaw[j]; s0 += col[j * 3]; s1 += col[j * 3 + 1]; s2 += col[j * 3 + 2]; sn++; }
        if (sn) { wS[r2] = sw / sn; cS[r2 * 3] = s0 / sn; cS[r2 * 3 + 1] = s1 / sn; cS[r2 * 3 + 2] = s2 / sn; }
      }
      return { w: wS, c: cS, ok: ok };
    }
    var fillL = sideFill(-1, sl), fillR = sideFill(1, sr);
    for (y = ys; y <= ye; y++) {
      if (xl[y] < 0) continue;
      var r3 = y - ys, cutL = xl[y] + sl[r3], cutR = xr[y] - sr[r3];
      if (cutL >= cutR) continue;
      for (x = 0; x < W; x++) {
        var k2 = y * W + x;
        if (!alpha[k2]) continue;
        if (x < cutL) { ml[k2] = 1; nl++; torsoAlpha[k2] = 0; }
        else if (x > cutR) { mr[k2] = 1; nr++; torsoAlpha[k2] = 0; }
      }
      // torso side behind each arm, shaded slightly darker (it is in the arm's shadow)
      [[cutL, -1, fillL], [cutR, 1, fillR]].forEach(function (c) {
        var F = c[2], fill = F.w[r3]; if (!(fill > 1)) return;
        for (var f = 0; f <= Math.ceil(fill) + 1; f++) {
          var fx = c[0] + c[1] * f; if (fx < 0 || fx >= W) break;
          var kk = y * W + fx, t = f / fill, a = Math.round(255 * Math.max(0, Math.min(1, (1 - t) / 0.3)));
          if (a > torsoAlpha[kk]) { torsoAlpha[kk] = a; var sh = 0.85; rgba[kk * 4] = F.c[r3 * 3] * sh; rgba[kk * 4 + 1] = F.c[r3 * 3 + 1] * sh; rgba[kk * 4 + 2] = F.c[r3 * 3 + 2] * sh; }
        }
      });
    }
    var minArea = fw * fw * 0.25;
    if (nl < minArea || nr < minArea) return null;
    for (i = 0; i < W * H; i++) rgba[i * 4 + 3] = torsoAlpha[i];
    return { l: ml, r: mr, torsoAlpha: torsoAlpha,
             torsoLayer: { name: layer.name, opacity: layer.opacity, left: 0, top: 0, imageData: { width: W, height: H, data: rgba } } };
  }

  // Shoulder / elbow / wrist of one arm from its alpha mask.
  //  - main axis by PCA, centerline from slices across it
  //  - shoulder: the end nearest the neck, half an arm width inside
  //  - elbow: the bend if the arm is visibly bent, otherwise one upper-arm
  //    length (1.25 face heights) down the centerline
  //  - wrist: the far end; if the arm runs off the canvas (cut) it is
  //    extrapolated one forearm length past the elbow
  function detectArm(alpha, W, H, FACE, neck) {
    var n = 0, mx = 0, my = 0, x, y, i;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) if (alpha[y * W + x] > 128) { n++; mx += x; my += y; }
    if (n < 200) return null;
    mx /= n; my /= n;
    var sxx = 0, syy = 0, sxy = 0;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) if (alpha[y * W + x] > 128) { var dx = x - mx, dy = y - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    var th = 0.5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(th), uy = Math.sin(th);
    var tmin = Infinity, tmax = -Infinity;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) if (alpha[y * W + x] > 128) { var t0 = (x - mx) * ux + (y - my) * uy; if (t0 < tmin) tmin = t0; if (t0 > tmax) tmax = t0; }
    // orient the axis from the shoulder end (nearest the neck) outward
    var pA = { x: mx + ux * tmin, y: my + uy * tmin }, pB = { x: mx + ux * tmax, y: my + uy * tmax };
    if (Math.hypot(pB.x - neck.cx, pB.y - neck.cy) < Math.hypot(pA.x - neck.cx, pA.y - neck.cy)) { ux = -ux; uy = -uy; var tt = tmin; tmin = -tmax; tmax = -tt; }
    var len = Math.max(1, tmax - tmin), NB = Math.max(8, Math.min(80, Math.round(len / 12)));
    var cnt = new Float64Array(NB), sx = new Float64Array(NB), sy = new Float64Array(NB), vmin = [], vmax = [];
    for (i = 0; i < NB; i++) { vmin.push(Infinity); vmax.push(-Infinity); }
    var cut = false;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      if (alpha[y * W + x] <= 128) continue;
      var t = (x - mx) * ux + (y - my) * uy, v = -(x - mx) * uy + (y - my) * ux;
      var b = Math.min(NB - 1, Math.max(0, Math.floor((t - tmin) / len * NB)));
      cnt[b]++; sx[b] += x; sy[b] += y; if (v < vmin[b]) vmin[b] = v; if (v > vmax[b]) vmax[b] = v;
      if (b >= NB - 2 && (x <= 1 || y <= 1 || x >= W - 2 || y >= H - 2)) cut = true;
    }
    var pts = [], widths = [];
    for (i = 0; i < NB; i++) if (cnt[i] > 0) { pts.push({ x: sx[i] / cnt[i], y: sy[i] / cnt[i] }); widths.push(vmax[i] - vmin[i]); }
    if (pts.length < 4) return null;
    var ws = widths.slice().sort(function (a, c) { return a - c; }), width = ws[ws.length >> 1];
    var arc = [0];
    for (i = 1; i < pts.length; i++) arc.push(arc[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    function at(s) {
      s = Math.max(0, Math.min(arc[arc.length - 1], s));
      for (var k = 1; k < arc.length; k++) if (arc[k] >= s) {
        var f = (s - arc[k - 1]) / Math.max(1e-6, arc[k] - arc[k - 1]);
        return { x: pts[k - 1].x + (pts[k].x - pts[k - 1].x) * f, y: pts[k - 1].y + (pts[k].y - pts[k - 1].y) * f };
      }
      return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };
    }
    var total = arc[arc.length - 1], s0 = Math.min(width * 0.5, total * 0.15);
    var S = at(s0), End = pts[pts.length - 1];
    var faceH = Math.max(1, FACE.y1 - FACE.y0), upper = faceH * 1.25;
    // visible bend: largest distance from the shoulder-to-end chord
    var cx = End.x - S.x, cy = End.y - S.y, cl = Math.max(1, Math.hypot(cx, cy)), best = 0, bestK = -1;
    for (i = 0; i < pts.length; i++) {
      if (arc[i] < s0 + (total - s0) * 0.25 || arc[i] > s0 + (total - s0) * 0.85) continue;
      var dev = Math.abs((pts[i].x - S.x) * cy - (pts[i].y - S.y) * cx) / cl;
      if (dev > best) { best = dev; bestK = i; }
    }
    var E, method;
    if (bestK >= 0 && best > Math.max(width * 0.35, cl * 0.1)) { E = { x: pts[bestK].x, y: pts[bestK].y }; method = 'bend'; }
    else { E = at(s0 + Math.min(upper, (total - s0) * 0.8)); method = 'ratio'; }
    var L1 = Math.hypot(E.x - S.x, E.y - S.y), Wr;
    if (cut) {
      var fx = End.x - E.x, fy = End.y - E.y, fl = Math.max(1e-6, Math.hypot(fx, fy)), fore = Math.max(fl, L1 * 0.9);
      Wr = { x: E.x + fx / fl * fore, y: E.y + fy / fl * fore };
    } else Wr = { x: End.x, y: End.y };
    var r1 = function (p) { return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }; };
    return { shoulder: r1(S), elbow: r1(E), wrist: r1(Wr), width: Math.round(width), cut: cut, elbowBy: method };
  }

  // ---------- hair locks (capsule) ----------
  // see-through gives one bangs layer and one back hair layer. Cut each into locks so every lock is its
  // own layer with its own springs: cut positions are the gaps between lock tips (dips of the lowest hair
  // row), and each cut follows the darkest line of the painting (the shadow between two locks) from the
  // top of the layer down. Neighbouring pieces share 2 px along the cut, so at rest no seam shows.
  // Returns one mask (Uint8Array, 1 = in this piece) per lock, left to right, or null (nothing to cut).
  function splitHairLocks(alpha, layer, W, H, n) {
    var b = bboxOf(alpha, W, H, 16);
    if (!b || n < 2) return null;
    var w = b.x1 - b.x0 + 1, x, y;
    var bottom = new Float32Array(w), cnt = new Float32Array(w);
    for (x = 0; x < w; x++) {
      bottom[x] = -1;
      for (y = b.y1; y >= b.y0; y--) if (alpha[y * W + x + b.x0] > 16) { bottom[x] = y; break; }
      for (y = b.y0; y <= b.y1; y++) if (alpha[y * W + x + b.x0] > 16) cnt[x]++;
    }
    // smoothed "how far down does the hair reach" profile; dips = gaps between locks
    var k = Math.max(3, Math.round(w / 60)), sm = new Float32Array(w);
    for (x = 0; x < w; x++) { var su = 0, sn = 0; for (var d = -k; d <= k; d++) { var xx = x + d; if (xx >= 0 && xx < w && bottom[xx] >= 0) { su += bottom[xx]; sn++; } } sm[x] = sn ? su / sn : -1; }
    var minSep = Math.round(w / (n + 1) * 0.6), edge = Math.round(w * 0.06), cands = [];
    for (x = edge; x < w - edge; x++) {
      if (sm[x] < 0) continue;
      var isMin = true;
      for (var d2 = -minSep >> 1; d2 <= minSep >> 1 && isMin; d2++) { var x2 = x + d2; if (d2 && x2 >= 0 && x2 < w && sm[x2] >= 0 && sm[x2] < sm[x]) isMin = false; }
      if (isMin) {
        var lm = -1, rm = -1;   // prominence: how much lower the hair reaches on both sides
        for (var dl = 1; dl <= minSep && x - dl >= 0; dl++) lm = Math.max(lm, sm[x - dl]);
        for (var dr = 1; dr <= minSep && x + dr < w; dr++) rm = Math.max(rm, sm[x + dr]);
        cands.push({ x: x, prom: Math.min(lm, rm) - sm[x] });
      }
    }
    cands.sort(function (u, v) { return v.prom - u.prom; });
    var cuts = [], rows0 = b.y1 - b.y0 + 1;
    for (var c = 0; c < cands.length && cuts.length < n - 1; c++) {
      if (cands[c].prom < rows0 * 0.04) break;   // not a clear gap between locks
      if (cuts.every(function (q) { return Math.abs(q - cands[c].x) >= minSep; })) cuts.push(cands[c].x);
    }
    // then halve the widest piece until there are n (its cut still follows the darkest line nearby)
    while (cuts.length < n - 1) {
      var edges = [0].concat(cuts.slice().sort(function (u, v) { return u - v; }), [w - 1]), bi0 = -1, bw0 = 0;
      for (var e2 = 0; e2 < edges.length - 1; e2++) if (edges[e2 + 1] - edges[e2] > bw0) { bw0 = edges[e2 + 1] - edges[e2]; bi0 = e2; }
      if (bw0 < 2 * minSep) break;
      cuts.push(Math.round((edges[bi0] + edges[bi0 + 1]) / 2));
    }
    cuts.sort(function (u, v) { return u - v; });
    if (!cuts.length) return null;
    // each cut: a min-cost path from the top row to the bottom row, one column step per row at most,
    // through dark painted pixels (cheap), staying near its start column
    var band = Math.max(4, Math.round(minSep * 0.45)), rows = b.y1 - b.y0 + 1;
    var paths = cuts.map(function (cx) {
      var x0 = Math.max(0, cx - band), x1 = Math.min(w - 1, cx + band), bw = x1 - x0 + 1;
      var cost = new Float32Array(rows * bw), from = new Int8Array(rows * bw);
      for (var r = 0; r < rows; r++) for (var i = 0; i < bw; i++) {
        var X = x0 + i + b.x0, Y = r + b.y0, a = alpha[Y * W + X], own = 0;
        if (a > 16) { var px = layerPixel(layer, X, Y); own = px ? (px[0] + px[1] + px[2]) / 765 : 1; }
        own += 0.2 * Math.abs(x0 + i - cx) / band;   // stay near the gap
        if (!r) { cost[i] = own; continue; }
        var best = Infinity, bi = 0;
        for (var dd = -1; dd <= 1; dd++) { var j = i + dd; if (j < 0 || j >= bw) continue; var cc = cost[(r - 1) * bw + j]; if (cc < best) { best = cc; bi = dd; } }
        cost[r * bw + i] = best + own; from[r * bw + i] = bi;
      }
      var bi2 = 0, bc = Infinity;
      for (var i2 = 0; i2 < bw; i2++) if (cost[(rows - 1) * bw + i2] < bc) { bc = cost[(rows - 1) * bw + i2]; bi2 = i2; }
      var path = new Int32Array(rows);
      for (var r2 = rows - 1; r2 >= 0; r2--) { path[r2] = x0 + bi2 + b.x0; bi2 += from[r2 * bw + bi2]; }
      return path;
    });
    var masks = [];
    for (var p = 0; p <= paths.length; p++) masks.push(new Uint8Array(W * H));
    for (y = b.y0; y <= b.y1; y++) {
      var r3 = y - b.y0;
      for (x = b.x0; x <= b.x1; x++) {
        var q = y * W + x; if (alpha[q] <= 0) continue;
        var piece = 0;
        for (var s2 = 0; s2 < paths.length; s2++) if (x >= paths[s2][r3]) piece = s2 + 1;
        masks[piece][q] = 1;
        // 2 px shared along each cut: no seam at rest
        if (piece > 0 && x - paths[piece - 1][r3] < 2) masks[piece - 1][q] = 1;
        if (piece < paths.length && paths[piece][r3] - x <= 2) masks[piece + 1][q] = 1;
      }
    }
    // drop slivers (merge into the neighbour on the left / right)
    var area = function (m) { var a = 0; for (var i3 = 0; i3 < m.length; i3++) if (m[i3] && alpha[i3] > 16) a++; return a; };
    var total = area(masks.reduce(function (acc, m) { for (var i4 = 0; i4 < m.length; i4++) if (m[i4]) acc[i4] = 1; return acc; }, new Uint8Array(W * H)));
    for (var m2 = masks.length - 1; m2 >= 0 && masks.length > 1; m2--) {
      if (area(masks[m2]) >= total * 0.04) continue;
      var into = m2 > 0 ? m2 - 1 : 1;
      for (var i5 = 0; i5 < masks[m2].length; i5++) if (masks[m2][i5]) masks[into][i5] = 1;
      masks.splice(m2, 1);
    }
    return masks.length > 1 ? masks : null;
  }

  // ---------- part record ----------
  // mask: optional Uint8 side mask multiplied onto alpha
  function makePart(name, layer, fullAlpha, mask, W, H, slot, z, side, strands) {
    var eff = fullAlpha;
    if (mask) {
      eff = new Uint8Array(W * H);
      for (var i = 0; i < W * H; i++) eff[i] = mask[i] ? fullAlpha[i] : 0;
    }
    var bb = bboxOf(eff, W, H, 8);
    if (!bb) return null;
    var pad = 2;
    var x0 = Math.max(0, bb.x0 - pad), y0 = Math.max(0, bb.y0 - pad);
    var x1 = Math.min(W, bb.x1 + 1 + pad), y1 = Math.min(H, bb.y1 + 1 + pad);
    var w = x1 - x0, h = y1 - y0;
    var data = new Uint8ClampedArray(w * h * 4);
    var img = layer.imageData, lw = img.width, lh = img.height;
    var lx = layer.left | 0, ly = layer.top | 0, ld = img.data;
    for (var y = y0; y < y1; y++) {
      for (var x = x0; x < x1; x++) {
        var di = ((y - y0) * w + (x - x0)) * 4;
        var yy = y - ly, xx = x - lx;
        if (yy >= 0 && yy < lh && xx >= 0 && xx < lw) {
          var li = (yy * lw + xx) * 4;
          data[di] = ld[li]; data[di + 1] = ld[li + 1]; data[di + 2] = ld[li + 2];
        }
        data[di + 3] = eff[y * W + x];
      }
    }
    var rec = {
      name: name, source: String(layer.name == null ? '' : layer.name), x: x0, y: y0, w: w, h: h, z: z,
      depth: slot.depth, group: slot.group, phys: slot.phys || null,
      opacity: layer.opacity == null ? 1 : Math.max(0, Math.min(1, layer.opacity)),
      fade: slot.fade || null, side: side || null, strands: strands || null,
      img: { width: w, height: h, data: data }
    };
    if (slot.fx) rec.fx = slot.fx;
    return rec;
  }

  // ---------- effect layers (capsule) ----------
  // Small procedural paintings placed from the face / eye anchors: blush,
  // tears, sweat drop, anger mark, gloom lines. Signed distance shapes with a
  // one-pixel anti-aliased edge, composited "over" in straight alpha.
  function Painter(x0, y0, x1, y1) {
    x0 = Math.floor(x0); y0 = Math.floor(y0);
    var w = Math.max(2, Math.ceil(x1) - x0), h = Math.max(2, Math.ceil(y1) - y0);
    this.x = x0; this.y = y0; this.w = w; this.h = h; this.data = new Uint8ClampedArray(w * h * 4);
  }
  // sdf(x, y) in canvas pixels (< 0 inside); alpha(x, y) optional 0..1 multiplier
  Painter.prototype.fill = function (sdf, rgb, opacity, alpha, bbox) {
    var d = this.data, W = this.w, H = this.h;
    var bx0 = 0, by0 = 0, bx1 = W, by1 = H;
    if (bbox) {
      bx0 = Math.max(0, Math.floor(bbox[0] - this.x)); by0 = Math.max(0, Math.floor(bbox[1] - this.y));
      bx1 = Math.min(W, Math.ceil(bbox[2] - this.x) + 1); by1 = Math.min(H, Math.ceil(bbox[3] - this.y) + 1);
    }
    for (var py = by0; py < by1; py++) for (var px = bx0; px < bx1; px++) {
      var X = this.x + px + 0.5, Y = this.y + py + 0.5, s = sdf(X, Y);
      if (s >= 0.5) continue;
      var a = Math.min(1, 0.5 - s) * opacity * (alpha ? alpha(X, Y) : 1);
      if (a <= 0) continue;
      var o = (py * W + px) * 4, da = d[o + 3] / 255, oa = a + da * (1 - a);
      for (var k = 0; k < 3; k++) d[o + k] = (rgb[k] * a + d[o + k] * da * (1 - a)) / oa;
      d[o + 3] = oa * 255;
    }
  };
  Painter.prototype.part = function (slotName) {
    var slot = SLOTS[slotName];
    var t = trimImg({ width: this.w, height: this.h, data: this.data }, 2);
    if (!t) return null;
    // trimImg crops; find the crop offset again
    var W = this.w, H = this.h, d = this.data, ox = W, oy = H;
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 2) { if (x < ox) ox = x; if (y < oy) oy = y; }
    return { name: slotName, source: '', x: this.x + ox, y: this.y + oy, w: t.width, h: t.height, z: 0,
             depth: slot.depth, group: slot.group, phys: null, opacity: 1, fade: slot.fade || 'fx', fx: slot.fx,
             side: null, strands: null, synthetic: true, img: t };
  };
  function sdSeg(px, py, ax, ay, bx, by, r) {
    var vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
    var t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / Math.max(1e-9, vx * vx + vy * vy)));
    return Math.hypot(wx - vx * t, wy - vy * t) - r;
  }
  function sdEllipse(px, py, cx, cy, rx, ry) {
    var k = Math.hypot((px - cx) / rx, (py - cy) / ry);
    return (k - 1) * Math.min(rx, ry);
  }
  // arc of radius R around (cx, cy) between angles a0..a1 (a0 < a1), stroke width th
  function sdArc(px, py, cx, cy, R, a0, a1, th) {
    var a = Math.atan2(py - cy, px - cx), mid = (a0 + a1) / 2, half = (a1 - a0) / 2;
    var da = Math.atan2(Math.sin(a - mid), Math.cos(a - mid));
    if (Math.abs(da) <= half) return Math.abs(Math.hypot(px - cx, py - cy) - R) - th / 2;
    var e = da > 0 ? a1 : a0, ex = cx + Math.cos(e) * R, ey = cy + Math.sin(e) * R;
    return Math.hypot(px - ex, py - ey) - th / 2;
  }
  // drop: round bottom of radius r at (cx, cy), pointed tip `len` above it
  function sdDrop(px, py, cx, cy, r, len) {
    if (py >= cy) return Math.hypot(px - cx, py - cy) - r;
    var tip = cy - len;
    if (py <= tip) return Math.hypot(px - cx, py - tip);
    var t = (py - tip) / len, half = r * Math.pow(t, 0.75);
    return Math.max(Math.abs(px - cx) - half, Math.hypot(px - cx, py - cy) - r - len);
  }

  var FX_COLORS = {
    blush: [255, 128, 150], hatch: [236, 84, 112], tear: [150, 205, 255], tearEdge: [80, 150, 225], white: [255, 255, 255],
    sweat: [176, 222, 255], sweatEdge: [74, 140, 214], anger: [226, 38, 52], gloom: [86, 74, 150]
  };

  // Skin-coloured upper eyelid for one eye (capsule): the eye opening (white + iris) filled with
  // the face colour around the eye, a little darker toward its lower edge. The engine unrolls it
  // downward as the eye closes and moves the character's own upper lashes along its edge.
  function synthLid(side, opening, faceEntries, avoid, W, H) {
    var b = bboxOf(opening, W, H, 32);
    if (!b) return null;
    var ew = b.x1 - b.x0 + 1, eh = b.y1 - b.y0 + 1, pad = Math.max(2, Math.round(eh * 0.12));
    // face colour: median of face pixels in a ring around the opening, outside lashes / brows
    var ring = Math.max(3, Math.round(eh * 0.3)), rs = [], gs = [], bs = [];
    for (var y = Math.max(0, b.y0 - ring); y <= Math.min(H - 1, b.y1 + ring); y++) {
      for (var x = Math.max(0, b.x0 - ring); x <= Math.min(W - 1, b.x1 + ring); x++) {
        var k = y * W + x;
        if (opening[k] > 16 || avoid[k] > 16) continue;
        for (var f = 0; f < faceEntries.length; f++) {
          var L = faceEntries[f].layer, lx = x - (L.left | 0), ly = y - (L.top | 0), img = L.imageData;
          if (lx < 0 || ly < 0 || lx >= img.width || ly >= img.height) continue;
          var q = (ly * img.width + lx) * 4;
          if (img.data[q + 3] > 200) { rs.push(img.data[q]); gs.push(img.data[q + 1]); bs.push(img.data[q + 2]); break; }
        }
      }
    }
    if (rs.length < 10) return null;
    var med = function (a) { a.sort(function (u, v) { return u - v; }); return a[a.length >> 1]; };
    var col = [med(rs), med(gs), med(bs)];
    var faceAt = function (x, y) {
      for (var f = 0; f < faceEntries.length; f++) {
        var L = faceEntries[f].layer, lx = x - (L.left | 0), ly = y - (L.top | 0), img = L.imageData;
        if (lx < 0 || ly < 0 || lx >= img.width || ly >= img.height) continue;
        var q = (ly * img.width + lx) * 4;
        if (img.data[q + 3] > 200) {
          var c = [img.data[q], img.data[q + 1], img.data[q + 2]];
          // only skin-like colours (not a dark line left in the face layer)
          return (c[0] + c[1] + c[2]) > (col[0] + col[1] + col[2]) * 0.8 ? c : null;
        }
      }
      return null;
    };
    var x0 = Math.max(0, b.x0 - pad), y0 = Math.max(0, b.y0 - pad), x1 = Math.min(W, b.x1 + 1 + pad), y1 = Math.min(H, b.y1 + 1 + pad);
    var w = x1 - x0, h = y1 - y0, data = new Uint8ClampedArray(w * h * 4), grown = dilate(opening, W, H, pad);
    for (var yy = 0; yy < h; yy++) for (var xx = 0; xx < w; xx++) {
      var kk = (yy + y0) * W + xx + x0, o = (yy * w + xx) * 4;
      if (!grown[kk]) continue;
      data[o] = col[0]; data[o + 1] = col[1]; data[o + 2] = col[2]; data[o + 3] = 255;
      var fc = faceAt(xx + x0, yy + y0);   // the face layer under the eye is skin (blush included): use it
      if (fc) { data[o] = fc[0]; data[o + 1] = fc[1]; data[o + 2] = fc[2]; }
    }
    // soft sides: a 2-pass box blur of the alpha so the lid never shows as a box
    for (var pass = 0; pass < 2; pass++) {
      var al = new Uint8ClampedArray(w * h);
      for (var y2 = 0; y2 < h; y2++) for (var x2 = 0; x2 < w; x2++) {
        var sum = 0, n = 0;
        for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
          var X = x2 + dx, Y = y2 + dy; n++;
          if (X >= 0 && Y >= 0 && X < w && Y < h) sum += data[(Y * w + X) * 4 + 3];
        }
        al[y2 * w + x2] = sum / n;
      }
      for (var i2 = 0; i2 < w * h; i2++) {
        if (al[i2] && !data[i2 * 4 + 3]) { var fc2 = faceAt(i2 % w + x0, ((i2 / w) | 0) + y0) || col; data[i2 * 4] = fc2[0]; data[i2 * 4 + 1] = fc2[1]; data[i2 * 4 + 2] = fc2[2]; }
        data[i2 * 4 + 3] = al[i2];
      }
    }
    return { name: 'eye_lid_' + side.toLowerCase(), source: '', x: x0, y: y0, w: w, h: h, z: 0, depth: SLOTS.eye_lid.depth, group: 'head',
             phys: null, opacity: 1, fade: 'eyeLid', side: side, strands: null, synthetic: true, img: { width: w, height: h, data: data } };
  }

  // Cut the double-eyelid crease out of an upper lash layer. Per column, walking up from the top of
  // the eye opening: skip clear pixels, the first opaque run is the lash band, anything opaque above
  // a clear gap is the crease. Returns the crease part (pixels removed from the lash) or null.
  function splitCrease(lash, opening, W, H) {
    var img = lash.img, w = img.width, h = img.height, d = img.data, T = 60;
    var tops = new Int32Array(w).fill(-1), any = false;
    for (var x = 0; x < w; x++) {
      var cx = x + lash.x;
      if (cx < 0 || cx >= W) continue;
      for (var y = 0; y < H; y++) if (opening[y * W + cx] > 16) { tops[x] = y - lash.y; any = true; break; }
    }
    if (!any) return null;
    // columns past the eye corners: use the nearest column's top
    var last = -1;
    for (x = 0; x < w; x++) { if (tops[x] >= 0) last = tops[x]; else if (last >= 0) tops[x] = last; }
    last = -1;
    for (x = w - 1; x >= 0; x--) { if (tops[x] >= 0) last = tops[x]; else if (last >= 0 && tops[x] < 0) tops[x] = last; }
    var out = new Uint8ClampedArray(w * h * 4), moved = 0, total = 0;
    for (x = 0; x < w; x++) {
      var y0 = Math.min(h - 1, tops[x] + 2), state = 0, clear = 0, gapAt = -1;   // 0 before band, 1 band, 2 after a real gap
      for (y = y0; y >= 0; y--) {
        var o = (y * w + x) * 4, a = d[o + 3];
        if (a) total++;
        if (state === 0) { if (a >= 40) state = 1; else if (y < tops[x] - h * 0.5) break; continue; }
        if (state === 1) {
          // a gap is at least 2 truly clear rows (light streaks inside the band are not a gap)
          if (a < 12) { if (++clear >= 2) { state = 2; gapAt = y + clear - 1; } } else clear = 0;
          continue;
        }
      }
      if (state !== 2) continue;
      for (y = gapAt; y >= 0; y--) {
        var o2 = (y * w + x) * 4;
        if (!d[o2 + 3]) continue;
        out[o2] = d[o2]; out[o2 + 1] = d[o2 + 1]; out[o2 + 2] = d[o2 + 2]; out[o2 + 3] = d[o2 + 3];
        d[o2 + 3] = 0; moved++;
      }
    }
    // nothing worth a layer, or it swallowed most of the lash (no clear band / crease split): undo
    if (moved < 12 || moved > total * 0.45) {
      for (var i = 0; i < w * h; i++) if (out[i * 4 + 3]) d[i * 4 + 3] = out[i * 4 + 3];
      return null;
    }
    var rec = Object.assign({}, lash, { name: lash.name.replace(/^eyelash/, 'eyelash_crease'), synthetic: true,
      img: { width: w, height: h, data: out } });
    rec.source = lash.source;
    return rec;
  }

  // Per column of the eye opening: its top and bottom (canvas y), extended past the eye corners
  // from the nearest column. -> { top, bot } Int32Arrays over the part's columns, or null
  function openingRows(part, opening, W, H) {
    var w = part.img.width, top = new Int32Array(w).fill(-1), bot = new Int32Array(w).fill(-1), inside = new Uint8Array(w), any = false;
    for (var x = 0; x < w; x++) {
      var cx = x + part.x;
      if (cx < 0 || cx >= W) continue;
      for (var y = 0; y < H; y++) if (opening[y * W + cx] > 16) { if (top[x] < 0) top[x] = y; bot[x] = y; any = true; inside[x] = 1; }
    }
    if (!any) return null;
    [top, bot].forEach(function (arr) {
      var last = -1, x2;
      for (x2 = 0; x2 < w; x2++) { if (arr[x2] >= 0) last = arr[x2]; else if (last >= 0) arr[x2] = last; }
      last = -1;
      for (x2 = w - 1; x2 >= 0; x2--) { if (arr[x2] >= 0) last = arr[x2]; else if (last >= 0 && arr[x2] < 0) arr[x2] = last; }
    });
    return { top: top, bot: bot, inside: inside };
  }

  // Cut the lower lashes (below the middle of the eye opening) out of a lash layer into their own
  // part: they rise to meet the upper lashes in a smile. Returns the lower part or null.
  function splitLowerLash(lash, opening, W, H) {
    var rows = openingRows(lash, opening, W, H);
    if (!rows) return null;
    var img = lash.img, w = img.width, h = img.height, d = img.data, out = new Uint8ClampedArray(w * h * 4), moved = 0, total = 0;
    // past the eye corners there is no "middle": use the line through the two corners instead
    // (an upper lash's outer flick sits above it, lower lash tails below)
    var c0 = -1, c1 = -1;
    for (var xc = 0; xc < w; xc++) if (rows.inside[xc]) { if (c0 < 0) c0 = xc; c1 = xc; }
    if (c0 < 0) return null;
    var y0c = (rows.top[c0] + rows.bot[c0]) / 2, y1c = (rows.top[c1] + rows.bot[c1]) / 2;
    var thick = 0, nThick = 0, openH = 0;
    for (var x = 0; x < w; x++) {
      var mid = rows.inside[x] ? (rows.top[x] + rows.bot[x]) / 2 - lash.y
        : y0c + (y1c - y0c) * (x - c0) / Math.max(1, c1 - c0) - lash.y;
      if (rows.inside[x] && x > c0 + (c1 - c0) * 0.25 && x < c1 - (c1 - c0) * 0.25) {
        var t = 0;
        for (var yt = 0; yt < Math.min(h, mid); yt++) if (d[(yt * w + x) * 4 + 3] >= 60) t++;
        thick += t; openH += rows.bot[x] - rows.top[x] + 1; nThick++;
      }
      for (var y = 0; y < h; y++) {
        var o = (y * w + x) * 4;
        if (!d[o + 3]) continue;
        total++;
        if (y > mid) { out[o] = d[o]; out[o + 1] = d[o + 1]; out[o + 2] = d[o + 2]; out[o + 3] = d[o + 3]; d[o + 3] = 0; moved++; }
      }
    }
    // how much to thin the upper band when it closes: a closed eye ends ~18% of the eye height thick
    if (nThick && thick) lash.lashSquash = Math.round(Math.max(0.3, Math.min(0.75, 1 - 0.18 * openH / thick)) * 100) / 100;
    if (moved < 8 || moved > total * 0.6) {   // no lower lashes drawn, or the split went wrong: undo
      for (var i = 0; i < w * h; i++) if (out[i * 4 + 3]) d[i * 4 + 3] = out[i * 4 + 3];
      return null;
    }
    return Object.assign({}, lash, { name: lash.name.replace(/^eyelash/, 'eyelash_lower'), synthetic: true, img: { width: w, height: h, data: out } });
  }

  function synthEffects(anchors, have) {
    var F = anchors.face, fw = Math.max(20, F.x1 - F.x0), fh = Math.max(20, F.y1 - F.y0), C = FX_COLORS, out = {};
    var eyes = ['eyeL', 'eyeR'].map(function (k, i) {
      var e = anchors[k];
      if (e) return e;
      var cx = F.cx + (i ? 1 : -1) * fw * 0.22, cy = F.y0 + fh * 0.5;
      return { x0: cx - fw * 0.11, x1: cx + fw * 0.11, y0: cy - fw * 0.06, y1: cy + fw * 0.06, icx: cx, icy: cy, closeY: cy };
    });
    if (!have.fx_blush) {
      var P = new Painter(F.x0, F.y0, F.x1, F.y1 + fh * 0.2);
      eyes.forEach(function (e, i) {
        var dir = i ? 1 : -1, ew = e.x1 - e.x0;
        var cx = (e.x0 + e.x1) / 2 + dir * ew * 0.12, cy = e.y1 + fw * 0.07, rx = fw * 0.13, ry = fw * 0.055;
        P.fill(function (x, y) { return sdEllipse(x, y, cx, cy, rx, ry); }, C.blush, 0.55,
          function (x, y) { var k = Math.hypot((x - cx) / rx, (y - cy) / ry); return Math.max(0, 1 - k * k); });
        for (var j = -1; j <= 1; j++) {   // ///
          var hx = cx + j * rx * 0.42, hy = cy, len = ry * 0.9;
          P.fill(function (x, y) { return sdSeg(x, y, hx + len * 0.45, hy - len, hx - len * 0.45, hy + len, Math.max(0.7, fw * 0.005)); }, C.hatch, 0.75);
        }
      });
      out.fx_blush = P.part('fx_blush');
    }
    if (!have.fx_tears) {
      var Pt = new Painter(F.x0, F.y0, F.x1, F.y1 + fh * 0.1);
      eyes.forEach(function (e, i) {
        var dir = i ? 1 : -1, ew = e.x1 - e.x0, cx = (e.x0 + e.x1) / 2, by = e.y1;
        // a thin wet shine on the lower lid
        Pt.fill(function (x, y) { return sdEllipse(x, y, cx + dir * ew * 0.08, by + ew * 0.01, ew * 0.3, ew * 0.035); }, C.tear, 0.45);
        Pt.fill(function (x, y) { return sdEllipse(x, y, cx + dir * ew * 0.02, by, ew * 0.07, ew * 0.018); }, C.white, 0.85);
        // a tapering stream from the outer corner, curving down the cheek
        var sx = cx + dir * ew * 0.3, len = fh * 0.2, wid = Math.max(1.5, ew * 0.075);
        var pts = [];
        for (var k = 0; k <= 8; k++) { var t = k / 8; pts.push([sx + dir * ew * 0.12 * Math.sin(t * 1.6), by + len * t]); }
        for (var s = 0; s < pts.length - 1; s++) (function (a, b, s) {
          var r = wid * (0.45 + 0.55 * s / (pts.length - 1));
          Pt.fill(function (x, y) { return sdSeg(x, y, a[0], a[1], b[0], b[1], r + 0.8); }, C.tearEdge, 0.35);
          Pt.fill(function (x, y) { return sdSeg(x, y, a[0], a[1], b[0], b[1], r); }, C.tear, 0.7);
        })(pts[s], pts[s + 1], s);
        var end = pts[pts.length - 1];
        Pt.fill(function (x, y) { return sdDrop(x, y, end[0], end[1] + wid * 1.2, wid * 1.3, wid * 2.2); }, C.tear, 0.85);
        Pt.fill(function (x, y) { return sdEllipse(x, y, end[0] - dir * wid * 0.35, end[1] + wid * 1.0, wid * 0.3, wid * 0.5); }, C.white, 0.85);
      });
      out.fx_tears = Pt.part('fx_tears');
    }
    if (!have.fx_sweat) {
      var r = fw * 0.065, cx = F.x1 - fw * 0.02, cy = F.y0 + fh * 0.36, len = r * 2.2;
      var Ps = new Painter(cx - r * 2, cy - len - r, cx + r * 2, cy + r * 2);
      Ps.fill(function (x, y) { return sdDrop(x, y, cx, cy, r + Math.max(1, r * 0.12), len + r * 0.15); }, C.sweatEdge, 1);
      Ps.fill(function (x, y) { return sdDrop(x, y, cx, cy, r, len); }, C.sweat, 1,
        function (x, y) { return 0.75 + 0.25 * Math.max(0, Math.min(1, (y - (cy - len)) / (len + r))); });
      Ps.fill(function (x, y) { return sdEllipse(x, y, cx - r * 0.35, cy - r * 0.15, r * 0.18, r * 0.42); }, C.white, 0.95);
      out.fx_sweat = Ps.part('fx_sweat');
    }
    if (!have.fx_anger) {
      // 💢: four arcs bulging toward the centre, separated by a cross-shaped gap
      var s2 = fw * 0.07, ax = F.x0 + fw * 0.22, ay = F.y0 + fh * 0.16, th = Math.max(2, s2 * 0.5);
      var Pa = new Painter(ax - s2 * 2.6, ay - s2 * 2.6, ax + s2 * 2.6, ay + s2 * 2.6);
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (q) {
        var ccx = ax + q[0] * s2 * 1.55, ccy = ay + q[1] * s2 * 1.55, toward = Math.atan2(-q[1], -q[0]);
        Pa.fill(function (x, y) {
          var da = Math.atan2(y - ccy, x - ccx) - toward; da = Math.atan2(Math.sin(da), Math.cos(da));
          return sdArc(x, y, ccx, ccy, s2 * 1.05, toward - 0.62, toward + 0.62, th * (1 - 0.55 * Math.min(1, Math.pow(da / 0.62, 2))));
        }, C.anger, 1);
      });
      out.fx_anger = Pa.part('fx_anger');
    }
    if (!have.fx_gloom) {
      var gy0 = F.y0 + fh * 0.05, gy1 = (eyes[0].y0 + eyes[1].y0) / 2 + fh * 0.04;
      var Pg = new Painter(F.x0, gy0 - 2, F.x1, gy1 + 2), gh = gy1 - gy0, gcy = gy0 + gh * 0.55;
      // soft bluish shade, strongest on the upper face, no hard edges
      Pg.fill(function (x, y) { return sdEllipse(x, y, F.cx, gcy, fw * 0.44, gh * 0.6); }, C.gloom, 0.32,
        function (x, y) { var k = Math.hypot((x - F.cx) / (fw * 0.44), (y - gcy) / (gh * 0.6)); return Math.max(0, 1 - k * k) * Math.min(1, (gy1 - y) / (gh * 0.5)); });
      var n = 7;
      for (var gI = 0; gI < n; gI++) (function (gI) {
        var gx = F.cx + fw * 0.34 * (2 * gI / (n - 1) - 1), top = gy0 + gh * (0.08 + 0.1 * (gI % 3)), bot = gy1 - gh * (0.12 + 0.12 * ((gI + 1) % 3));
        var a = function (x, y) { var t = (y - top) / Math.max(1, bot - top); return Math.max(0, Math.min(1, t * 4, (1 - t) * 1.6)); };
        Pg.fill(function (x, y) { return sdSeg(x, y, gx, top, gx, bot, Math.max(0.8, fw * 0.005)); }, C.gloom, 0.9, a);
      })(gI);
      out.fx_gloom = Pg.part('fx_gloom');
    }
    return out;
  }

  // ---------- main ----------
  // ---------- rigged mouth (capsule) ----------
  // see-through gives one mouth layer: usually the closed line, sometimes an open mouth. Here it
  // becomes parts the engine can open continuously (Core.deform 'mouthRig'):
  //   mouth_inner      the cavity (also the clip mask for teeth / tongue)
  //   mouth_teeth      upper teeth, ride on the upper lip
  //   mouth_tongue     rides on the bottom of the cavity
  //   mouth_lip_lower  short lower lip line at the bottom of the cavity
  //   mouth_lip_upper  the character's own line (closed art) or a line along the top of the open art
  // Geometry (anchors.mouthRig): the upper lip runs along top0(x) = cy + b q + s q², q = (x - cx) / hw;
  // the fully open cavity reaches top0 + D (1 - (dx / iw)²)^0.6 below it. Both sides use the same formula.
  // An open mouth drawing is kept as the cavity itself (mode 'art'): it already has its teeth and tongue.
  function mouthDepth(MR, x) { var qi = (x - MR.cx) / MR.iw; return MR.D * Math.pow(Math.max(0, 1 - qi * qi), 0.6); }
  function mouthTop(MR, x) { var q = (x - MR.cx) / MR.hw; return MR.cy + MR.b * q + MR.s * q * q; }
  // weighted least squares y = c0 + c1 q + c2 q²
  function fitQuad(pts) {
    var S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], R = [0, 0, 0];
    pts.forEach(function (p) {
      var f = [1, p.q, p.q * p.q];
      for (var i = 0; i < 3; i++) { R[i] += p.w * f[i] * p.y; for (var j = 0; j < 3; j++) S[i][j] += p.w * f[i] * f[j]; }
    });
    for (var c = 0; c < 3; c++) {   // Gauss-Jordan with partial pivoting
      var piv = c;
      for (var r = c + 1; r < 3; r++) if (Math.abs(S[r][c]) > Math.abs(S[piv][c])) piv = r;
      if (Math.abs(S[piv][c]) < 1e-9) return null;
      var tS = S[c]; S[c] = S[piv]; S[piv] = tS; var tR = R[c]; R[c] = R[piv]; R[piv] = tR;
      for (var r2 = 0; r2 < 3; r2++) {
        if (r2 === c) continue;
        var k = S[r2][c] / S[c][c];
        for (var j2 = c; j2 < 3; j2++) S[r2][j2] -= k * S[c][j2];
        R[r2] -= k * R[c];
      }
    }
    return [R[0] / S[0][0], R[1] / S[1][1], R[2] / S[2][2]];
  }
  function layerPixel(layer, x, y) {
    var img = layer.imageData, lx = x - (layer.left | 0), ly = y - (layer.top | 0);
    if (lx < 0 || ly < 0 || lx >= img.width || ly >= img.height) return null;
    var q = (ly * img.width + lx) * 4;
    return [img.data[q], img.data[q + 1], img.data[q + 2]];
  }
  function mixRGB(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

  function synthMouth(entry, faceEntries, FACE, W, H) {
    var al = entry.alpha, b = bboxOf(al, W, H, 32);
    if (!b) return null;
    var width = b.x1 - b.x0 + 1, cols = [];
    for (var x = b.x0; x <= b.x1; x++) {
      var s = 0, sy = 0, n = 0, top = -1;
      for (var y = b.y0; y <= b.y1; y++) {
        var a = al[y * W + x];
        if (a > 32) { s += a; sy += a * y; }
        if (a > 96) { n++; if (top < 0) top = y; }
      }
      if (s > 0) cols.push({ x: x, w: s, yc: sy / s, n: n, top: top });
    }
    if (cols.length < 3) return null;
    var ns = cols.map(function (c) { return c.n; }).sort(function (u, v) { return u - v; });
    var thick = Math.max(1, ns[ns.length >> 1]);
    var lineLike = thick <= Math.max(5, 0.22 * width);
    var fw = FACE.x1 - FACE.x0;
    var cx = (b.x0 + b.x1 + 1) / 2, hw = Math.max(width / 2, fw * 0.035);
    var pts = cols.filter(function (c) { return lineLike || (c.top >= 0 && Math.abs(c.x + 0.5 - cx) < 0.8 * width / 2); })
      .map(function (c) { return { q: (c.x + 0.5 - cx) / hw, y: lineLike ? c.yc + 0.5 : c.top + 0.5, w: lineLike ? c.w : 1 }; });
    var fit = fitQuad(pts);
    if (!fit) return null;
    // a line drawn as a ∪ / ∩ deeper than the mouth is wide is not a mouth line; keep the curve moderate
    fit[2] = Math.max(-hw * 0.6, Math.min(hw * 0.6, fit[2]));
    var th = lineLike ? thick : Math.max(1.5, width * 0.05);
    var MR = { mode: lineLike ? 'line' : 'art', cx: cx, cy: fit[0], hw: hw, b: fit[1], s: fit[2], th: th };
    // open height: about the mouth width for a full "a", never past most of the way to the chin
    MR.iw = hw * 0.9;
    // (small drawn mouths still open to a readable size: at least 7.5% of the face width)
    MR.D = lineLike ? Math.min(Math.max(hw * 1.15, fw * 0.075), Math.max(4, (FACE.y1 - MR.cy) * 0.55))
                    : Math.max(2, b.y1 + 1 - MR.cy);

    // colours: the line (dark-weighted), the skin around the mouth
    var lineRGB = [0, 0, 0], ls = 0, skin = [], aSum = 0;
    for (var y2 = b.y0; y2 <= b.y1; y2++) for (var x2 = b.x0; x2 <= b.x1; x2++) {
      var a2 = al[y2 * W + x2]; if (a2 < 64) continue;
      var c2 = layerPixel(entry.layer, x2, y2); if (!c2) continue;
      var lum = (c2[0] + c2[1] + c2[2]) / 3, w2 = a2 * Math.pow(1 - lum / 255, 2) + 1e-3;
      if (!lineLike) { var py = (y2 - mouthTop(MR, x2 + 0.5)); if (py > th * 2.5) continue; }   // open art: its top outline only
      lineRGB[0] += c2[0] * w2; lineRGB[1] += c2[1] * w2; lineRGB[2] += c2[2] * w2; ls += w2; aSum++;
    }
    lineRGB = ls ? [lineRGB[0] / ls, lineRGB[1] / ls, lineRGB[2] / ls] : [110, 50, 50];
    var ring = Math.max(4, Math.round(hw * 0.6));
    for (var y3 = Math.max(0, b.y0 - ring); y3 <= Math.min(H - 1, b.y1 + ring); y3 += 2) {
      for (var x3 = Math.max(0, b.x0 - ring); x3 <= Math.min(W - 1, b.x1 + ring); x3 += 2) {
        if (al[y3 * W + x3] > 8) continue;
        for (var f = 0; f < faceEntries.length; f++) {
          var Lf = faceEntries[f];
          if (Lf.alpha[y3 * W + x3] < 200) continue;
          var c3 = layerPixel(Lf.layer, x3, y3); if (c3) { skin.push(c3); break; }
        }
      }
    }
    var skinRGB = [250, 222, 210];
    if (skin.length > 8) {
      var med = function (k) { var v = skin.map(function (c) { return c[k]; }).sort(function (u, w) { return u - w; }); return v[v.length >> 1]; };
      skinRGB = [med(0), med(1), med(2)];
    }

    var parts = [];
    var pad = th + 2, x0 = cx - hw - pad, x1 = cx + hw + pad;
    var top0 = function (x) { return mouthTop(MR, x); }, dep = function (x) { return mouthDepth(MR, x); };
    var rad = function (t) { return Math.max(0.6, t / 2); };
    // stroke along y = fy(x) between xa..xb, thickness th(x)
    var strokeSdf = function (fy, xa, xb, thAt) {
      return function (x, y) {
        if (x < xa - 2 || x > xb + 2) return 99;
        var xc = Math.max(xa, Math.min(xb, x)), dy = (y - fy(xc)), slope = (fy(xc + 0.5) - fy(xc - 0.5));
        var d = Math.abs(dy) / Math.sqrt(1 + slope * slope);
        var r0 = rad(thAt(xc));
        return x === xc ? d - r0 : Math.hypot(x - xc, dy) - r0;   // round caps past the ends
      };
    };

    if (lineLike) {
      var minY = Math.min(top0(x0), top0(x1), top0(cx)) - th - 2, maxY = Math.max(top0(x0), top0(x1), top0(cx)) + MR.D + th + 2;
      var cav = mixRGB([140, 44, 58], lineRGB, 0.25), cavDark = mixRGB(cav, lineRGB, 0.55);
      var teeth = mixRGB([255, 255, 255], skinRGB, 0.12), tongue = mixRGB([236, 128, 134], skinRGB, 0.25);
      // distances to the top / bottom curves divided by their slope, so steep corners stay smooth
      var slopeK = function (f, x) { var d = f(x + 0.5) - f(x - 0.5); return Math.sqrt(1 + d * d); };
      var botC = function (x) { return top0(x) + dep(x) + th * 0.2; };
      var cavSdf = function (x, y) {
        var t = top0(x) - th * 0.3;
        return Math.max((t - y) / slopeK(top0, x), (y - botC(x)) / slopeK(botC, Math.max(cx - MR.iw + 0.6, Math.min(cx + MR.iw - 0.6, x))), Math.abs(x - cx) - MR.iw);
      };
      // the cavity: darker under the upper lip, a soft rim of the line colour along its edge
      var Pi = new Painter(x0, minY, x1, maxY);
      Pi.fill(cavSdf, cav, 1);
      Pi.fill(cavSdf, cavDark, 0.6, function (x, y) { var u = Math.max(0, Math.min(1, (y - top0(x)) / Math.max(1, MR.D * 0.6))); return (1 - u) * (1 - u); });
      Pi.fill(function (x, y) { var s0 = cavSdf(x, y); return Math.max(s0, -s0 - Math.max(0.8, th * 0.5)); }, lineRGB, 0.55);
      var inner = Pi.part('mouth_inner');
      // upper teeth: a band under the lip, a little shorter at the corners
      var Pt = new Painter(x0, minY, x1, maxY);
      Pt.fill(function (x, y) {
        var tb = top0(x) + MR.D * 0.2 * Math.pow(Math.max(0, 1 - Math.pow((x - cx) / (MR.iw * 0.95), 2)), 0.35);
        return Math.max(top0(x) - th - y, y - tb, Math.abs(x - cx) - MR.iw);
      }, teeth, 1);
      var teethP = Pt.part('mouth_teeth');
      // tongue: a soft oval resting on the bottom of the cavity
      var Pg = new Painter(x0, minY, x1, maxY), tcy = top0(cx) + MR.D * 0.95;
      Pg.fill(function (x, y) { return sdEllipse(x, y, cx, tcy, MR.iw * 0.5, MR.D * 0.27); }, tongue, 1);
      Pg.fill(function (x, y) { return sdEllipse(x, y, cx, tcy - MR.D * 0.02, MR.iw * 0.035, MR.D * 0.16); }, mixRGB(tongue, cav, 0.35), 0.5);
      var tongueP = Pg.part('mouth_tongue');
      // lower lip: a short line just inside the bottom of the cavity, thinner at its ends
      var Pl = new Painter(x0, minY, x1, maxY), lw = MR.iw * 0.5;
      Pl.fill(strokeSdf(function (x) { return top0(x) + dep(x) - th * 0.3; }, cx - lw, cx + lw,
        function (x) { var u = (x - cx) / lw; return th * 0.75 * Math.max(0.35, 1 - u * u); }), lineRGB, 0.75);
      var lowerP = Pl.part('mouth_lip_lower');
      var upper = makePart('mouth_lip_upper', entry.layer, al, null, W, H, SLOTS.mouth_lip_upper, 0, null, null);
      [inner, teethP, tongueP, lowerP, upper].forEach(function (p) { if (p) { p.synthetic = true; parts.push(p); } });
    } else {
      // open art: it is the cavity (teeth and tongue already drawn); a line along its top closes it
      var innerA = makePart('mouth_inner', entry.layer, al, null, W, H, SLOTS.mouth_inner, 0, null, null);
      // painted where it sits when closed: the arch flattened the same way Core.deform flattens it
      var closedTop = function (x) { var q = Math.max(-1.3, Math.min(1.3, (x - cx) / MR.hw)); return top0(x) - 0.85 * MR.s * (q * q - 0.35); };
      var Pu = new Painter(x0, Math.min(closedTop(x0), closedTop(x1), closedTop(cx)) - th - 3, x1, Math.max(closedTop(x0), closedTop(x1), closedTop(cx)) + th + 3);
      var ew = width * 0.42;   // a closed mouth is a little narrower than the open one
      Pu.fill(strokeSdf(closedTop, cx - ew, cx + ew, function (x) { var u = (x - cx) / ew; return th * Math.max(0.3, 1 - 0.7 * u * u); }), lineRGB, 1);
      var upperA = Pu.part('mouth_lip_upper');
      [innerA, upperA].forEach(function (p) { if (p) { p.synthetic = true; parts.push(p); } });
    }
    if (!parts.length || parts[0].name !== 'mouth_inner') return null;
    var r = function (v) { return Math.round(v * 100) / 100; };
    return { parts: parts, geom: { mode: MR.mode, cx: r(MR.cx), cy: r(MR.cy), hw: r(MR.hw), b: r(MR.b), s: r(MR.s), iw: r(MR.iw), D: r(MR.D), th: r(MR.th) } };
  }

  function buildRig(psd, opts) {
    opts = opts || {};
    validatePsd(psd);
    var W = psd.width, H = psd.height;
    var warnings = [];
    var kids = imageLayersOf(psd);
    if (!kids.length) throw new Error('보이는 이미지 레이어가 없습니다');
    if (kids.length * W * H > 128000000) throw new Error('리깅에 필요한 메모리가 너무 큽니다. 레이어 수나 해상도를 줄여 주세요');

    // full alphas, cleaned
    var entries = [];
    for (var i = 0; i < kids.length; i++) {
      // capsule: "handwear@typing" = a layer for one pose (seethrough/pose_art.py), shown by poseTyping
      var pm = /^(.*?)\s*@\s*([a-z][a-z0-9_]{0,20})\s*$/i.exec(String(kids[i].name == null ? '' : kids[i].name));
      var name = normName(pm ? pm[1] : kids[i].name), pose = pm ? pm[2].toLowerCase() : null;
      var fa = cleanAlpha(fullAlphaOf(kids[i], W, H), W, H, 40);
      if (!bboxOf(fa, W, H, 8)) { warnings.push('빈 레이어 "' + name + '" 건너뜀'); continue; }
      entries.push({ name: name, layer: kids[i], alpha: fa, pose: pose });
    }
    if (!entries.length) throw new Error('캔버스 안에 보이는 픽셀이 없습니다');
    // A plain "hair" layer is split by the painter's order: above the face it
    // is front hair, below it back hair (see-through emits both as "hair").
    var faceIndex = -1;
    for (var fi = 0; fi < entries.length; fi++) if (baseName(entries[fi].name) === 'face') { faceIndex = fi; break; }
    entries.forEach(function (e, idx) {
      if (baseName(e.name) !== 'hair') return;
      var suffix = e.name.slice(4);
      e.name = (faceIndex >= 0 && idx > faceIndex ? 'front hair' : 'back hair') + suffix;
    });
    var byBase = Object.create(null);
    entries.forEach(function (e) {
      if (e.pose) return;   // pose layers never define anchors
      var bn = baseName(e.name);
      (byBase[bn] || (byBase[bn] = [])).push(e);
    });
    function merged(name) { return mergeAlphas(byBase[name], W, H); }

    // face anchor (required-ish)
    var faceAlpha = merged('face');
    var FACE;
    if (faceAlpha) {
      var fb = bboxOf(faceAlpha, W, H, 8), fc = centroidOf(faceAlpha, W, H);
      FACE = { cx: fc.cx, cy: fc.cy, x0: fb.x0, x1: fb.x1, y0: fb.y0, y1: fb.y1 };
    } else {
      warnings.push('face 레이어가 없어 캔버스 가운데를 얼굴로 가정했습니다');
      FACE = { cx: W / 2, cy: H * 0.3, x0: W * 0.35, x1: W * 0.65, y0: H * 0.1, y1: H * 0.5 };
    }

    // build parts
    var parts = [], z = 0, sided = {};
    for (var ei = 0; ei < entries.length; ei++) {
      var e = entries[ei];
      var bn = baseName(e.name);
      if (e.pose) {
        // one static part per pose layer; it follows the body and fades in with its pose value
        var ps = SLOTS[bn] || { depth: 1.0 };
        var recP = makePart(e.name + '@' + e.pose, e.layer, e.alpha, null, W, H, { depth: ps.depth, group: 'body', fade: 'pose' }, z, null, null);
        if (recP) { recP.pose = e.pose; parts.push(recP); z++; }
        continue;
      }
      var slot = Object.prototype.hasOwnProperty.call(SLOTS, bn) ? SLOTS[bn] : null;
      if (!slot || slot.group === 'auto') {
        var c0 = centroidOf(e.alpha, W, H);
        var guessed = (c0 && c0.cy < FACE.y1) ? 'head' : 'body';
        if (!slot) warnings.push('모르는 레이어 이름 "' + e.name + '" — ' + (guessed === 'head' ? '머리' : '몸') + '를 따라 움직입니다');
        slot = { depth: slot ? slot.depth : 1.0, group: guessed, unknown: !slot };
      }
      var am = slot.arm ? splitArms(e.alpha, W, H, FACE) : null;
      if (am && am.torso && opts.carveArms !== false) {
        // capsule: cut the arms out of a torso-mixed layer; the rest becomes the upper body
        var cv = carveArms(e.layer, e.alpha, W, H, FACE);
        if (cv) {
          var tName = byBase.topwear ? 'topwear_' + (90 + ei) : 'topwear';
          var recT = makePart(tName, cv.torsoLayer, cv.torsoAlpha, null, W, H, SLOTS.topwear, z, null, null);
          if (recT) { recT.source = String(e.layer.name == null ? '' : e.layer.name); recT.carved = true; parts.push(recT); z++; }
          am = { l: cv.l, r: cv.r, carved: true };
          warnings.push('"' + e.name + '"에 몸통이 섞여 있어 팔을 잘라 냈습니다 (팔 뒤 몸통은 자동으로 채움 · 기준점에서 관절을 확인하세요)');
        }
      }
      if (am && am.torso) warnings.push('"' + e.name + '"에 몸통이 섞여 있어 팔 리그를 껐습니다 (팔만 있는 레이어가 필요합니다)');
      if (am && !am.torso) {
        // capsule: one part per arm so each can be rigged on its own (see detectArm)
        var nArm = 0;
        ['l', 'r'].forEach(function (s) {
          if (!am[s]) return;
          var recA = makePart(e.name + '_' + s, e.layer, e.alpha, am[s], W, H, slot, z, s.toUpperCase(), null);
          if (!recA) return;
          if (am.carved) recA.carved = true;
          parts.push(recA); z++; nArm++;
          var aa = new Uint8Array(W * H);
          for (var qa = 0; qa < W * H; qa++) aa[qa] = am[s][qa] ? e.alpha[qa] : 0;
          var kA = 'arm|' + s;
          if (!sided[kA]) sided[kA] = aa;
          else for (var qb = 0; qb < aa.length; qb++) if (aa[qb] > sided[kA][qb]) sided[kA][qb] = aa[qb];
        });
        if (!nArm) warnings.push('"' + e.name + '" 좌우 분리 실패 (빈 레이어?)');
      } else if (slot.split) {
        var masks = splitSides(e.alpha, W, H, FACE.cx);
        var got = false;
        ['l', 'r'].forEach(function (s) {
          if (!masks[s]) return;
          var rec = makePart(e.name + '_' + s, e.layer, e.alpha, masks[s], W, H, slot, z, s.toUpperCase(), null);
          if (rec) {
            parts.push(rec); z++;
            var ma = new Uint8Array(W * H);
            for (var q = 0; q < W * H; q++) ma[q] = masks[s][q] ? e.alpha[q] : 0;
            var sideKey = bn + '|' + s;
            if (!sided[sideKey]) sided[sideKey] = ma;
            else for (var mq = 0; mq < ma.length; mq++) if (ma[mq] > sided[sideKey][mq]) sided[sideKey][mq] = ma[mq];
            got = true;
          }
        });
        if (!got) warnings.push('"' + e.name + '" の左右分離に失敗（空レイヤー？）');
      } else if (slot.phys === 'hair') {
        var isPart = /_\d+$/.test(e.name);
        var bb2 = bboxOf(e.alpha, W, H, 16);
        var wpx = bb2 ? (bb2.x1 - bb2.x0) : 0;
        // capsule: finer strands (about one per 30 px of bangs, 42 px of back hair) so locks move on their own
        var want = isPart ? Math.max(2, Math.min(8, Math.round(wpx / 60)))
          : bn === 'back hair' ? Math.max(6, Math.min(14, Math.round(wpx / 42))) : Math.max(4, Math.min(10, Math.round(wpx / 30)));
        var minSep = Math.max(14, Math.round(wpx / (want * 1.5)));
        // capsule: one layer per lock (splitHairLocks): bangs ~ one per 35 px (3..8), back hair ~ 95 px (3..7)
        var nLocks = isPart || opts.hairLocks === false ? 0 : bn === 'back hair' ? Math.max(3, Math.min(7, Math.round(wpx / 95)))
          : Math.max(3, Math.min(8, Math.round(wpx / 35)));
        var locks = nLocks ? splitHairLocks(e.alpha, e.layer, W, H, nLocks) : null;
        if (locks) {
          // every lock measures its strands against the whole layer's top / bottom at that column, so
          // neighbours agree near the roots (no gap opens there) and only part toward the tips
          var fTop = new Float32Array(W).fill(-1), fBot = new Float32Array(W);
          for (var fx = 0; fx < W; fx++) {
            for (var fy = 0; fy < H; fy++) if (e.alpha[fy * W + fx] > 16) { fTop[fx] = fy; break; }
            if (fTop[fx] >= 0) for (var fy2 = H - 1; fy2 >= 0; fy2--) if (e.alpha[fy2 * W + fx] > 16) { fBot[fx] = fy2; break; }
          }
          locks.forEach(function (lm, li) {
            var la = new Uint8Array(W * H);
            for (var qi = 0; qi < la.length; qi++) if (lm[qi]) la[qi] = e.alpha[qi];
            var lb = bboxOf(la, W, H, 16), lw = lb ? lb.x1 - lb.x0 : 0;
            var lwant = Math.max(1, Math.min(4, Math.round(lw / 40)));
            var lst = detectStrands(la, W, H, Math.max(10, Math.round(lw / (lwant * 1.5))), lwant);
            lst.forEach(function (st) { if (fTop[st.x] >= 0) { st.rootY = fTop[st.x]; st.tipY = Math.max(st.tipY, fBot[st.x]); } });
            var recL = makePart(e.name + '_' + (li + 1), e.layer, e.alpha, lm, W, H, slot, z, null, lst);
            if (recL) { recL.lock = li + 1; parts.push(recL); z++; }
          });
        } else {
          var strands = detectStrands(e.alpha, W, H, minSep, want);
          var rec2 = makePart(e.name, e.layer, e.alpha, null, W, H, slot, z, null, strands);
          if (rec2) { parts.push(rec2); z++; }
        }
      } else if (slot.phys === 'sway') {
        // Earrings, tails: a few pendulums hanging from the top of the part.
        var bb3 = bboxOf(e.alpha, W, H, 16);
        var wpx3 = bb3 ? (bb3.x1 - bb3.x0) : 0;
        var want3 = Math.max(1, Math.min(4, Math.round(wpx3 / 140)));
        var sway = detectStrands(e.alpha, W, H, Math.max(20, Math.round(wpx3 / (want3 * 1.6))), want3);
        var rec4 = makePart(e.name, e.layer, e.alpha, null, W, H, slot, z, null, sway);
        if (rec4) { parts.push(rec4); z++; }
      } else {
        var rec3 = makePart(e.name, e.layer, e.alpha, null, W, H, slot, z, null, null);
        if (rec3) { if (slot.unknown) rec3.unknown = true; parts.push(rec3); z++; }
      }
    }

    // capsule: skin eyelids (one per eye), placed right after the irides; the reorder below puts them
    // between the iris and the lashes
    if (opts.lids !== false && byBase.face) {
      var avoid = mergeAlphas((byBase.eyelash || []).concat(byBase.eyebrow || []), W, H) || new Uint8Array(W * H);
      ['l', 'r'].forEach(function (s) {
        var ew0 = sided['eyewhite|' + s];
        if (!ew0) return;
        var op = new Uint8Array(ew0), ir0 = sided['irides|' + s];
        if (ir0) for (var q = 0; q < op.length; q++) if (ir0[q] > op[q]) op[q] = ir0[q];
        var lid = synthLid(s.toUpperCase(), op, byBase.face, avoid, W, H);
        if (!lid) return;
        // the double-eyelid crease (a line above the lash band, separated by a gap) becomes its own
        // layer: it stays put while the lashes come down
        var li = lastIndexWhere(parts, function (p) { return /^eyelash(_\d+)?_[lr]$/.test(p.name) && p.side === s.toUpperCase(); });
        if (li >= 0) {
          var lo = splitLowerLash(parts[li], op, W, H);
          if (lo) parts.splice(li, 0, lo);   // lower lashes under the upper ones
          li = lastIndexWhere(parts, function (p) { return /^eyelash(_\d+)?_[lr]$/.test(p.name) && p.side === s.toUpperCase(); });
          var cr = splitCrease(parts[li], op, W, H); if (cr) parts.splice(li + 1, 0, cr);
        }
        var at = lastIndexWhere(parts, function (p) { return /^(irides|eyewhite)(_\d+)?_/.test(p.name) && p.side === s.toUpperCase(); });
        parts.splice(at + 1, 0, lid);
      });
    }

    // Eye parts always stack white -> iris -> lashes -> closed eye. see-through orders layers by
    // estimated depth, and on a tilted face it can put the white over the iris (blank eyes).
    // The eye parts keep the slots they occupy; only their order inside those slots changes.
    var EYE_RANK = { 'eyewhite': 0, 'irides': 1, 'eye_lid': 1.5, 'eyelash': 2, 'eyelash_crease': 2, 'eyelash_lower': 2, 'eye_close': 3, 'eye_close2': 3, 'eye_smile': 3 };
    var eyeSlots = [], eyeParts = [];
    parts.forEach(function (p, i) { var b = baseName(p.name.replace(/_(l|r)$/, '')); if (b in EYE_RANK) { eyeSlots.push(i); eyeParts.push(p); } });
    var eyeSorted = eyeParts.map(function (p, i) { return { p: p, i: i, r: EYE_RANK[baseName(p.name.replace(/_(l|r)$/, ''))] }; })
      .sort(function (a, b) { return a.r - b.r || a.i - b.i; });
    if (eyeSorted.some(function (e, k) { return e.p !== eyeParts[k]; })) {
      eyeSorted.forEach(function (e, k) { parts[eyeSlots[k]] = e.p; });
      warnings.push('눈 파츠 순서를 바로잡았습니다 (흰자 → 눈동자 → 속눈썹)');
    }

    // anchors
    var anchors = { face: FACE };
    ['l', 'r'].forEach(function (s) {
      var ew = sided['eyewhite|' + s], ir = sided['irides|' + s], ec = sided['eye_close|' + s];
      var K = 'eye' + s.toUpperCase();
      if (ew) {
        var b = bboxOf(ew, W, H, 8);
        var a = { x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1 };
        var ic = ir ? centroidOf(ir, W, H) : centroidOf(ew, W, H);
        a.icx = ic.cx; a.icy = ic.cy;
        var cc = ec ? centroidOf(ec, W, H) : null;
        a.closeY = cc ? cc.cy : (b.y0 + (b.y1 - b.y0) * 0.62);
        a.ang = eyeAxis(ew, W, H, b);   // capsule: the eye's own tilt (radians, + = clockwise on screen)
        anchors[K] = a;
      }
    });
    if (!anchors.eyeL || !anchors.eyeR) warnings.push('눈 기준점이 불완전합니다 (eyewhite / irides 레이어 확인)');

    var mouthAlpha = merged('mouth_open') || merged('mouth_close');
    if (mouthAlpha) {
      var mb = bboxOf(mouthAlpha, W, H, 8), mc = centroidOf(mouthAlpha, W, H);
      anchors.mouth = { x0: mb.x0, x1: mb.x1, y0: mb.y0, y1: mb.y1, cx: mc.cx, cy: mc.cy };
    } else {
      warnings.push('입 레이어(mouth_open / mouth_close)가 없습니다');
      anchors.mouth = { x0: FACE.cx - 20, x1: FACE.cx + 20, y0: FACE.cy + 40, y1: FACE.cy + 60, cx: FACE.cx, cy: FACE.cy + 50 };
    }

    var neckAlpha = merged('neck');
    if (neckAlpha) {
      var nb = bboxOf(neckAlpha, W, H, 8), nc = centroidOf(neckAlpha, W, H);
      anchors.neckPivot = { cx: nc.cx, cy: nb.y0 + (nb.y1 - nb.y0) * 0.85 };
      anchors.neckTop = nb.y0; anchors.neckBottom = nb.y1;
    } else {
      anchors.neckPivot = { cx: FACE.cx, cy: FACE.y1 + 20 };
      anchors.neckTop = FACE.y1; anchors.neckBottom = FACE.y1 + 60;
    }
    anchors.bodyPivot = { cx: anchors.neckPivot.cx, cy: H };
    anchors.faceScale = Math.max(1, FACE.x1 - FACE.x0) / 333.0;
    anchors.hairRootY = FACE.y0 + 60;

    // arms: shoulder / elbow / wrist per side (capsule)
    ['l', 'r'].forEach(function (s) {
      var am = sided['arm|' + s];
      if (!am) return;
      var arm = detectArm(am, W, H, FACE, anchors.neckPivot);
      if (arm) anchors['arm' + s.toUpperCase()] = arm;
      else warnings.push('팔 기준점을 찾지 못했습니다 (' + (s === 'l' ? '왼쪽' : '오른쪽') + ')');
    });

    // ---------- synthesize missing close diffs from generic parts ----------
    var synth = { eye: false, mouth: false };
    var G = opts.generic;
    if (G) {
      var partBase = function (p) { return baseName(p.name.replace(/_(l|r)$/, '')); };
      var findPart = function (name) { return parts.filter(function (p) { return partBase(p) === name; }); };
      // eyes
      if (G.eyeL || G.eyeR) {
        var slotEC = SLOTS['eye_close'];
        var mk = function (S, gimg, side) {
          var lash = findPart('eyelash').find(function(p){return p.side === side;}) || findPart('eyebrow').find(function(p){return p.side === side;});
          var tint = lash ? meanColorOfImg(lash.img || { data: new Uint8ClampedArray(0) }, false) : null;
          return synthPart('eye_close_' + side.toLowerCase(), gimg,
            (S.x1 - S.x0) * 1.1, (S.x0 + S.x1) / 2, S.closeY, 0.55, tint, slotEC, side);
        };
        var idxE = lastIndexWhere(parts, function (p) { return p.name.indexOf('eyelash') === 0; });
        if (idxE < 0) idxE = lastIndexWhere(parts, function (p) { return p.name.indexOf('irides') === 0; });
        if (idxE < 0) idxE = lastIndexWhere(parts, function (p) { return p.name === 'face'; });
        ['L', 'R'].forEach(function(side) {
          if (G['eye'+side] && anchors['eye'+side] && !findPart('eye_close').some(function(p){return p.side===side;})) {
            parts.splice(++idxE, 0, mk(anchors['eye'+side], G['eye'+side], side));
            synth.eye = true;
          }
        });
        if (synth.eye) warnings.push('감은 눈이 없어 기본 감은 눈을 자동으로 넣었습니다 (캐릭터 맞춤 → 눈에서 맞출 수 있음)');
      }
      // mouth
      if (G.mouth && !findPart('mouth_close').length && merged('mouth_open')) {
        var m = anchors.mouth;
        var mc = synthPart('mouth_close', G.mouth,
          (m.x1 - m.x0) * 1.1, m.cx, m.y0 + 0.30 * (m.y1 - m.y0), 0.5,
          (function () { var mo = findPart('mouth_open')[0];
                         return mo ? meanColorOfImg(mo.img, true) : null; })(),
          SLOTS['mouth_close'], null);
        var idxM = lastIndexWhere(parts, function (p) { return partBase(p) === 'mouth_open'; });
        if (idxM < 0) idxM = lastIndexWhere(parts, function (p) { return p.name === 'face'; });
        parts.splice(idxM + 1, 0, mc);
        synth.mouth = true;
        warnings.push('다문 입이 없어 기본 다문 입을 자동으로 넣었습니다 (캐릭터 맞춤 → 입에서 맞출 수 있음)');
      }
    }
    // ---------- rigged mouth (capsule): cavity, teeth, tongue and lip lines from the mouth layer ----------
    if (opts.mouthRig !== false && byBase.mouth_open && byBase.face) {
      var mEntry = byBase.mouth_open.slice().sort(function (u, v) {
        var bu = bboxOf(u.alpha, W, H, 32), bv = bboxOf(v.alpha, W, H, 32);
        return (bv ? (bv.x1 - bv.x0) : 0) - (bu ? (bu.x1 - bu.x0) : 0);
      })[0];
      var rigM = synthMouth(mEntry, byBase.face, FACE, W, H);
      if (rigM) {
        var mBase = function (p) { return baseName(p.name.replace(/_(l|r)$/, '')); };
        var idxR = lastIndexWhere(parts, function (p) { return /^mouth_/.test(mBase(p)); });
        if (idxR < 0) idxR = lastIndexWhere(parts, function (p) { return mBase(p) === 'face' || mBase(p) === 'facedetail'; });
        Array.prototype.splice.apply(parts, [idxR + 1, 0].concat(rigM.parts));
        anchors.mouthRig = rigM.geom;
        synth.mouthRig = rigM.geom.mode;
      } else warnings.push('입을 파츠로 나누지 못했습니다 (그린 입 모양을 그대로 씁니다)');
    }
    // ---------- effect layers (capsule): painted ones win, the rest are drawn here ----------
    if (opts.fx !== false) {
      var fxBase = function (p) { return baseName(p.name.replace(/_(l|r)$/, '')); };
      var have = {};
      FX_SLOTS.forEach(function (s) { have[s] = !!byBase[s]; });
      var fx = synthEffects(anchors, have);
      var after = function (names) { return lastIndexWhere(parts, function (p) { return names.indexOf(fxBase(p)) >= 0; }); };
      if (fx.fx_blush) { var ib = after(['face', 'facedetail']); parts.splice(ib + 1, 0, fx.fx_blush); }
      if (fx.fx_tears) { var it = after(['eyelash', 'eye_close', 'eye_close2', 'irides', 'eyewhite']); if (it < 0) it = after(['face']); parts.splice(it + 1, 0, fx.fx_tears); }
      ['fx_gloom', 'fx_sweat', 'fx_anger'].forEach(function (s) { if (fx[s]) parts.push(fx[s]); });
      synth.fx = FX_SLOTS.filter(function (s) { return !!fx[s]; });
    }
    for (var zi = 0; zi < parts.length; zi++) parts[zi].z = zi;

    return { canvas: { w: W, h: H }, layers: parts, anchors: anchors, warnings: warnings, synth: synth };
  }

  // in-place preprocessing: denoise every layer (connected components >= 40px)
  // and trim to content bbox. Fixes PSDs with low-alpha noise across the canvas.
  function cleanPsdLayers(psd) {
    validatePsd(psd);
    var stats = { noisy: 0, layers: 0 };
    var kids = imageLayersOf(psd);
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i], img = c.imageData, W = img.width, H = img.height, d = img.data;
      stats.layers++;
      var a = new Uint8Array(W * H), j, before = 0, after = 0;
      for (j = 0; j < W * H; j++) { a[j] = d[j * 4 + 3]; if (a[j]) before++; }
      cleanAlpha(a, W, H, 40);
      for (j = 0; j < W * H; j++) { if (a[j]) after++; d[j * 4 + 3] = a[j]; }
      if (after < before) stats.noisy++;
      var bb = bboxOf(a, W, H, 0);
      if (!bb) continue;
      var pad = 4;
      var x0 = Math.max(0, bb.x0 - pad), y0 = Math.max(0, bb.y0 - pad);
      var x1 = Math.min(W - 1, bb.x1 + pad), y1 = Math.min(H - 1, bb.y1 + pad);
      var w = x1 - x0 + 1, h = y1 - y0 + 1;
      if (w >= W && h >= H) continue;
      var nd = new Uint8ClampedArray(w * h * 4);
      for (var y = 0; y < h; y++) {
        var so = ((y + y0) * W + x0) * 4;
        nd.set(d.subarray(so, so + w * 4), y * w * 4);
      }
      c.imageData = { width: w, height: h, data: nd };
      c.left = (c.left | 0) + x0; c.top = (c.top | 0) + y0;
      c.right = c.left + w; c.bottom = c.top + h;
      if (c.canvas) c.canvas = undefined;
    }
    return stats;
  }

  function roleLabel(bn) { return ROLE_LABELS[bn] || null; }

  return { buildRig: buildRig, normName: normName, baseName: baseName, cleanPsdLayers: cleanPsdLayers, validatePsd: validatePsd,
           flattenPsdToImg: flattenPsdToImg, splitImgLR: splitImgLR, roleLabel: roleLabel,
           SLOT_NAMES: Object.keys(SLOTS), FX_SLOTS: FX_SLOTS,
           _internals: { findPeaks: findPeaks, detectStrands: detectStrands,
                         labelComponents: labelComponents, cleanAlpha: cleanAlpha, splitArms: splitArms, detectArm: detectArm, carveArms: carveArms,
                         imageLayersOf: imageLayersOf, mergeAlphas: mergeAlphas, resampleRGBA: resampleRGBA, synthEffects: synthEffects } };
});
