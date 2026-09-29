import fs from 'fs';
import path from 'path';
import pLimit from 'p-limit';
import { BrowserManager } from './browser.js';
import { PageCapture, type CapturedResponse } from './capture.js';
import { rewriteHtml, rewriteCssUrls } from './rewrite.js';
import { urlToLocalPath } from '../util/paths.js';
import { fetchCommonPaths, discoverFromSitemaps } from './discover.js';
import { isPublicHost, safeFetch } from './fetchsafe.js';
import { writeOfflineFiles, swRegisterSnippet } from './offline.js';
import type { AssetMeta, CrawlOptions, Notify } from '../types.js';

const MAX_RSS_BYTES = 512 * 1024 * 1024;

/**
 * Crawls a site with headless Chromium: renders pages in parallel,
 * passively captures every network response via CDP, rewrites links,
 * and writes a self-contained offline copy (with service worker) to outDir.
 */
export class Crawler {
  private origin: string;
  private assets = new Map<string, AssetMeta>();
  private seen = new Set<string>();
  private visited = new Set<string>();
  private fileCount = 0;
  private pagesRendered = 0;
  private limitHit = false;
  private memWarned = false;
  private stageDir: string;
  private stageIdx = 0;
  private totalBytes = 0;
  private browser: BrowserManager;
  private pending = new Set<Promise<void>>();
  private aborted = false;

  constructor(
    private startUrl: URL,
    private outDir: string,
    private opts: CrawlOptions,
    private notify: Notify,
  ) {
    this.origin = startUrl.origin;
    this.stageDir = path.join(outDir, '..', '_stage');
    fs.mkdirSync(this.stageDir, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    this.browser = new BrowserManager(40, notify);
  }

  // ---------------- staging ----------------

  private stage(
    url: string,
    buf: Buffer,
    contentType: string,
    isPage = false,
    resourceType = 'other',
    method = 'GET',
  ): boolean {
    if (this.assets.has(url)) return false;
    if (this.assets.size >= this.opts.maxAssets ||
        this.totalBytes + buf.length > this.opts.maxTotalBytes) {
      if (!this.limitHit) {
        this.limitHit = true;
        this.notify({ type: 'warn', msg: 'Size/asset limit reached. Skipping further assets.' });
      }
      return false;
    }
    const stagePath = path.join(this.stageDir, String(this.stageIdx++));
    fs.writeFileSync(stagePath, buf);
    this.totalBytes += buf.length;
    this.assets.set(url, { stagePath, contentType, isPage, size: buf.length, method, resourceType });
    return true;
  }

  /** Stage a network-captured asset after validating its host isn't internal. */
  private stageCaptured(res: CapturedResponse): void {
    if (this.seen.has(res.url)) return;
    this.seen.add(res.url);
    // Tracked so saveAll() can't race ahead and orphan staged files —
    // an un-awaited rejection here could take down the whole process.
    const task = (async () => {
      let host: string;
      try { host = new URL(res.url).hostname; } catch { return; }
      if (!(await isPublicHost(host))) {
        this.notify({ type: 'warn', msg: `  x Blocked internal host: ${host}` });
        return;
      }
      this.stage(res.url, res.body, res.contentType, false, res.resourceType, res.method);
    })().catch(() => {});
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
  }

  /** Wait for in-flight host validations / staging writes to settle. */
  private async drainPending(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** Stop the crawl. Closes the browser so in-flight navigations fail fast. */
  abort(): void {
    this.aborted = true;
    void this.browser.close();
  }

  private memoryOk(): boolean {
    try {
      const rss = process.memoryUsage.rss();
      if (rss > MAX_RSS_BYTES) {
        if (!this.memWarned) {
          this.memWarned = true;
          this.notify({
            type: 'warn',
            msg: `Memory pressure (${(rss / 1048576).toFixed(0)} MB). Limiting crawl.`,
          });
        }
        return false;
      }
    } catch { /* non-fatal */ }
    return true;
  }

  // ---------------- crawl ----------------

  async crawl(): Promise<void> {
    try {
      await this.crawlInternal();
    } finally {
      // Always release Chromium — a throw mid-crawl must not leak the process.
      await this.browser.close();
    }
  }

  private async crawlInternal(): Promise<void> {
    this.notify({ type: 'log', msg: `Target: ${this.startUrl.href}` });
    this.notify({ type: 'log', msg: `Depth ${this.opts.maxDepth} | concurrency ${this.opts.concurrency}` });

    // Sitemap discovery runs over plain HTTP in parallel with browser warmup.
    let seed = [this.startUrl.href];
    if (this.opts.followSitemaps) {
      const smUrls = await discoverFromSitemaps(this.origin).catch(() => [] as string[]);
      if (smUrls.length) {
        this.notify({ type: 'log', msg: `Sitemap: ${smUrls.length} URL(s) discovered.` });
        seed = [...new Set([...seed, ...smUrls])];
      }
    }

    const limit = pLimit(this.opts.concurrency);
    let wave = seed;

    for (let d = 0; d <= this.opts.maxDepth && wave.length > 0 && !this.aborted; d++) {
      if (this.limitHit || !this.memoryOk()) break;
      const fresh = wave.filter(u => !this.visited.has(u));
      if (!fresh.length) break;
      this.notify({ type: 'phase', phase: `crawl:${d}` });
      this.notify({ type: 'log', msg: `Depth ${d}: ${fresh.length} page(s)...` });

      const results = await Promise.all(
        fresh.map(u =>
          limit(async () => {
            if (this.aborted) return [] as string[];
            if (this.visited.has(u)) return [] as string[];
            if (this.pagesRendered >= this.opts.maxPages) {
              if (!this.limitHit) {
                this.limitHit = true;
                this.notify({ type: 'warn', msg: `Page limit reached (${this.opts.maxPages}).` });
              }
              return [] as string[];
            }
            if (!this.memoryOk()) return [] as string[];
            this.visited.add(u);
            return this.crawlPage(u, d);
          }),
        ),
      );

      const next: string[] = [];
      for (const links of results)
        for (const l of links)
          if (!this.visited.has(l) && !next.includes(l)) next.push(l);
      wave = next;
    }

    this.notify({
      type: 'log',
      msg: `Crawl done: ${this.pagesRendered} pages, ${this.assets.size} assets.`,
    });

    await this.drainPending();

    if (!this.limitHit && !this.aborted) {
      this.notify({ type: 'phase', phase: 'extras' });
      await fetchCommonPaths(
        this.origin,
        u => this.assets.has(u) || this.seen.has(u),
        (u, b, ct) => this.stage(u, b, ct),
        m => this.notify({ type: 'log', msg: m }),
      );
      await this.fetchSourceMaps();
    }

    await this.browser.close();
    if (this.aborted) {
      this.notify({ type: 'log', msg: 'Cancelled by user.' });
      return;
    }
    this.notify({ type: 'phase', phase: 'save' });
    this.notify({ type: 'log', msg: `Writing ${this.assets.size} files...` });
    await this.saveAll();
  }

  private async crawlPage(url: string, depth: number): Promise<string[]> {
    const discovered: string[] = [];
    if (this.aborted) return discovered;
    let lease;
    try {
      lease = await this.browser.acquire();
    } catch (err) {
      this.notify({ type: 'warn', msg: `  x ${url} - browser unavailable` });
      return discovered;
    }
    const capture = new PageCapture({
      includeMedia: this.opts.includeMedia,
      maxFileBytes: this.opts.maxFileBytes,
      onAsset: r => this.stageCaptured(r),
    });
    try {
      const { page } = lease;
      await capture.attach(page);

      this.notify({ type: 'log', msg: `  -> ${url}` });
      const resp = await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: this.opts.pageTimeoutMs,
      });
      if (resp && resp.status() >= 400) {
        this.notify({ type: 'warn', msg: `  x ${url} - HTTP ${resp.status()}` });
        return discovered;
      }
      await this.quickScroll(page);
      await new Promise(r => setTimeout(r, 600));

      const html = await page.content();
      // Key the page under the post-redirect URL so links resolve correctly.
      const finalUrl = page.url();
      this.stage(finalUrl, Buffer.from(html, 'utf8'), 'text/html', true, 'document');
      this.pagesRendered++;
      this.notify({
        type: 'page',
        count: this.pagesRendered,
        name: new URL(finalUrl).pathname || '/',
      });

      if (depth < this.opts.maxDepth) {
        const hrefs = await page.evaluate((origin: string) => {
          const out: string[] = [];
          document.querySelectorAll('a[href]').forEach(a => {
            try {
              const u = new URL((a as HTMLAnchorElement).href);
              u.hash = '';
              if (u.origin === origin) out.push(u.href);
            } catch { /* bad href */ }
          });
          return out;
        }, this.origin);
        for (const h of new Set(hrefs))
          if (!this.visited.has(h)) discovered.push(h);
      }
    } catch (err) {
      // Abort closes pages mid-flight — that's expected, not a warning.
      if (!this.aborted) this.notify({ type: 'warn', msg: `  x ${url} - ${(err as Error).message}` });
    } finally {
      await capture.detach();
      await lease.release();
    }
    return discovered;
  }

  private async quickScroll(page: import('puppeteer').Page): Promise<void> {
    try {
      await page.evaluate(async () => {
        const max = Math.min(document.documentElement.scrollHeight, 8000);
        for (let pos = 0; pos < max; pos += 1200) {
          window.scrollTo(0, pos);
          await new Promise(r => setTimeout(r, 70));
        }
        window.scrollTo(0, 0);
      });
    } catch { /* page closed mid-scroll */ }
  }

  // ---------------- source maps ----------------

  private async fetchSourceMaps(): Promise<void> {
    const maps: string[] = [];
    for (const [url, meta] of this.assets) {
      const ct = meta.contentType;
      if (ct !== 'text/css' && !ct.includes('javascript')) continue;
      try {
        const buf = fs.readFileSync(meta.stagePath);
        const tail = buf.toString('utf8', Math.max(0, buf.length - 500));
        const m = tail.match(/\/[/*]#\s*sourceMappingURL=(\S+)/);
        if (!m || m[1].startsWith('data:')) continue;
        const mapUrl = new URL(m[1], url).href;
        if (!this.assets.has(mapUrl) && !this.seen.has(mapUrl)) {
          this.seen.add(mapUrl);
          maps.push(mapUrl);
        }
      } catch { /* unreadable stage file */ }
    }
    if (!maps.length) return;
    this.notify({ type: 'log', msg: `Fetching ${maps.length} source map(s)...` });
    await Promise.all(
      maps.map(async mapUrl => {
        const res = await safeFetch(mapUrl, { timeoutMs: 8000, maxBytes: 10_000_000 });
        if (res) {
          this.stage(mapUrl, res.body, 'application/json');
          this.notify({ type: 'log', msg: `  + map: ${new URL(mapUrl).pathname}` });
        }
      }),
    );
  }

  // ---------------- save ----------------

  private async saveAll(): Promise<void> {
    const u2p = new Map<string, string>();
    for (const [url, meta] of this.assets)
      u2p.set(url, urlToLocalPath(url, meta.contentType, meta.isPage, this.origin));

    // Manifest for the service worker: pathname+search -> local path.
    const manifest: Record<string, string> = {};
    for (const [url, lp] of u2p) {
      try {
        const u = new URL(url);
        manifest[u.pathname + u.search] = lp;
        // Cross-origin assets also get an absolute-URL key: runtime fetches
        // carry the foreign host, and a bare pathname could collide with a
        // same-origin file of the same name.
        if (u.origin !== this.origin) manifest[u.href] = lp;
      } catch { /* skip */ }
    }

    for (const [url, meta] of this.assets) {
      const localPath = u2p.get(url);
      if (!localPath) continue;
      const full = path.join(this.outDir, ...localPath.split('/'));
      try {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        let buf: Buffer = fs.readFileSync(meta.stagePath);
        const ct = meta.contentType;
        if (meta.isPage || ct === 'text/html') {
          let html = rewriteHtml(buf.toString('utf8'), url, u2p, localPath);
          if (this.opts.injectServiceWorker) {
            const tag = swRegisterSnippet(localPath);
            html = html.includes('</body>')
              ? html.replace('</body>', `${tag}</body>`)
              : html + tag;
          }
          buf = Buffer.from(html, 'utf8');
        } else if (ct === 'text/css') {
          const dir = path.posix.dirname(localPath);
          buf = Buffer.from(rewriteCssUrls(buf.toString('utf8'), url, u2p, dir), 'utf8');
        }
        if (!fs.existsSync(full)) {
          fs.writeFileSync(full, buf);
          this.fileCount++;
          this.notify({ type: 'file', count: this.fileCount, name: localPath });
        }
      } catch (err) {
        this.notify({ type: 'warn', msg: `  Write failed ${localPath}: ${(err as Error).message}` });
      }
    }

    fs.rmSync(this.stageDir, { recursive: true, force: true });
    writeOfflineFiles(this.outDir, this.startUrl.hostname, manifest, this.opts.injectServiceWorker);
    this.fileCount += this.opts.injectServiceWorker ? 3 : 2;
  }
}
