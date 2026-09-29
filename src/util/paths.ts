import path from 'path';
import { contentTypeToExt } from './mime.js';

/**
 * Map a captured URL to a local file path inside the output directory.
 * Same-origin URLs map to their natural path; cross-origin assets go under _cdn/<host>/.
 * URLs with query strings get a short hash suffix so ?v=1 and ?v=2 don't collide.
 * Always returns POSIX-style paths (forward slashes) for platform-consistent output.
 */
export function urlToLocalPath(
  urlStr: string,
  contentType: string,
  isPage: boolean,
  origin: string,
): string {
  try {
    const u = new URL(urlStr);
    const same = u.origin === origin;
    const prefix = same ? '' : '_cdn/' + sanitizeSegment(u.hostname);
    let p = u.pathname;
    try { p = decodeURIComponent(p); } catch { /* keep raw */ }
    p = p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\.\.\//g, '') || '/';
    const lastSeg = p.split('/').pop() ?? '';
    const dotIdx = lastSeg.lastIndexOf('.');
    const hasExt = dotIdx > 0 && dotIdx < lastSeg.length - 1;
    let local: string;
    if (isPage) {
      if (hasExt && (contentType === 'text/html' || /\.html?$/i.test(p))) {
        local = path.posix.join(prefix, p.slice(1));
        // .php/.aspx-style pages wouldn't render offline (unknown mime on
        // serve.js, downloaded-not-shown on file://) — give them .html.
        if (!/\.html?$/i.test(local)) local += '.html';
      } else {
        const stripped = p.replace(/\/$/, '');
        local = stripped
          ? path.posix.join(prefix, stripped.slice(1), 'index.html')
          : path.posix.join(prefix, 'index.html');
      }
    } else if (!hasExt) {
      local = path.posix.join(prefix, p.slice(1) + contentTypeToExt(contentType));
    } else {
      local = path.posix.join(prefix, p.slice(1));
    }
    if (u.search) {
      const h = Buffer.from(u.search).toString('base64url').replace(/[^a-z0-9]/gi, '').slice(0, 8);
      const ext = path.posix.extname(local);
      local = local.slice(0, local.length - ext.length) + `.${h}` + ext;
    }
    local = local
      .split('/')
      .map(seg => sanitizeSegment(seg) || '_')
      .join('/');
    return path.posix.normalize(local)
      .replace(/^(\.\.\/)+/, '').replace(/^\/+/, '') || 'index.html';
  } catch {
    return `_asset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

function sanitizeSegment(seg: string): string {
  return seg
    .replace(/[<>:"|?*\x00-\x1f]/g, '_')
    .replace(/^[. ]+|[. ]+$/g, '') || '_';
}

/** POSIX-style relative path from a directory to a target file, prefixed with ./ */
export function relPath(fromDir: string, toPath: string): string {
  const to = toPath.replace(/\\/g, '/');
  const from = fromDir.replace(/\\/g, '/');
  if (!from || from === '.') return to.startsWith('./') ? to : './' + to;
  const r = path.posix.relative(from, to);
  return r.startsWith('.') ? r : './' + r;
}

/** Number of directory levels deep a local path sits (for root-relative links). */
export function depthOf(localPath: string): number {
  const d = path.posix.dirname(localPath.replace(/\\/g, '/'));
  return d === '.' ? 0 : d.split('/').length;
}
