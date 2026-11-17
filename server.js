'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const { spawn } = require('child_process');
const dns = require('dns').promises;
const net = require('net');
const path = require('path');
const { Readable } = require('stream');

const PORT = process.env.PORT || 3000;
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const MAX_JOBS = parseInt(process.env.MAX_JOBS, 10) || 4;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const ALLOWED = ['tiktok.com', 'douyin.com', 'instagram.com', 'facebook.com', 'fb.watch', 'x.com', 'twitter.com'];
const IMG_EXT = /^(jpe?g|png|webp|gif)$/i;

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use('/api', rateLimit({
  windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Bạn thao tác quá nhanh, hãy thử lại sau ít phút.' },
}));
app.get('/healthz', (req, res) => res.json({ ok: true }));

/* ---------- helpers ---------- */
function checkUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2000) return null;
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = u.hostname.toLowerCase();
  return ALLOWED.some(d => h === d || h.endsWith('.' + d)) ? u.href : null;
}

const safeName = (s, ext) =>
  (String(s || 'media').normalize('NFKD').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'media') + '.' + ext;

let jobs = 0;
function acquire(res) {
  if (jobs >= MAX_JOBS) { res.status(503).json({ error: 'Máy chủ đang bận, vui lòng thử lại sau ít giây.' }); return null; }
  jobs++;
  let done = false;
  return () => { if (!done) { done = true; jobs--; } };
}

function getInfo(url) {
  return new Promise((resolve, reject) => {
    const p = spawn(YTDLP, ['-J', '--no-warnings', '--socket-timeout', '15', '--', url], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => p.kill('SIGKILL'), 60_000);
    p.stdout.on('data', d => { out += d; if (out.length > 20e6) p.kill('SIGKILL'); });
    p.stderr.on('data', d => { err = (err + d).slice(-2000); });
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', code => {
      clearTimeout(t);
      if (code !== 0) return reject(new Error(err || 'yt-dlp exited ' + code));
      try { resolve(JSON.parse(out)); } catch { reject(new Error('Invalid JSON')); }
    });
  });
}

function buildItems(info) {
  const entries = Array.isArray(info.entries) ? info.entries.filter(Boolean) : [info];
  const items = [];
  entries.forEach((e, i) => {
    const byHeight = new Map();
    for (const f of e.formats || []) {
      if (!f.format_id || f.vcodec === 'none' || f.acodec === 'none') continue;   // cần có cả hình + tiếng
      if (/watermark/i.test(`${f.format_note || ''} ${f.format_id}`)) continue;     // bỏ bản có logo
      if (!/^[\w.\-+]{1,60}$/.test(f.format_id)) continue;
      const h = f.height || 0, cur = byHeight.get(h);
      if (!cur || (f.tbr || 0) > (cur.tbr || 0)) byHeight.set(h, f);
    }
    const videos = [...byHeight.entries()].sort((a, b) => b[0] - a[0])
      .map(([h, f]) => ({ id: f.format_id, label: h ? h + 'p' : 'chất lượng gốc' }));

    let image = null;
    const thumbs = (e.thumbnails || []).filter(t => t.url && /^https:/.test(t.url));
    const bestThumb = thumbs.sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0];
    const thumb = (bestThumb && bestThumb.url) || (/^https:/.test(e.thumbnail || '') ? e.thumbnail : null);
    if (!videos.length) {
      image = IMG_EXT.test(e.ext || '') && /^https:/.test(e.url || '') ? e.url : thumb;
      if (!image) return;
    }
    items.push({ index: i + 1, thumb: image || thumb, videos, image });
  });
  return items;
}

/* ---------- SSRF guard cho proxy ảnh ---------- */
const blocked = new net.BlockList();
[['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]]
  .forEach(([a, n]) => blocked.addSubnet(a, n, 'ipv4'));
[['::1', 128], ['fc00::', 7], ['fe80::', 10]].forEach(([a, n]) => blocked.addSubnet(a, n, 'ipv6'));
function isBlockedAddress(address, family) {
  if (family === 6) {
    const mapped = address.match(/^(?:::ffff:|0:0:0:0:0:ffff:)(.+)$/i);
    if (mapped) {
      if (net.isIP(mapped[1]) === 4) return blocked.check(mapped[1], 'ipv4');
      const groups = mapped[1].split(':');
      if (groups.length === 2 && groups.every(g => /^[\da-f]{1,4}$/i.test(g))) {
        const high = parseInt(groups[0], 16), low = parseInt(groups[1], 16);
        return blocked.check([high >>> 8, high & 255, low >>> 8, low & 255].join('.'), 'ipv4');
      }
    }
  }
  return blocked.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

// CDN của chính các nền tảng được tin cậy: bỏ qua kiểm tra IP để không bị chặn nhầm
// khi máy dùng VPN / proxy "fake-IP" / DNS lạ.
const TRUSTED_CDN = ['tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com', 'tiktokv.com', 'tiktokv.us',
  'byteimg.com', 'ibyteimg.com', 'muscdn.com', 'douyinpic.com', 'cdninstagram.com', 'fbcdn.net', 'twimg.com'];
const isTrustedCdn = h => TRUSTED_CDN.some(d => h === d || h.endsWith('.' + d));

async function isSafeHost(host) {
  host = host.toLowerCase();
  if (net.isIP(host)) return false;
  if (isTrustedCdn(host)) return true;
  const addrs = await dns.lookup(host, { all: true });
  const ok = addrs.length > 0 && addrs.every(a => !isBlockedAddress(a.address, a.family));
  if (!ok) console.warn('[img] blocked host', host, addrs.map(a => a.address).join(','));
  return ok;
}

/* ---------- API ---------- */
app.post('/api/info', async (req, res) => {
  const url = checkUrl(req.body && req.body.url);
  if (!url) return res.status(400).json({ error: 'Liên kết không hợp lệ hoặc nền tảng chưa được hỗ trợ.' });
  const release = acquire(res);
  if (!release) return;
  try {
    const info = await getInfo(url);
    const items = buildItems(info);
    if (!items.length) throw new Error('no items');
    res.json({ url, title: info.title || 'media', multi: Array.isArray(info.entries), items });
  } catch (e) {
    console.error('[info]', e.message);
    res.status(422).json({ error: 'Không lấy được nội dung. Bài đăng có thể ở chế độ riêng tư, đã bị xóa hoặc yêu cầu đăng nhập.' });
  } finally { release(); }
});

app.get('/api/download', (req, res) => {
  const url = checkUrl(req.query.url);
  const fmt = String(req.query.format || '');
  const idx = parseInt(req.query.index, 10);
  if (!url || !/^[\w.\-+]{1,60}$/.test(fmt)) return res.status(400).json({ error: 'Yêu cầu không hợp lệ.' });
  const release = acquire(res);
  if (!release) return;

  const args = ['-f', fmt, '--no-warnings', '--no-part', '--socket-timeout', '15', '-o', '-'];
  if (idx > 0 && idx <= 100) args.push('--playlist-items', String(idx));
  args.push('--', url);

  const p = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => p.kill('SIGKILL'), 5 * 60_000);
  let started = false;
  p.stderr.on('data', d => console.error('[dl]', String(d).slice(0, 300)));
  p.stdout.on('data', chunk => {
    if (!started) {
      started = true;
      res.set({ 'Content-Type': 'video/mp4', 'Content-Disposition': `attachment; filename="${safeName(req.query.name, 'mp4')}"`, 'Cache-Control': 'no-store' });
    }
    if (!res.write(chunk)) { p.stdout.pause(); res.once('drain', () => p.stdout.resume()); }
  });
  res.on('close', () => p.kill('SIGKILL'));            // khách hủy tải → dừng tiến trình
  p.on('error', e => {
    clearTimeout(timer); release(); console.error('[dl]', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Máy chủ chưa cài yt-dlp.' });
  });
  p.on('close', code => {
    clearTimeout(timer); release();
    if (!started) { if (!res.headersSent) res.status(502).json({ error: 'Tải thất bại, vui lòng thử lại.' }); return; }
    if (res.writableEnded || res.destroyed) return;
    code === 0 ? res.end() : res.destroy();
  });
});

app.get('/api/image', async (req, res) => {
  let u;
  try { u = new URL(String(req.query.url)); } catch { return res.status(400).json({ error: 'URL ảnh không hợp lệ.' }); }
  if (u.protocol !== 'https:') return res.status(400).json({ error: 'URL ảnh không hợp lệ.' });
  try {
    if (!(await isSafeHost(u.hostname))) return res.status(400).json({ error: 'URL ảnh không được phép.' });
    const r = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'Mozilla/5.0' } });
    const type = (r.headers.get('content-type') || '').toLowerCase();
    if (!r.ok || !r.body || !/^image\/(jpeg|png|webp|gif)/.test(type)) return res.status(502).json({ error: 'Không tải được ảnh.' });
    if ((parseInt(r.headers.get('content-length'), 10) || 0) > MAX_IMAGE_BYTES) return res.status(413).json({ error: 'Ảnh quá lớn.' });
    const ext = type.split('/')[1].split(/[;+]/)[0].replace('jpeg', 'jpg');
    const disp = req.query.inline === '1' ? 'inline' : 'attachment';
    res.set({ 'Content-Type': type.split(';')[0], 'Content-Disposition': `${disp}; filename="${safeName(req.query.name, ext)}"`, 'Cache-Control': 'private, max-age=600' });
    let size = 0;
    const src = Readable.fromWeb(r.body);
    src.on('data', c => { size += c.length; if (size > MAX_IMAGE_BYTES) src.destroy(); });
    src.on('error', () => res.destroy());
    res.on('close', () => src.destroy());
    src.pipe(res);
  } catch (e) {
    console.error('[img]', e.message);
    if (!res.headersSent) res.status(502).json({ error: 'Không tải được ảnh.' }); else res.destroy();
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {                       // JSON hỏng, v.v.
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: 'Yêu cầu không hợp lệ.' });
});

const server = app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));