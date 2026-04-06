import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import archiver from 'archiver';
import puppeteer from 'puppeteer';
import { v4 as uuidv4 } from 'uuid';
import dns from 'dns/promises';
import { URL } from 'url';
import pLimit from 'p-limit';
import * as cheerio from 'cheerio';
import mimeTypes from 'mime-types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const jobs = new Map();
const sseClients = new Map();

const rateMap = new Map();
const MAX_CONCURRENT = 3;
let activeJobs = 0;

function checkRate(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now > entry.reset) {
    rateMap.set(ip, { count: 1, reset: now + 60000 });
    return true;
  }
  entry.count++;
  return entry.count <= 5;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateMap) {
    if (now > entry.reset) rateMap.delete(ip);
  }
}, 120000);

function isPrivateIP(ip) {
  return /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|0\.0\.0\.|169\.254\.|::1$|fc00:|fe80:|::ffff:127\.|::ffff:10\.|::ffff:192\.168\.|::ffff:172\.(1[6-9]|2\d|3[01])\.)/i.test(ip);
}

async function validateUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error('Invalid URL format.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP/HTTPS URLs are allowed.');
  if (/localhost/i.test(parsed.hostname)) throw new Error('Access to private networks is not allowed.');
  let records;
  try { records = await dns.lookup(parsed.hostname, { all: true }); }
  catch { throw new Error(`Cannot resolve hostname: ${parsed.hostname}`); }
  for (const { address } of records) {
    if (isPrivateIP(address)) throw new Error('Access to private/internal networks is not allowed.');
  }
  return parsed.href;
}

function sendSSE(jobId, payload) {
  const client = sseClients.get(jobId);
  if (client) client.write(`data: ${JSON.stringify(payload)}\n\n`);
}

app.get('/api/progress/:jobId', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const { jobId } = req.params;
  sseClients.set(jobId, res);
  const heartbeat = setInterval(() => {
    try { res.write(':heartbeat\n\n'); } catch { clearInterval(heartbeat); }
  }, 15000);
  const job = jobs.get(jobId);
  if (job?.status === 'done')
    sendSSE(jobId, { type: 'done', jobId, files: job.files ?? 0, size: job.sizeMB ?? '0.00', tree: job.tree ?? null });
  else if (job?.status === 'error')
    sendSSE(jobId, { type: 'error', msg: job.errorMsg ?? 'Unknown error' });
  req.on('close', () => { clearInterval(heartbeat); sseClients.delete(jobId); });
});

app.post('/api/download', async (req, res) => {
  const clientIp = req.ip || req.socket.remoteAddress;
  if (!checkRate(clientIp)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
  }
  if (activeJobs >= MAX_CONCURRENT) {
    return res.status(503).json({ error: 'Server is busy. Please try again shortly.' });
  }
  const { url, maxDepth } = req.body ?? {};
  if (!url) return res.status(400).json({ error: 'URL is required.' });
  const depth = Math.min(Math.max(parseInt(maxDepth) || 2, 1), 5);
  let validUrl;
  try { validUrl = await validateUrl(url); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  const jobId = uuidv4();
  const tmpDir = path.join(os.tmpdir(), `siterip-${jobId}`);
  jobs.set(jobId, { status: 'running', tmpDir, url: validUrl, created: Date.now() });
  res.json({ jobId });
  setImmediate(() => runDownload(jobId, validUrl, tmpDir, depth));
});

app.get('/api/get/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== 'done' || !job.zipPath)
    return res.status(404).json({ error: 'Job not found or not ready.' });
  let safeName;
  try { safeName = new URL(job.url).hostname.replace(/[^a-z0-9._-]/gi, '_') + '.zip'; }
  catch { safeName = 'site.zip'; }
  res.download(job.zipPath, safeName, err => {
    if (!err) setTimeout(() => cleanup(req.params.jobId), 10_000);
  });
});

/** Return file tree for a finished job */
app.get('/api/tree/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== 'done' || !job.tree)
    return res.status(404).json({ error: 'Job not found or not ready.' });
  res.json(job.tree);
});

/** Download a single file from a finished job */
app.get('/api/file/:jobId/*', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== 'done' || !job.siteDir)
    return res.status(404).json({ error: 'Job not found or not ready.' });
  const rel  = req.params[0] ?? '';
  const safe = path.normalize(path.join(job.siteDir, rel));
  if (!safe.startsWith(job.siteDir)) return res.status(403).end();
  if (!fs.existsSync(safe) || !fs.statSync(safe).isFile())
    return res.status(404).json({ error: 'File not found.' });
  res.download(safe, path.basename(safe));
});

/** Download a sub-folder as ZIP */
app.get('/api/folder/:jobId/*', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== 'done' || !job.siteDir)
    return res.status(404).json({ error: 'Job not found or not ready.' });
  const rel  = req.params[0] ?? '';
  const safe = rel ? path.normalize(path.join(job.siteDir, rel)) : job.siteDir;
  if (!safe.startsWith(job.siteDir)) return res.status(403).end();
  if (!fs.existsSync(safe) || !fs.statSync(safe).isDirectory())
    return res.status(404).json({ error: 'Folder not found.' });
  const folderName = path.basename(safe) || 'site';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${folderName}.zip"`);
  const arc = archiver('zip', { zlib: { level: 6 } });
  arc.on('error', () => res.end());
  arc.pipe(res);
  arc.directory(safe, false);
  arc.finalize();
});

/** Build a JSON file-tree from a directory */
function buildTree(rootDir, dir) {
  const name    = path.basename(dir) || 'site';
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const children = [];
  for (const e of entries.sort((a, b) => {
    // folders first, then alphabetical
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  })) {
    const full = path.join(dir, e.name);
    const rel  = path.relative(rootDir, full).replace(/\\/g, '/');
    if (e.isDirectory()) {
      children.push({ type: 'dir', name: e.name, path: rel, children: buildTree(rootDir, full).children });
    } else {
      const size = fs.statSync(full).size;
      const ext  = path.extname(e.name).toLowerCase().slice(1);
      children.push({ type: 'file', name: e.name, path: rel, size, ext });
    }
  }
  return { type: 'dir', name, path: path.relative(rootDir, dir).replace(/\\/g, '/') || '.', children };
}

function cleanup(jobId) {
  const job = jobs.get(jobId);
  if (job?.tmpDir) fs.rmSync(job.tmpDir, { recursive: true, force: true });
  jobs.delete(jobId);
}

const CT_EXT = {
  'text/html': '.html', 'text/css': '.css',
  'text/javascript': '.js', 'application/javascript': '.js',
  'application/x-javascript': '.js', 'module/javascript': '.js',
  'application/json': '.json', 'application/manifest+json': '.json',
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/avif': '.avif', 'image/svg+xml': '.svg',
  'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico', 'image/bmp': '.bmp',
  'font/woff': '.woff', 'font/woff2': '.woff2', 'font/ttf': '.ttf', 'font/otf': '.otf',
  'application/font-woff': '.woff', 'application/font-woff2': '.woff2',
  'application/x-font-woff': '.woff', 'application/x-font-ttf': '.ttf',
  'application/vnd.ms-fontobject': '.eot',
  'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav',
  'video/mp4': '.mp4', 'video/webm': '.webm',
  'application/pdf': '.pdf', 'application/xml': '.xml', 'text/xml': '.xml',
  'text/plain': '.txt', 'text/vtt': '.vtt',
};

async function runDownload(jobId, url, tmpDir, depth) {
  activeJobs++;
  const siteDir = path.join(tmpDir, 'site');
  fs.mkdirSync(siteDir, { recursive: true });
  let browser;
  try {
    sendSSE(jobId, { type: 'log', msg: `Target: ${url}` });
    sendSSE(jobId, { type: 'log', msg: `Crawl depth: ${depth}` });
    sendSSE(jobId, { type: 'log', msg: 'Launching headless Chromium...' });
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-site-isolation-trials',
        '--ignore-certificate-errors',
        '--disable-dev-shm-usage',
        '--no-first-run', '--no-default-browser-check',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080',
      ],
    });
    sendSSE(jobId, { type: 'log', msg: 'Browser ready. Starting crawl...' });
    const crawler = new SiteCrawler(browser, url, siteDir, depth, msg => sendSSE(jobId, msg));
    await crawler.crawl();
    const fileCount = crawler.fileCount;
    sendSSE(jobId, { type: 'log', msg: `All done - ${fileCount} files on disk. Packaging...` });
    sendSSE(jobId, { type: 'zip', msg: 'Creating ZIP archive...' });
    const zipPath = path.join(tmpDir, 'site.zip');
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(zipPath);
      const arc = archiver('zip', { zlib: { level: 6 } });
      out.on('close', resolve);
      arc.on('error', reject);
      arc.pipe(out);
      arc.directory(siteDir, false);
      arc.finalize();
    });
    const sizeMB = (fs.statSync(zipPath).size / 1_048_576).toFixed(2);
    const tree = buildTree(siteDir, siteDir);
    Object.assign(jobs.get(jobId), { status: 'done', zipPath, files: fileCount, sizeMB, siteDir, tree });
    sendSSE(jobId, { type: 'done', jobId, files: fileCount, size: sizeMB, tree });
  } catch (err) {
    const msg = err?.message ?? String(err);
    Object.assign(jobs.get(jobId), { status: 'error', errorMsg: msg });
    sendSSE(jobId, { type: 'error', msg });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } finally {
    activeJobs--;
    if (browser) await browser.close().catch(() => {});
  }
}

class SiteCrawler {
  constructor(browser, startUrl, outDir, maxDepth, notify) {
    this.browser  = browser;
    this.startUrl = new URL(startUrl);
    this.origin   = this.startUrl.origin;
    this.outDir   = outDir;
    this.maxDepth = maxDepth;
    this.notify   = notify;
    this.assets   = new Map();
    this.visited  = new Set();
    this.fileCount = 0;
    this.limit = pLimit(4);
  }

  async crawl() {
    let wave = [this.startUrl.href];
    for (let d = 0; d <= this.maxDepth && wave.length > 0; d++) {
      this.notify({ type: 'log', msg: `Depth ${d}: processing ${wave.length} page(s)...` });
      const tasks = wave.map(u =>
        this.limit(async () => {
          if (this.visited.has(u)) return [];
          this.visited.add(u);
          return await this._crawlPage(u, d);
        })
      );
      const results  = await Promise.all(tasks);
      const nextWave = [];
      for (const links of results)
        for (const link of links)
          if (!this.visited.has(link) && !nextWave.includes(link)) nextWave.push(link);
      wave = nextWave;
    }
    this.notify({ type: 'log', msg: `Crawl complete. ${this.assets.size} assets captured.` });
    this.notify({ type: 'log', msg: 'Discovering common server paths...' });
    await this._discoverCommonPaths();
    this.notify({ type: 'log', msg: 'Checking for source maps...' });
    await this._fetchSourceMaps();
    this.notify({ type: 'log', msg: `Total assets: ${this.assets.size}. Rewriting and saving...` });
    await this._saveAll();
  }

  async _crawlPage(url, depth) {
    const page = await this.browser.newPage();
    const discovered = [];
    try {
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      );
      await page.setRequestInterception(true);
      page.on('request', req => req.continue().catch(() => {}));
      const captured = new Map();
      page.on('response', async response => {
        const rurl = response.url();
        if (rurl.startsWith('data:') || this.assets.has(rurl) || captured.has(rurl)) return;
        try {
          const status = response.status();
          if (status < 200 || status >= 400) return;
          const ct = (response.headers()['content-type'] ?? '').split(';')[0].trim().toLowerCase();
          if (!ct || ct === 'text/event-stream') return;
          const buf = await response.buffer();
          captured.set(rurl, { buffer: buf, contentType: ct });
        } catch { /* stream/disposed */ }
      });
      this.notify({ type: 'log', msg: `  -> Rendering: ${url}` });
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 90_000 });
      await this._autoScroll(page);
      await new Promise(r => setTimeout(r, 1_500));
      const html = await page.content();
      this.assets.set(url, { buffer: Buffer.from(html, 'utf8'), contentType: 'text/html', isPage: true });
      for (const [u, a] of captured)
        if (!this.assets.has(u)) this.assets.set(u, a);
      this.notify({ type: 'file', count: this.assets.size, name: new URL(url).pathname || '/' });
      if (depth < this.maxDepth) {
        const hrefs = await page.evaluate(origin =>
          [...document.querySelectorAll('a[href]')].flatMap(a => {
            try { const u = new URL(a.href); u.hash = ''; return u.origin === origin ? [u.href] : []; }
            catch { return []; }
          }),
          this.origin
        );
        for (const h of [...new Set(hrefs)])
          if (!this.visited.has(h)) discovered.push(h);
      }
    } catch (err) {
      this.notify({ type: 'warn', msg: `  x ${url} - ${err.message}` });
    } finally {
      await page.close().catch(() => {});
    }
    return discovered;
  }

  async _autoScroll(page) {
    try {
      await page.evaluate(async () => {
        await new Promise(resolve => {
          let pos = 0;
          const timer = setInterval(() => {
            const max = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, 5000);
            pos = Math.min(pos + 900, max);
            window.scrollTo(0, pos);
            if (pos >= max) { clearInterval(timer); window.scrollTo(0, 0); resolve(); }
          }, 120);
          setTimeout(() => { clearInterval(timer); resolve(); }, 12_000);
        });
      });
    } catch { /* page closed */ }
  }

  _urlToLocalPath(urlStr, contentType, isPage) {
    try {
      const u = new URL(urlStr);
      const same   = u.origin === this.origin;
      const prefix = same ? '' : path.join('_cdn', u.hostname);
      let p = u.pathname;
      try { p = decodeURIComponent(p); } catch {}
      p = p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\.\.\//g, '') || '/';
      const lastSeg = p.split('/').pop() ?? '';
      const dotIdx  = lastSeg.lastIndexOf('.');
      const hasExt  = dotIdx > 0 && dotIdx < lastSeg.length - 1;
      let local;
      if (isPage) {
        if (hasExt && (contentType === 'text/html' || /\.html?$/.test(p))) {
          local = path.join(prefix, p.slice(1));
        } else {
          const stripped = p.replace(/\/$/, '') || '';
          local = stripped ? path.join(prefix, stripped.slice(1), 'index.html') : path.join(prefix, 'index.html');
        }
      } else if (!hasExt) {
        local = path.join(prefix, p.slice(1) + this._ctToExt(contentType));
      } else {
        local = path.join(prefix, p.slice(1));
      }
      if (u.search) {
        const h   = Buffer.from(u.search).toString('base64').replace(/[^a-z0-9]/gi, '').slice(0, 8);
        const ext = path.extname(local);
        local     = local.slice(0, local.length - ext.length) + `.${h}` + ext;
      }
      return path.normalize(local).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^[/\\]+/, '') || 'index.html';
    } catch {
      return `_asset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }
  }

  _ctToExt(ct) {
    if (!ct) return '';
    const base = ct.split(';')[0].trim().toLowerCase();
    if (CT_EXT[base]) return CT_EXT[base];
    const ext = mimeTypes.extension(base);
    return ext ? '.' + ext : '';
  }

  async _discoverCommonPaths() {
    const paths = [
      '/robots.txt', '/sitemap.xml', '/sitemap_index.xml',
      '/manifest.json', '/manifest.webmanifest',
      '/favicon.ico', '/favicon.svg',
      '/browserconfig.xml', '/crossdomain.xml',
      '/.well-known/security.txt', '/humans.txt',
    ];
    const page = await this.browser.newPage();
    try {
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      );
      for (const p of paths) {
        const fullUrl = this.origin + p;
        if (this.assets.has(fullUrl)) continue;
        try {
          const resp = await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
          if (resp && resp.status() >= 200 && resp.status() < 400) {
            const ct = (resp.headers()['content-type'] ?? '').split(';')[0].trim().toLowerCase();
            if (ct && ct !== 'text/html') {
              const buf = await resp.buffer();
              if (buf.length > 0 && buf.length < 5_000_000) {
                this.assets.set(fullUrl, { buffer: buf, contentType: ct });
                this.notify({ type: 'log', msg: `  + Found: ${p}` });
              }
            }
          }
        } catch { /* not available */ }
      }
    } finally {
      await page.close().catch(() => {});
    }
  }

  async _fetchSourceMaps() {
    const maps = [];
    for (const [url, asset] of this.assets) {
      const ct = asset.contentType;
      if (ct !== 'text/css' && !ct.includes('javascript')) continue;
      try {
        const content = asset.buffer.toString('utf8').slice(-500);
        const match = content.match(/\/[/*]#\s*sourceMappingURL=(\S+)/);
        if (!match || match[1].startsWith('data:')) continue;
        const mapUrl = new URL(match[1], url).href;
        if (!this.assets.has(mapUrl)) maps.push(mapUrl);
      } catch { /* skip */ }
    }
    if (maps.length === 0) return;
    const page = await this.browser.newPage();
    try {
      for (const mapUrl of maps) {
        try {
          const resp = await page.goto(mapUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
          if (resp && resp.status() >= 200 && resp.status() < 400) {
            const buf = await resp.buffer();
            if (buf.length > 0 && buf.length < 10_000_000) {
              this.assets.set(mapUrl, { buffer: buf, contentType: 'application/json' });
              this.notify({ type: 'log', msg: `  + Source map: ${new URL(mapUrl).pathname}` });
            }
          }
        } catch { /* not available */ }
      }
    } finally {
      await page.close().catch(() => {});
    }
  }

  async _saveAll() {
    const u2p = new Map();
    for (const [url, asset] of this.assets)
      u2p.set(url, this._urlToLocalPath(url, asset.contentType, asset.isPage ?? false));

    for (const [url, asset] of this.assets) {
      const localPath = u2p.get(url);
      if (!localPath) continue;
      const full = path.join(this.outDir, localPath);
      try {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        let buf = asset.buffer;
        const ct = asset.contentType;
        if (ct === 'text/html')
          buf = Buffer.from(this._rewriteHtml(buf.toString('utf8'), url, u2p, localPath), 'utf8');
        else if (ct === 'text/css')
          buf = Buffer.from(this._rewriteCss(buf.toString('utf8'), url, u2p, localPath), 'utf8');
        if (!fs.existsSync(full)) {
          fs.writeFileSync(full, buf);
          this.fileCount++;
          this.notify({ type: 'file', count: this.fileCount, name: localPath });
        }
      } catch (err) {
        this.notify({ type: 'warn', msg: `  Could not write ${localPath}: ${err.message}` });
      }
    }
    this._writeServerScript();
    this._writeReadme();
  }

  _rewriteHtml(html, pageUrl, u2p, localPath) {
    const $   = cheerio.load(html, { decodeEntities: false });
    const dir = path.dirname(localPath).replace(/\\/g, '/');
    const rw = raw => {
      if (!raw) return raw;
      const s = raw.trim();
      if (!s || /^(data:|#|javascript:|mailto:|tel:|blob:|about:)/i.test(s)) return raw;
      try {
        const abs = new URL(s, pageUrl).href;
        const lp  = u2p.get(abs);
        return lp ? this._rel(dir, lp) : raw;
      } catch { return raw; }
    };
    const rwAttr = (sel, attr) => $(sel).each((_, el) => {
      const v = $(el).attr(attr);
      if (v != null) $(el).attr(attr, rw(v));
    });
    rwAttr('script[src]', 'src');
    rwAttr('link[rel="stylesheet"]', 'href');
    rwAttr('link[rel="preload"]', 'href');
    rwAttr('link[rel="prefetch"]', 'href');
    rwAttr('link[rel="modulepreload"]', 'href');
    rwAttr('link[rel="icon"]', 'href');
    rwAttr('link[rel="shortcut icon"]', 'href');
    rwAttr('link[rel="apple-touch-icon"]', 'href');
    rwAttr('link[rel="manifest"]', 'href');
    rwAttr('link[rel="alternate"]', 'href');
    rwAttr('img', 'src');
    rwAttr('img', 'data-src');
    rwAttr('img', 'data-lazy-src');
    rwAttr('img', 'data-original');
    rwAttr('source', 'src');
    rwAttr('source', 'data-src');
    rwAttr('video', 'src');
    rwAttr('video', 'poster');
    rwAttr('audio', 'src');
    rwAttr('iframe', 'src');
    rwAttr('a', 'href');
    rwAttr('use', 'href');
    rwAttr('use', 'xlink:href');
    rwAttr('image', 'href');
    rwAttr('image', 'xlink:href');
    rwAttr('meta[property="og:image"]', 'content');
    rwAttr('meta[name="twitter:image"]', 'content');
    $('[srcset]').each((_, el) => {
      const srcset = $(el).attr('srcset') ?? '';
      const rewritten = srcset.split(',').map(part => {
        const m = part.trim().match(/^(\S+)(\s.*)?$/);
        return m ? rw(m[1]) + (m[2] ?? '') : part;
      }).join(', ');
      $(el).attr('srcset', rewritten);
    });
    $('style').each((_, el) => {
      const css = $(el).html();
      if (css) $(el).html(this._rewriteCssUrls(css, pageUrl, u2p, dir));
    });
    $('[style]').each((_, el) => {
      const s = $(el).attr('style');
      if (s) $(el).attr('style', this._rewriteCssUrls(s, pageUrl, u2p, dir));
    });
    $('head base').remove();
    return $.html();
  }

  _rewriteCss(css, pageUrl, u2p, localPath) {
    return this._rewriteCssUrls(css, pageUrl, u2p, path.dirname(localPath).replace(/\\/g, '/'));
  }

  _rewriteCssUrls(css, baseUrl, u2p, dir) {
    return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, q, raw) => {
      if (!raw || /^(data:|#)/i.test(raw)) return match;
      try {
        const abs = new URL(raw, baseUrl).href;
        const lp  = u2p.get(abs);
        if (lp) return `url(${q}${this._rel(dir, lp)}${q})`;
      } catch {}
      return match;
    });
  }

  _rel(fromDir, toPath) {
    const to   = toPath.replace(/\\/g, '/');
    const from = fromDir.replace(/\\/g, '/');
    if (!from || from === '.') return to.startsWith('./') ? to : './' + to;
    const r = path.relative(from, to).replace(/\\/g, '/');
    return r.startsWith('.') ? r : './' + r;
  }

  _writeServerScript() {
    const lines = [
      '#!/usr/bin/env node',
      '// Offline site server - run: node serve.js',
      '// Then open http://localhost:8080 in your browser',
      "import http from 'http';",
      "import fs from 'fs';",
      "import path from 'path';",
      "import { fileURLToPath } from 'url';",
      "const ROOT = path.dirname(fileURLToPath(import.meta.url));",
      'const PORT = process.env.PORT || 8080;',
      'const MIME = {',
      "  '.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8',",
      "  '.css':'text/css','.js':'application/javascript','.mjs':'application/javascript',",
      "  '.json':'application/json','.xml':'application/xml','.txt':'text/plain',",
      "  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',",
      "  '.gif':'image/gif','.webp':'image/webp','.avif':'image/avif',",
      "  '.svg':'image/svg+xml','.ico':'image/x-icon','.bmp':'image/bmp',",
      "  '.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf',",
      "  '.mp3':'audio/mpeg','.ogg':'audio/ogg','.wav':'audio/wav',",
      "  '.mp4':'video/mp4','.webm':'video/webm','.pdf':'application/pdf',",
      '};',
      'http.createServer((req, res) => {',
      "  let p = decodeURIComponent(req.url.split('?')[0]);",
      "  if (!p || p === '/') p = '/index.html';",
      "  if (p.endsWith('/')) p += 'index.html';",
      '  const safe = path.normalize(path.join(ROOT, p));',
      '  if (!safe.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }',
      '  let file = safe;',
      '  if (!fs.existsSync(file)) {',
      "    const ext = path.extname(safe);",
      "    file = ext ? path.join(ROOT, 'index.html') : path.join(safe, 'index.html');",
      '  }',
      "  if (!fs.existsSync(file)) file = path.join(ROOT, 'index.html');",
      "  if (!fs.existsSync(file)) { res.writeHead(404); res.end('Not found'); return; }",
      "  const ct = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';",
      "  res.writeHead(200, { 'Content-Type': ct });",
      '  fs.createReadStream(file).pipe(res);',
      "}).listen(PORT, '127.0.0.1', () =>",
      "  process.stdout.write('\\n  Offline site -> http://localhost:' + PORT + '\\n\\n')",
      ');',
    ];
    fs.writeFileSync(path.join(this.outDir, 'serve.js'), lines.join('\n'));
    this.fileCount++;
    this.notify({ type: 'file', count: this.fileCount, name: 'serve.js' });
  }

  _writeReadme() {
    const md = [
      '# Downloaded Website',
      '',
      '## View offline',
      '',
      '**Requires Node.js 18+**',
      '',
      '### Option 1 - Node.js server *(recommended)*',
      '```bash',
      'node serve.js',
      '```',
      'Then open **http://localhost:8080** in your browser.',
      '',
      '### Option 2 - Python',
      '```bash',
      'python -m http.server 8080',
      '```',
      '',
      '### Option 3 - npx serve',
      '```bash',
      'npx serve . -p 8080',
      '```',
      '',
      '> **Note:** Dynamic features (login, APIs, server-side rendering) will not work offline.',
    ].join('\n');
    fs.writeFileSync(path.join(this.outDir, 'README.md'), md);
  }
}

setInterval(() => {
  const cut = Date.now() - 3_600_000;
  for (const [id, job] of jobs) if (job.created < cut) cleanup(id);
}, 1_800_000);

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`\n  SiteRip v2 running -> http://localhost:${PORT}\n`));