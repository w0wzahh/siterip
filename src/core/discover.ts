import { safeFetch } from './fetchsafe.js';

const COMMON_PATHS = [
  '/robots.txt',
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/manifest.json',
  '/manifest.webmanifest',
  '/favicon.ico',
  '/favicon.svg',
  '/browserconfig.xml',
  '/crossdomain.xml',
  '/.well-known/security.txt',
  '/.well-known/change-password',
  '/humans.txt',
];

/** Fetch well-known server files (robots.txt, favicon, manifests, etc). */
export async function fetchCommonPaths(
  origin: string,
  has: (url: string) => boolean,
  stage: (url: string, body: Buffer, contentType: string) => void,
  log: (msg: string) => void,
): Promise<void> {
  await Promise.all(
    COMMON_PATHS.map(async p => {
      const fullUrl = origin + p;
      if (has(fullUrl)) return;
      const res = await safeFetch(fullUrl, { timeoutMs: 8000, maxBytes: 5_000_000 });
      if (!res || !res.contentType || res.contentType === 'text/html') return;
      stage(fullUrl, res.body, res.contentType);
      log(`  + ${p}`);
    }),
  );
}

/**
 * Pull page URLs out of robots.txt Sitemap: directives and sitemap XML files
 * (including sitemap indexes). Returns same-origin URLs only.
 */
export async function discoverFromSitemaps(
  origin: string,
  maxUrls = 2000,
): Promise<string[]> {
  const candidates = new Set<string>([`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`]);

  const robots = await safeFetch(`${origin}/robots.txt`, { timeoutMs: 8000 });
  if (robots) {
    for (const line of robots.body.toString('utf8').split('\n')) {
      const m = line.match(/^sitemap:\s*(\S+)/i);
      if (m) {
        try {
          const u = new URL(m[1].trim());
          if (u.origin === origin) candidates.add(u.href);
        } catch { /* bad line */ }
      }
    }
  }

  const urls: string[] = [];
  const queue = [...candidates];
  const seen = new Set<string>();
  while (queue.length && urls.length < maxUrls && seen.size < 12) {
    const sm = queue.shift()!;
    if (seen.has(sm)) continue;
    seen.add(sm);
    const res = await safeFetch(sm, { timeoutMs: 10_000, maxBytes: 10_000_000 });
    if (!res) continue;
    const xml = res.body.toString('utf8');
    for (const m of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
      try {
        const u = new URL(m[1]);
        if (u.origin !== origin) continue;
        if (/sitemap.*\.xml|\.xml$/i.test(u.pathname) && !seen.has(u.href)) {
          queue.push(u.href); // nested sitemap index
        } else {
          u.hash = '';
          urls.push(u.href);
        }
      } catch { /* skip */ }
      if (urls.length >= maxUrls) break;
    }
  }
  return [...new Set(urls)];
}
