# SiteRip

**Download entire websites — pages, assets and SPA routes — as self-contained, offline-browsable ZIP archives.**

[![Version](https://img.shields.io/badge/version-3.0.0-ffdb58)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-f5aee8)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-9ed66f)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-a8d8ea)](tsconfig.json)
[![Ko-fi](https://img.shields.io/badge/ko--fi-w0wzahh-ff8a75?logo=ko-fi)](https://ko-fi.com/w0wzahh)
[![Site](https://img.shields.io/badge/site-w0wzahh.github.io%2Fsiterip-ff9f5a)](https://w0wzahh.github.io/siterip/)
[![Live app](https://img.shields.io/badge/live-siterip--w0wzahh.netlify.app-9ed66f)](https://siterip-w0wzahh.netlify.app)

## Why SiteRip?

Most "save page" tools grab the HTML and leave the JavaScript-rendered web behind.
SiteRip drives a real headless Chromium, records **every response the browser receives**
through the Chrome DevTools Protocol, rewrites links to local paths, and injects a
service worker — so even React/Vue/Angular routes and XHR-captured API responses
keep working when you open the archive offline.

## Features

- **Real browser capture** — pages are rendered in headless Chromium; nothing that JS builds at runtime is missed
- **CDP passive recording** — every response body (documents, XHR/fetch, cache hits) is captured via DevTools Protocol instead of fragile `response.buffer()` interception
- **Offline replay** — each archive ships a `sw.js` service worker with a URL→file manifest, so client-side routes and captured API calls resolve without a network
- **Parallel crawling** — configurable page concurrency with automatic browser recycling and OOM-safe disk streaming
- **Sitemap discovery** — `robots.txt` + `sitemap.xml` are used for complete page coverage
- **Cancellable jobs** — stop a rip mid-crawl from the UI or API
- **Web UI, CLI & Docker** — same engine, three interfaces
- **SSRF-hardened** — DNS-validated public-host checks (including redirect hops), rate limiting, capped jobs

## Quick start

### Web UI

```bash
npm ci
npm run build
npm start          # http://localhost:3000
```

Paste a URL, press **Download Site**, get a ZIP with a browsable file tree.

### CLI

```bash
npm run cli -- https://example.com -d 2 -o site.zip
```

```
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
  -h, --help              Show help
```

### Docker

```bash
docker build -t siterip .
docker run -p 7860:7860 siterip
```

## Deploy online

### Netlify (quick-rip mode)

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/w0wzahh/siterip)

**Try it live: [siterip-w0wzahh.netlify.app](https://siterip-w0wzahh.netlify.app)**

One click deploys the full UI plus a serverless "quick-rip" function
(`netlify/functions/rip.ts`) that runs headless Chromium via
[`@sparticuz/chromium`](https://github.com/Sparticuz/chromium). Paste a URL,
get a ZIP — the UI auto-detects hosted mode.

**Hosted limits** (Netlify functions: 60 s execution / 20 MB response):

- Single page + its assets, up to ~16 MB per rip
- No multi-page crawling, job history, or file tree

### Full crawler

For the complete engine (multi-page crawls, SSE progress, file tree,
cancellation) use a persistent Node host — Docker on a VPS,
[Render](https://render.com), [Railway](https://railway.com), or
[Fly.io](https://fly.io). The included `Dockerfile` works as-is.

## Web API

| Endpoint | Description |
| --- | --- |
| `POST /api/download` | Start a rip — body: `{ url, maxDepth, concurrency, includeMedia, offlineSw, followSitemaps, maxPages, maxTotalMB, pageTimeoutSec }` → `{ jobId }` |
| `POST /api/cancel/:jobId` | Cancel a running rip |
| `GET /api/progress/:jobId` | Server-Sent Events stream: `log`, `page`, `file`, `phase`, `zip`, `done`, `error` |
| `GET /api/get/:jobId` | Download the finished ZIP |
| `GET /api/tree/:jobId` | JSON file tree of the archive |
| `GET /api/file/:jobId/*` | Download a single file |
| `GET /api/folder/:jobId/*` | Download a folder as ZIP |

## How a rip works

1. Chromium renders each page; the CDP session records every response body to disk.
2. Links are rewritten to local relative paths — the archive is browsable even without a server.
3. `sw.js` + a manifest are injected, so JS-constructed URLs and SPA routes resolve offline.
4. `serve.js` is included in the ZIP — `node serve.js`, then open `localhost:8080`.

> **Note:** server-side features (logins, forms, live APIs) cannot work offline.

## Development

```bash
npm run dev          # tsx, hot-reload server
npm run typecheck    # tsc --noEmit
npm test             # node --test test/*.test.ts
```

```
src/
  cli.ts             # CLI entry
  server.ts          # Web server entry
  core/              # crawler, capture, archive, rewrite, SSRF guard
  web/               # Express app + job registry
public/index.html    # Self-contained web UI
```

## Security

Every fetched host is DNS-validated against private/internal IP ranges
(including each redirect hop). Jobs are rate-limited per client and globally
capped on concurrency, pages, assets and total bytes.

## Support

If SiteRip saved you some time, you can
[buy me a coffee on Ko-fi](https://ko-fi.com/w0wzahh).

## License

[MIT](LICENSE) © [w0wzahh](https://github.com/w0wzahh)
