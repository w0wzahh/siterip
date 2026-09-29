import type { Page, CDPSession } from 'puppeteer';

export interface CapturedResponse {
  url: string;
  body: Buffer;
  contentType: string;
  resourceType: string;
  method: string;
}

interface Inflight {
  url: string;
  mimeType: string;
  resourceType: string;
  method: string;
  status: number;
  contentLength: number;
}

const MEDIA_EXT = /\.(mp4|webm|avi|mov|wmv|flv|mkv|mpg|mpeg|mp3|ogg|wav|flac|aac|m4a)(\?|#|$)/i;
const MEDIA_TYPES = new Set(['media']);
const SKIP_SCHEMES = /^(data:|blob:|chrome:|devtools:|about:)/i;

export interface CaptureOptions {
  includeMedia: boolean;
  maxFileBytes: number;
  onAsset: (res: CapturedResponse) => void;
}

/**
 * Passive network capture via CDP. Observes every response the page receives
 * (documents, XHR/fetch API calls, scripts, styles, images, cached hits) and
 * pulls bodies with Network.getResponseBody. Far more complete than
 * puppeteer's response.buffer(), which misses cached and streamed content.
 */
export class PageCapture {
  private client!: CDPSession;
  private methods = new Map<string, string>();
  private inflight = new Map<string, Inflight>();
  private seen = new Set<string>();

  constructor(private opts: CaptureOptions) {}

  async attach(page: Page): Promise<void> {
    const client = await page.createCDPSession();
    this.client = client;
    await client.send('Network.enable', {
      maxTotalBufferSize: 512 * 1024 * 1024,
      maxResourceBufferSize: this.opts.maxFileBytes,
    });
    if (!this.opts.includeMedia) {
      await client.send('Network.setBlockedURLs', {
        urls: ['*.mp4*', '*.webm*', '*.mov*', '*.mp3*', '*.ogg*', '*.wav*', '*.m3u8*', '*.ts*'],
      }).catch(() => {});
    }

    client.on('Network.requestWillBeSent', (e: any) => {
      // Redirects reuse the requestId — last one wins, which is what we want.
      this.methods.set(e.requestId, e.request?.method ?? 'GET');
    });
    client.on('Network.responseReceived', (e: any) => this.onResponse(e));
    client.on('Network.loadingFinished', (e: any) => void this.onFinished(e.requestId));
    client.on('Network.loadingFailed', (e: any) => {
      this.inflight.delete(e.requestId);
      this.methods.delete(e.requestId);
    });
  }

  private onResponse(e: any): void {
    const res = e.response;
    const url: string = res?.url ?? '';
    if (!url || SKIP_SCHEMES.test(url)) return;
    const status: number = res?.status ?? 0;
    if (status < 200 || status >= 400) return;
    const resourceType: string = (e.type ?? 'other').toLowerCase();
    // Documents are staged by the crawler (rendered DOM), not the raw response.
    if (resourceType === 'document') return;
    if (!this.opts.includeMedia && (MEDIA_TYPES.has(resourceType) || MEDIA_EXT.test(url))) return;
    const contentLength = parseInt(res?.headers?.['content-length'] ?? '0', 10);
    if (contentLength > this.opts.maxFileBytes) return;
    if (this.seen.has(url)) return; // first response for a URL wins
    this.inflight.set(e.requestId, {
      url,
      mimeType: res?.mimeType ?? '',
      resourceType,
      method: this.methods.get(e.requestId) ?? 'GET',
      status,
      contentLength,
    });
  }

  private async onFinished(requestId: string): Promise<void> {
    const meta = this.inflight.get(requestId);
    this.inflight.delete(requestId);
    this.methods.delete(requestId);
    if (!meta) return;
    try {
      const { body, base64Encoded } = await this.client.send('Network.getResponseBody', {
        requestId,
      }) as { body: string; base64Encoded: boolean };
      const buf = base64Encoded ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf8');
      if (buf.length === 0 || buf.length > this.opts.maxFileBytes) return;
      this.seen.add(meta.url);
      this.opts.onAsset({
        url: meta.url,
        body: buf,
        contentType: meta.mimeType,
        resourceType: meta.resourceType,
        method: meta.method,
      });
    } catch {
      // Body unavailable (streamed, prerendered, or evicted from buffer) — skip.
    }
  }

  async detach(): Promise<void> {
    try { await this.client.detach(); } catch { /* already gone */ }
    this.inflight.clear();
    this.methods.clear();
  }
}
