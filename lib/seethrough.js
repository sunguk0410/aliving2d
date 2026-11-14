/*!
 * seethrough.js — client for seethrough/server.py (image -> parts PSD).
 * The server runs on Colab (Cloudflare tunnel), a GPU desktop, or in fake mode.
 * A "connection code" is `<base url>#<token>`.
 *
 *   const conn = SeeThrough.parseCode(code);
 *   await SeeThrough.health(conn);
 *   const { psd, name } = await SeeThrough.convert(conn, file, { onStatus, signal });
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SeeThrough = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
  const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

  function isImage(file) { return !!file && (IMAGE_RE.test(file.name || '') || /^image\/(png|jpeg|webp)$/.test(file.type || '')); }

  function parseCode(text) {
    const s = String(text || '').trim();
    if (!s) throw new Error('연결 코드가 비어 있습니다');
    const hash = s.indexOf('#');
    const base = (hash < 0 ? s : s.slice(0, hash)).replace(/\/+$/, '');
    const token = hash < 0 ? '' : s.slice(hash + 1);
    let u;
    try { u = new URL(base); } catch (err) { throw new Error('연결 코드가 주소 형식이 아닙니다'); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('연결 코드는 http(s) 주소여야 합니다');
    return { url: u.origin + u.pathname.replace(/\/+$/, ''), token };
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
    });
  }
  function abortError() { const e = new Error('취소했습니다'); e.name = 'AbortError'; return e; }

  async function request(conn, path, opts) {
    opts = opts || {};
    const headers = Object.assign({}, opts.headers || {});
    if (conn.token) headers['X-Token'] = conn.token;
    let r;
    try { r = await fetch(conn.url + path, { method: opts.method || 'GET', headers, body: opts.body, signal: opts.signal, cache: 'no-store' }); }
    catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new Error('변환 서버에 연결할 수 없습니다 (Colab 셀이 멈췄거나 연결 코드가 바뀌었을 수 있습니다)');
    }
    if (opts.raw && r.ok) return r;
    let data = null;
    try { data = await r.json(); } catch (err) { /* not JSON */ }
    if (!r.ok) throw new Error((data && data.error) || ('변환 서버 오류 (HTTP ' + r.status + ')'));
    return data;
  }

  function health(conn, signal) { return request(conn, '/health', { signal }); }

  /** Human-readable stage from the job's log (see-through prints these). */
  function describe(job) {
    if (!job) return '';
    if (job.status === 'queued') return '차례를 기다리는 중';
    if (job.status === 'done') return '완료';
    if (job.status === 'error') return '실패';
    const log = (job.log || []).join('\n');
    const has = re => re.test(log);
    let stage = '준비 중';
    if (has(/Fetching|Downloading|download/i)) stage = '가중치 다운로드';
    if (has(/LayerDiff|layerdiff/) || job.step === 0 && job.percent > 0) stage = '파츠 생성 (LayerDiff)';
    if (has(/Marigold|marigold|depth/i) || job.step >= 1) stage = '깊이 추정 (Marigold)';
    if (has(/psd saved|optimiz|further/i)) stage = 'PSD 정리';
    return stage;
  }

  /**
   * Upload `file`, poll until the PSD is ready, download it.
   * onStatus(job, text) is called on every poll. Aborting cancels the job on the server.
   */
  async function convert(conn, file, o) {
    o = o || {};
    const signal = o.signal, onStatus = o.onStatus || function () {};
    if (!isImage(file)) throw new Error('PNG / JPG / WEBP 그림을 넣어 주세요');
    if (file.size > MAX_IMAGE_BYTES) throw new Error('그림은 40MB 이하로 넣어 주세요');
    onStatus({ status: 'uploading', percent: 0, step: 0, log: [] }, '그림 올리는 중');
    const { id } = await request(conn, '/jobs', {
      method: 'POST', body: file, signal,
      headers: Object.assign({ 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name || 'image.png') },
        o.resolution ? { 'X-Resolution': String(o.resolution) } : {}, o.prepare === false ? { 'X-Prepare': '0' } : {}, o.parts === 'body' ? { 'X-Parts': 'body' } : {})
    });
    const cancel = () => { request(conn, '/jobs/' + id, { method: 'DELETE' }).catch(() => {}); };
    if (signal) signal.addEventListener('abort', cancel, { once: true });
    try {
      let job, fails = 0;
      for (;;) {
        try { job = await request(conn, '/jobs/' + id, { signal }); fails = 0; }
        catch (err) { if (err.name === 'AbortError' || ++fails > 5) throw err; await sleep(2000, signal); continue; }
        onStatus(job, describe(job));
        if (job.status === 'done') break;
        if (job.status === 'error') throw new Error('see-through 변환 실패: ' + (job.error || '알 수 없는 오류') + ((job.log || []).length ? '\n' + job.log.slice(-3).join('\n') : ''));
        await sleep(job.status === 'queued' ? 2000 : 1500, signal);
      }
      onStatus(job, 'PSD 받는 중');
      const r = await request(conn, '/jobs/' + id + '/psd', { raw: true, signal });
      const psd = await r.arrayBuffer();
      let depth = null;
      if (job.has_depth) {
        try { depth = await (await request(conn, '/jobs/' + id + '/depth', { raw: true, signal })).arrayBuffer(); } catch (err) { /* optional */ }
      }
      return { psd, depth, name: job.name || 'model', job };
    } finally {
      if (signal) signal.removeEventListener('abort', cancel);
    }
  }

  return { parseCode, health, convert, describe, isImage, MAX_IMAGE_BYTES };
});
