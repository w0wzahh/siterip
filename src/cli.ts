import path from 'path';
import fs from 'fs';
import os from 'os';
import { Crawler } from './core/crawler.js';
import { zipDirectory, buildTree } from './core/archive.js';
import { validatePublicUrl } from './core/fetchsafe.js';
import { DEFAULT_OPTIONS, type NotifyEvent } from './types.js';

function usage(): never {
  console.log(`
SiteRip CLI - download a website for offline use

Usage:
  siterip <url> [options]

Options:
  -o, --out <file>        Output ZIP path (default: <host>.zip)
  -d, --depth <n>         Crawl depth 0-5 (default: 2)
  -c, --concurrency <n>   Parallel pages 1-6 (default: 3)
  --max-pages <n>         Page cap (default: 150)
  --max-size <mb>         Total archive cap in MB (default: 512)
  --max-file <mb>         Max size per file in MB (default: 32)
  --timeout <s>           Page load timeout in seconds (default: 45)
  --no-media              Skip video/audio
  --no-sw                 Don't inject offline service worker
  --no-sitemap            Don't use sitemaps for page discovery
  -h, --help              Show this help
`);
  process.exit(0);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('-h') || args.includes('--help')) usage();

  const opts = { ...DEFAULT_OPTIONS };
  let url = '';
  let out = '';

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '-o': case '--out': out = args[++i]; break;
      case '-d': case '--depth': {
        const v = parseInt(args[++i]);
        opts.maxDepth = Number.isFinite(v) ? Math.min(Math.max(v, 0), 5) : 2;
        break;
      }
      case '-c': case '--concurrency': opts.concurrency = Math.min(Math.max(+args[++i] || 3, 1), 6); break;
      case '--max-pages': opts.maxPages = +args[++i] || 150; break;
      case '--max-size': opts.maxTotalBytes = (+args[++i] || 512) * 1048576; break;
      case '--max-file': opts.maxFileBytes = (+args[++i] || 32) * 1048576; break;
      case '--timeout': opts.pageTimeoutMs = Math.min(Math.max(+args[++i] || 45, 5), 300) * 1000; break;
      case '--no-media': opts.includeMedia = false; break;
      case '--no-sw': opts.injectServiceWorker = false; break;
      case '--no-sitemap': opts.followSitemaps = false; break;
      default:
        if (!a.startsWith('-') && !url) url = a;
        else { console.error(`Unknown option: ${a}`); usage(); }
    }
  }
  if (!url) usage();

  const valid = await validatePublicUrl(url);
  const host = new URL(valid).hostname;
  const outPath = path.resolve(out || `${host}.zip`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siterip-'));
  const siteDir = path.join(tmpDir, 'site');

  const notify = (e: NotifyEvent) => {
    if (e.type === 'log' || e.type === 'warn' || e.type === 'zip') console.log(e.msg);
    else if (e.type === 'file') process.stdout.write(`\r  files: ${e.count}   `);
    else if (e.type === 'page') process.stdout.write(`\r  pages: ${e.count}   `);
    else if (e.type === 'error') console.error(`\nERROR: ${e.msg}`);
  };

  try {
    const crawler = new Crawler(new URL(valid), siteDir, opts, notify);
    await crawler.crawl();
    console.log('\nZipping...');
    const bytes = await zipDirectory(siteDir, outPath);
    const mb = (bytes / 1_048_576).toFixed(2);
    const tree = buildTree(siteDir, siteDir);
    const count = (function n(t: typeof tree): number {
      return t.type === 'file' ? 1 : (t.children ?? []).reduce((s, c) => s + n(c), 0);
    })(tree);
    console.log(`\nDone -> ${outPath}  (${count} files, ${mb} MB)`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(`Fatal: ${(err as Error).message}`);
  process.exit(1);
});
