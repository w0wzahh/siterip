import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { Crawler } from '../core/crawler.js';
import { zipDirectory, buildTree } from '../core/archive.js';
import type { CrawlOptions, FileNode, NotifyEvent } from '../types.js';

export type JobStatus = 'running' | 'done' | 'error';

export interface Job {
  id: string;
  status: JobStatus;
  url: string;
  created: number;
  tmpDir: string;
  siteDir: string;
  zipPath?: string;
  files?: number;
  sizeMB?: string;
  tree?: FileNode;
  errorMsg?: string;
  crawler?: Crawler;
  cancelRequested?: boolean;
  emitter: EventEmitter;
}

const jobs = new Map<string, Job>();
const MAX_CONCURRENT = 3;
const JOB_TTL_MS = 60 * 60 * 1000;
let activeJobs = 0;

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function serverBusy(): boolean {
  return activeJobs >= MAX_CONCURRENT;
}

export function subscribe(jobId: string, listener: (e: NotifyEvent) => void): () => void {
  const job = jobs.get(jobId);
  if (!job) return () => {};
  job.emitter.on('event', listener);
  return () => job.emitter.off('event', listener);
}

/** Request cancellation of a running job. Returns false if not running. */
export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return false;
  job.cancelRequested = true;
  job.crawler?.abort();
  return true;
}

export function createJob(url: string, opts: CrawlOptions): Job {
  const id = crypto.randomUUID();
  const tmpDir = path.join(os.tmpdir(), `siterip-${id}`);
  const siteDir = path.join(tmpDir, 'site');
  const job: Job = {
    id,
    status: 'running',
    url,
    created: Date.now(),
    tmpDir,
    siteDir,
    emitter: new EventEmitter(),
  };
  job.emitter.setMaxListeners(20);
  jobs.set(id, job);
  activeJobs++;
  void runJob(job, opts).finally(() => activeJobs--);
  return job;
}

async function runJob(job: Job, opts: CrawlOptions): Promise<void> {
  const emit = (e: NotifyEvent) => job.emitter.emit('event', e);
  try {
    const crawler = new Crawler(new URL(job.url), job.siteDir, opts, emit);
    job.crawler = crawler;
    await crawler.crawl();
    if (job.cancelRequested) throw new Error('Cancelled by user.');
    emit({ type: 'zip', msg: 'Creating ZIP archive...' });
    job.zipPath = path.join(job.tmpDir, 'site.zip');
    const bytes = await zipDirectory(job.siteDir, job.zipPath);
    job.sizeMB = (bytes / 1_048_576).toFixed(2);
    job.tree = buildTree(job.siteDir, job.siteDir);
    job.files = crawlerFileCount(job.tree);
    job.status = 'done';
    emit({ type: 'done', jobId: job.id, files: job.files, size: job.sizeMB, tree: job.tree });
  } catch (err) {
    job.status = 'error';
    job.errorMsg = (err as Error)?.message ?? String(err);
    emit({ type: 'error', msg: job.errorMsg });
    fs.rmSync(job.tmpDir, { recursive: true, force: true });
  }
}

function crawlerFileCount(tree: FileNode): number {
  if (tree.type === 'file') return 1;
  return (tree.children ?? []).reduce((n, c) => n + crawlerFileCount(c), 0);
}

export function cleanupJob(id: string): void {
  const job = jobs.get(id);
  if (job?.tmpDir) fs.rmSync(job.tmpDir, { recursive: true, force: true });
  jobs.delete(id);
}

// Reap stale jobs hourly-ish.
setInterval(() => {
  const cut = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) if (job.created < cut) cleanupJob(id);
}, 1_800_000).unref();

// ---------------- rate limiting ----------------

const rateMap = new Map<string, { count: number; reset: number }>();

export function checkRate(ip: string): boolean {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now > entry.reset) {
    rateMap.set(ip, { count: 1, reset: now + 60_000 });
    return true;
  }
  entry.count++;
  return entry.count <= 5;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of rateMap) if (now > e.reset) rateMap.delete(ip);
}, 120_000).unref();
