import dns from 'dns/promises';

const PRIVATE_IP =
  /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|0\.|169\.254\.|::1$|fc00:|fd00:|fe80:|::ffff:(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.))/i;

const hostVerdicts = new Map<string, boolean>();

export function isPrivateIP(ip: string): boolean {
  return PRIVATE_IP.test(ip);
}

/** Resolve a hostname and return false if ANY record is private. Cached. */
export async function isPublicHost(hostname: string): Promise<boolean> {
  if (/localhost/i.test(hostname)) return false;
  const cached = hostVerdicts.get(hostname);
  if (cached !== undefined) return cached;
  let ok = true;
  try {
    const records = await dns.lookup(hostname, { all: true });
    if (records.length === 0) ok = false;
    else if (records.some(r => isPrivateIP(r.address))) ok = false;
  } catch {
    ok = false;
  }
  hostVerdicts.set(hostname, ok);
  return ok;
}

export async function validatePublicUrl(rawUrl: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL format.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP/HTTPS URLs are allowed.');
  }
  if (!(await isPublicHost(parsed.hostname))) {
    throw new Error(`Host is private or unresolvable: ${parsed.hostname}`);
  }
  return parsed.href;
}

const FETCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * fetch() guarded against SSRF: validates the initial URL and every
 * redirect hop against the private-IP blocklist.
 */
export async function safeFetch(
  url: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ url: string; status: number; contentType: string; body: Buffer } | null> {
  const { timeoutMs = 10_000, maxBytes = 8 * 1024 * 1024 } = opts;
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    let u: URL;
    try { u = new URL(current); } catch { return null; }
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    if (!(await isPublicHost(u.hostname))) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(current, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'user-agent': FETCH_UA, accept: '*/*' },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return null;
        current = new URL(loc, current).href;
        continue;
      }
      if (res.status < 200 || res.status >= 400) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > maxBytes) return null;
      return {
        url: res.url || current,
        status: res.status,
        contentType: (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(),
        body: buf,
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}
