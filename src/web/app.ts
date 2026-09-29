import express from 'express';
import path from 'path';
import fs from 'fs';
import { validatePublicUrl } from '../core/fetchsafe.js';
import { streamZip } from '../core/archive.js';
import { DEFAULT_OPTIONS, type CrawlOptions } from '../types.js';
import * as jobs from './jobs.js';

const num = (v: unknown, dflt: number, min: number, max: number) =>
  Math.min(Math.max(parseInt(String(v)) || dflt, min), max);

const bool = (v: unknown, dflt: boolean) =>
  v === undefined || v === null ? dflt : v === true || v === 'true' || v === '1';

function parseOptions(body: Record<string, unknown>): CrawlOptions {
  return {
    maxDepth: num(body.maxDepth, DEFAULT_OPTIONS.maxDepth, 0, 5),
    maxPages: num(body.maxPages, DEFAULT_OPTIONS.maxPages, 1, 500),
    maxAssets: num(body.maxAssets, DEFAULT_OPTIONS.maxAssets, 100, 20000),
    maxTotalBytes: num(body.maxTotalMB, 512, 16, 4096) * 1024 * 1024,
    maxFileBytes: num(body.maxFileMB, 32, 1, 256) * 1024 * 1024,
    concurrency: num(body.concurrency, DEFAULT_OPTIONS.concurrency, 1, 6),
    includeMedia: bool(body.includeMedia, DEFAULT_OPTIONS.includeMedia),
    injectServiceWorker: bool(body.offlineSw, DEFAULT_OPTIONS.injectServiceWorker),
    pageTimeoutMs: num(body.pageTimeoutSec, 45, 5, 120) * 1000,
    followSitemaps: bool(body.followSitemaps, DEFAULT_OPTIONS.followSitemaps),
  };
}

/** True when `target` is `root` itself or lives strictly inside it. */
function insideRoot(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function createApp(publicDir: string): express.Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(publicDir));

  app.get('/api/progress/:jobId', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const { jobId } = req.params;
    const job = jobs.getJob(jobId);

    const heartbeat = setInterval(() => {
      try { res.write(':ping\n\n'); } catch { clearInterval(heartbeat); }
    }, 8000);

    const unsub = jobs.subscribe(jobId, e => {
      try { res.write(`data: ${JSON.stringify(e)}\n\n`); } catch { /* closed */ }
    });

    if (!job) {
      res.write(`data: ${JSON.stringify({ type: 'error', msg: 'Job not found or expired.' })}\n\n`);
    } else if (job.status === 'done') {
      res.write(`data: ${JSON.stringify({
        type: 'done', jobId, files: job.files ?? 0,
        size: job.sizeMB ?? '0.00', tree: job.tree ?? null,
      })}\n\n`);
    } else if (job.status === 'error') {
      res.write(`data: ${JSON.stringify({ type: 'error', msg: job.errorMsg ?? 'Unknown error' })}\n\n`);
    }

    req.on('close', () => {
      clearInterval(heartbeat);
      unsub();
    });
  });

  app.post('/api/download', async (req, res) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    if (!jobs.checkRate(clientIp)) {
      return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
    }
    if (jobs.serverBusy()) {
      return res.status(503).json({ error: 'Server is busy. Please try again shortly.' });
    }
    const { url } = req.body ?? {};
    if (!url) return res.status(400).json({ error: 'URL is required.' });
    let validUrl: string;
    try {
      validUrl = await validatePublicUrl(String(url));
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }
    const job = jobs.createJob(validUrl, parseOptions(req.body ?? {}));
    res.json({ jobId: job.id });
  });

  app.post('/api/cancel/:jobId', (req, res) => {
    if (!jobs.cancelJob(req.params.jobId)) {
      return res.status(400).json({ error: 'Job not running.' });
    }
    res.json({ ok: true });
  });

  app.get('/api/get/:jobId', (req, res) => {
    const job = jobs.getJob(req.params.jobId);
    if (!job || job.status !== 'done' || !job.zipPath) {
      return res.status(404).json({ error: 'Job not found or not ready.' });
    }
    let safeName = 'site.zip';
    try {
      safeName = new URL(job.url).hostname.replace(/[^a-z0-9._-]/gi, '_') + '.zip';
    } catch { /* default name */ }
    res.download(job.zipPath, safeName, err => {
      if (!err) setTimeout(() => jobs.cleanupJob(req.params.jobId), 10_000);
    });
  });

  app.get('/api/tree/:jobId', (req, res) => {
    const job = jobs.getJob(req.params.jobId);
    if (!job || job.status !== 'done' || !job.tree) {
      return res.status(404).json({ error: 'Job not found or not ready.' });
    }
    res.json(job.tree);
  });

  app.get('/api/file/:jobId/*', (req, res) => {
    const job = jobs.getJob(req.params.jobId);
    if (!job || job.status !== 'done') {
      return res.status(404).json({ error: 'Job not found or not ready.' });
    }
    const rel = (req.params as Record<string, string>)[0] ?? '';
    const safe = path.normalize(path.join(job.siteDir, rel));
    if (!insideRoot(path.normalize(job.siteDir), safe)) return res.status(403).end();
    if (!fs.existsSync(safe) || !fs.statSync(safe).isFile()) {
      return res.status(404).json({ error: 'File not found.' });
    }
    res.download(safe, path.basename(safe));
  });

  app.get('/api/folder/:jobId/*', (req, res) => {
    const job = jobs.getJob(req.params.jobId);
    if (!job || job.status !== 'done') {
      return res.status(404).json({ error: 'Job not found or not ready.' });
    }
    const rel = (req.params as Record<string, string>)[0] ?? '';
    const siteRoot = path.normalize(job.siteDir);
    const safe = rel ? path.normalize(path.join(siteRoot, rel)) : siteRoot;
    if (!insideRoot(siteRoot, safe)) return res.status(403).end();
    if (!fs.existsSync(safe) || !fs.statSync(safe).isDirectory()) {
      return res.status(404).json({ error: 'Folder not found.' });
    }
    const folderName = path.basename(safe) || 'site';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${folderName}.zip"`);
    streamZip(safe, res);
  });

  return app;
}
