/*!
 * Capsule Model Studio — expressions.js
 * reactions.json helpers for the editor's 「표정·모션」 tab. No DOM, runs in Node.
 *
 *   normalize(value, ranges)        validate + clean a reactions object (throws on bad structure)
 *   poseParams(T, base, keys)       slider values that differ from `base` (an expression / a key)
 *   motionKeys(motion, defaults)    tracks -> editable key poses [{t, params}]
 *   motionFromKeys(motion, keys, defaults)  key poses -> tracks (other fields kept)
 *   stringify(reactions)            compact, readable JSON
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../engine/animator.js'));
  else root.CapsuleExpressions = factory(root.CapsuleAnimator);
})(typeof self !== 'undefined' ? self : this, function (Anim) {
  'use strict';
  const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
  const EASES = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'step'];
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const round = v => Math.round(v * 1000) / 1000;

  function cleanLabel(s) { return typeof s === 'string' ? s.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) : ''; }

  /** Validated copy. Unknown parameters are dropped; values are clamped to `ranges`. */
  function normalize(value, ranges) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('reactions.json 형식이 아닙니다');
    if (value.format && value.format !== 'capsule-reactions') throw new Error('reactions.json 형식이 아닙니다 (format)');
    const out = { format: 'capsule-reactions', version: 1 };
    if (typeof value._comment === 'string') out._comment = value._comment.slice(0, 2000);
    const params = (p, absolute) => {
      const o = {};
      for (const k in (p && typeof p === 'object') ? p : {}) {
        if (!Object.prototype.hasOwnProperty.call(ranges, k) || !isNum(p[k])) continue;
        const r = ranges[k], span = r[1] - r[0];
        o[k] = round(absolute ? clamp(p[k], r[0], r[1]) : clamp(p[k], -span, span));
      }
      return o;
    };
    out.expressions = {};
    for (const [name, x] of Object.entries(value.expressions || {})) {
      if (!NAME_RE.test(name) || !x || typeof x !== 'object') continue;
      const e = { params: params(x.params, true) };
      const label = cleanLabel(x.label); if (label) e.label = label;
      if (x.layers && typeof x.layers === 'object') {
        e.layers = {};
        for (const [ln, lv] of Object.entries(x.layers)) if (isNum(lv) && ln.length <= 60) e.layers[ln] = clamp(lv, 0, 1);
      }
      out.expressions[name] = e;
    }
    if (!out.expressions.neutral) out.expressions = Object.assign({ neutral: { label: '기본', params: {} } }, out.expressions);
    out.motions = {};
    for (const [name, m] of Object.entries(value.motions || {})) {
      if (!NAME_RE.test(name) || !m || typeof m !== 'object') continue;
      const mode = m.mode === 'override' ? 'override' : 'add';
      const o = {};
      const label = cleanLabel(m.label); if (label) o.label = label;
      o.duration = Math.round(clamp(isNum(m.duration) ? m.duration : 1000, 100, 60000));
      o.fadeIn = Math.round(clamp(isNum(m.fadeIn) ? m.fadeIn : 0, 0, o.duration));
      o.fadeOut = Math.round(clamp(isNum(m.fadeOut) ? m.fadeOut : 0, 0, o.duration));
      o.mode = mode; o.tracks = {};
      for (const [k, keys] of Object.entries(m.tracks || {})) {
        if (!Object.prototype.hasOwnProperty.call(ranges, k) || !Array.isArray(keys)) continue;
        const r = ranges[k], span = r[1] - r[0];
        const t = keys.filter(q => Array.isArray(q) && isNum(q[0]) && isNum(q[1]))
          .map(q => { const a = [Math.round(clamp(q[0], 0, 60000)), round(mode === 'override' ? clamp(q[1], r[0], r[1]) : clamp(q[1], -span, span))]; if (EASES.includes(q[2])) a.push(q[2]); return a; })
          .sort((a, b) => a[0] - b[0]);
        if (t.length) o.tracks[k] = t;
      }
      if (Array.isArray(m.events)) {
        const ev = m.events.filter(x => x && isNum(x.t)).map(x => {
          const y = { t: Math.round(clamp(x.t, 0, 60000)) };
          if (isNum(x.talk)) y.talk = clamp(x.talk, 0, 60000);
          if (typeof x.layer === 'string') { y.layer = x.layer.slice(0, 60); if (isNum(x.value)) y.value = clamp(x.value, 0, 1); }
          if (typeof x.expression === 'string' && NAME_RE.test(x.expression)) { y.expression = x.expression; if (isNum(x.hold)) y.hold = clamp(x.hold, 0, 60000); }
          return y;
        });
        if (ev.length) o.events = ev;
      }
      out.motions[name] = o;
    }
    out.reactions = {};
    for (const [trigger, list] of Object.entries(value.reactions || {})) {
      if (!/^[A-Z0-9_]{1,40}$/.test(trigger) || !Array.isArray(list)) continue;
      out.reactions[trigger] = list.filter(c => c && typeof c === 'object').map(c => {
        const y = {};
        if (isNum(c.intensity)) y.intensity = Math.round(clamp(c.intensity, 0, 9));
        for (const k of ['motion', 'expression', 'then']) if (typeof c[k] === 'string' && NAME_RE.test(c[k])) y[k] = c[k];
        for (const k of ['hold', 'talk']) if (isNum(c[k])) y[k] = Math.round(clamp(c[k], 0, 60000));
        if (isNum(c.weight)) y.weight = clamp(c.weight, 0, 1000);
        return y;
      });
    }
    if (Array.isArray(value.toggles)) out.toggles = value.toggles.filter(s => typeof s === 'string' && s.length <= 60);
    return out;
  }

  /** Parameters in `keys` whose slider value differs from `base`. */
  function poseParams(T, base, keys) {
    const o = {};
    for (const k of keys) if (isNum(T[k]) && Math.abs(T[k] - base[k]) > 1e-3) o[k] = round(T[k]);
    return o;
  }

  /**
   * Motion -> key poses. Every time that has a key on any track becomes a key;
   * its params are each track's value at that time ('add': offsets, 'override': absolute).
   */
  function motionKeys(m) {
    const times = new Set();
    for (const keys of Object.values(m.tracks || {})) for (const k of keys) times.add(k[0]);
    return [...times].sort((a, b) => a - b).map(t => {
      const params = {};
      for (const [p, keys] of Object.entries(m.tracks || {})) params[p] = round(Anim.sampleTrack(keys, t));
      return { t, params };
    });
  }

  /** Key poses -> tracks. A parameter missing from a key is 0 ('add') or its default ('override'). */
  function motionFromKeys(m, keys, defaults) {
    const sorted = keys.slice().sort((a, b) => a.t - b.t);
    const names = new Set();
    for (const k of sorted) for (const p in k.params) names.add(p);
    const tracks = {};
    for (const p of names) tracks[p] = sorted.map(k => [Math.round(k.t), round(p in k.params ? k.params[p] : (m.mode === 'override' ? defaults[p] : 0))]);
    const last = sorted.length ? sorted[sorted.length - 1].t : 0;
    return Object.assign({}, m, { tracks, duration: Math.max(m.duration || 0, Math.round(last)) });
  }

  // Readable JSON: short objects / number arrays on one line.
  function stringify(value) {
    const flat = v => JSON.stringify(v).replace(/,(?=["\[{\d-])/g, ', ').replace(/":/g, '": ');
    const scalar = v => v === null || typeof v !== 'object';
    function fmt(v, ind) {
      const pad = '  '.repeat(ind);
      if (Array.isArray(v)) {
        if (v.every(x => scalar(x) || (Array.isArray(x) && x.every(scalar))) && flat(v).length < 140) return flat(v);
        return '[\n' + v.map(x => pad + '  ' + fmt(x, ind + 1)).join(',\n') + '\n' + pad + ']';
      }
      if (v && typeof v === 'object') {
        const keys = Object.keys(v);
        if (!keys.length) return '{}';
        if (keys.every(k => scalar(v[k])) && flat(v).length < 110) return flat(v).replace(/^\{/, '{ ').replace(/\}$/, ' }');
        return '{\n' + keys.map(k => pad + '  ' + JSON.stringify(k) + ': ' + fmt(v[k], ind + 1)).join(',\n') + '\n' + pad + '}';
      }
      return JSON.stringify(v);
    }
    return fmt(value, 0) + '\n';
  }

  /** A fresh name like "custom3" that is not in `taken`. */
  function freshName(prefix, taken) { let i = 1; while (taken[prefix + i]) i++; return prefix + i; }

  return { NAME_RE, normalize, poseParams, motionKeys, motionFromKeys, stringify, freshName };
});
