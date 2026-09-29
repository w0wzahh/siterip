import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import chromium from '@sparticuz/chromium';
import puppeteerCore from 'puppeteer-core';
import type { Browser } from 'puppeteer';
import { Crawler } from '../../dist/core/crawler.js';
import { BrowserManager } from '../../dist/core/browser.js';
import { zipDirectory } from '../../dist/core/archive.js';
import { validatePublicUrl } from '../../dist/core/fetchsafe.js';
import { DEFAULT_OPTIONS } from '../../dist/types.js';

// Netlify synchronous functions cap at 60s with a 20MB streamed response,
// so hosted mode is a "quick rip": one rendered page + its assets.
const CRAWL_BUDGET_MS = 45_000;
const MAX_ZIP_BYTES = 16 * 1024 * 1024;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export default async (req: Request): Promise<Response> => {
  // The UI probes this with GET to detect hosted mode.
  if (req.method !== 'POST') {
    return json({ mode: 'netlify-quickrip', pages: 1, maxMB: 16 });
  }

  let url: string;
  try {
    url = String((await req.json()).url ?? '');
    url = await validatePublicUrl(url);
  } catch (err) {
    return json({ error: (err as Error).message || 'Invalid URL.' }, 400);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siterip-'));
  const siteDir = path.join(tmpDir, 'site');
  const zipPath = path.join(tmpDir, 'site.zip');

  try {
    const launcher = async () =>
      (await puppeteerCore.launch({
        args: chromium.args,
        executablePath:
          process.env.CHROME_EXECUTABLE_PATH || (await chromium.executablePath()),
        headless: true,
        defaultViewport: { width: 1920, height: 1080 },
      })) as unknown as Browser;

    const crawler = new Crawler(
      new URL(url),
      siteDir,
      {
        ...DEFAULT_OPTIONS,
        maxDepth: 0,
        maxPages: 1,
        maxAssets: 800,
        maxTotalBytes: MAX_ZIP_BYTES,
        maxFileBytes: 8 * 1024 * 1024,
        concurrency: 1,
        pageTimeoutMs: 20_000,
        followSitemaps: false,
      },
      () => {},
      new BrowserManager(40, () => {}, launcher),
    );

    const killer = setTimeout(() => crawler.abort(), CRAWL_BUDGET_MS);
    try {
      await crawler.crawl();
    } finally {
      clearTimeout(killer);
    }

    const bytes = await zipDirectory(siteDir, zipPath);
    if (bytes > MAX_ZIP_BYTES * 1.2) {
      return json({ error: 'Archive too large for the hosted tier. Self-host for full rips.' }, 413);
    }

    const host = new URL(url).hostname.replace(/[^a-z0-9._-]/gi, '_') || 'site';
    const buf = fs.readFileSync(zipPath);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(buf));
        c.close();
      },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${host}.zip"`,
      },
    });
  } catch (err) {
    const msg = (err as Error)?.message ?? 'Rip failed.';
    const timeout = /abort|timeout|closed/i.test(msg);
    return json(
      { error: timeout ? 'Page took too long for the hosted tier. Try a lighter page or self-host.' : msg },
      500,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
};
