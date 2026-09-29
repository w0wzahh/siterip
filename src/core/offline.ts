import fs from 'fs';
import path from 'path';
import { depthOf } from '../util/paths.js';

/**
 * Generates the offline-runtime files baked into every rip:
 *  - sw.js      service worker: serves navigations + assets + captured API
 *               calls from an embedded URL->file manifest
 *  - serve.js   tiny static server with SPA fallback
 *  - README.md  usage instructions
 *
 * The service worker is what makes ripped SPAs actually navigable offline:
 * JS-constructed URLs and client-side routes can't be statically rewritten,
 * so the SW intercepts them at request time and maps them to captured files.
 */

export function serviceWorkerSource(manifest: Record<string, string>): string {
  return `// SiteRip offline service worker - maps original URLs to local files.
const MANIFEST = ${JSON.stringify(manifest, null, 0)};
const SCOPE = self.registration.scope;

function localFor(url) {
  const u = new URL(url, SCOPE);
  // Absolute href first (cross-origin assets), then path+query, then path.
  const rel = MANIFEST[u.href] || MANIFEST[u.pathname + u.search] || MANIFEST[u.pathname];
  return rel ? new URL(rel, SCOPE).href : null;
}

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const hit = localFor(req.url);
      if (hit) return fetch(hit);
      // Unknown route -> SPA shell fallback
      const shell = MANIFEST['/'] || 'index.html';
      return fetch(new URL(shell, SCOPE).href);
    })());
    return;
  }
  e.respondWith((async () => {
    const hit = localFor(req.url);
    if (hit) return fetch(hit);
    try { return await fetch(req); }
    catch { return new Response('Not available offline', { status: 404 }); }
  })());
});
`;
}

/** Snippet injected into every HTML page to register the service worker. */
export function swRegisterSnippet(localPath: string): string {
  const depth = depthOf(localPath);
  const rel = depth === 0 ? './sw.js' : '../'.repeat(depth) + 'sw.js';
  return (
    `<script>(function(){if('serviceWorker'in navigator)` +
    `window.addEventListener('load',function(){` +
    `navigator.serviceWorker.register(${JSON.stringify(rel)}).catch(function(){})})})();</script>`
  );
}

export function serveJsSource(): string {
  return `#!/usr/bin/env node
// Offline site server - run: node serve.js  (then open http://localhost:8080)
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const MIME = {
  '.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8',
  '.css':'text/css','.js':'application/javascript','.mjs':'application/javascript',
  '.json':'application/json','.xml':'application/xml','.txt':'text/plain',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
  '.gif':'image/gif','.webp':'image/webp','.avif':'image/avif',
  '.svg':'image/svg+xml','.ico':'image/x-icon','.bmp':'image/bmp',
  '.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf',
  '.mp3':'audio/mpeg','.ogg':'audio/ogg','.wav':'audio/wav','.m4a':'audio/mp4',
  '.mp4':'video/mp4','.webm':'video/webm','.pdf':'application/pdf',
  '.wasm':'application/wasm','.vtt':'text/vtt','.webmanifest':'application/manifest+json',
};
http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(req.url.split('?')[0]); }
  catch { res.writeHead(400); res.end(); return; }
  if (!p || p === '/') p = '/index.html';
  if (p.endsWith('/')) p += 'index.html';
  const safe = path.normalize(path.join(ROOT, p));
  // strict containment check — startsWith(ROOT) alone would pass for
  // sibling paths sharing the prefix (e.g. ROOT 'site' vs 'site.zip')
  const rel = path.relative(ROOT, safe);
  if (rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(403); res.end(); return; }
  let file = safe;
  if (!fs.existsSync(file)) {
    const ext = path.extname(safe);
    file = ext ? path.join(ROOT, 'index.html') : path.join(safe, 'index.html');
  }
  if (!fs.existsSync(file)) file = path.join(ROOT, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('Not found'); return; }
  const ct = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': ct });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () =>
  process.stdout.write('\\n  Offline site -> http://localhost:' + PORT + '\\n\\n')
);
`;
}

export function readmeSource(hostname: string): string {
  return `# Downloaded Website - ${hostname}

## View offline

### Option 1 - Node.js server (recommended)
\`\`\`bash
node serve.js
\`\`\`
Then open **http://localhost:8080**.

### Option 2 - Python
\`\`\`bash
python -m http.server 8080
\`\`\`

### Option 3 - npx serve
\`\`\`bash
npx serve . -p 8080
\`\`\`

## How it works

- Pages and assets are saved with rewritten relative links, so static
  browsing works even without a server.
- A service worker (\`sw.js\`) intercepts requests and maps them to captured
  files, so client-side routes (React/Vue/Angular) and captured API
  responses keep working when served over HTTP.

> Server-side features (login, forms, live APIs) cannot work offline.
`;
}

export function writeOfflineFiles(
  outDir: string,
  hostname: string,
  manifest: Record<string, string>,
  injectSW: boolean,
): void {
  if (injectSW) {
    fs.writeFileSync(path.join(outDir, 'sw.js'), serviceWorkerSource(manifest));
  }
  fs.writeFileSync(path.join(outDir, 'serve.js'), serveJsSource());
  fs.writeFileSync(path.join(outDir, 'README.md'), readmeSource(hostname));
}
