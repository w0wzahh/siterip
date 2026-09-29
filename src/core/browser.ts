import puppeteer, { Browser, Page } from 'puppeteer';
import type { Notify } from '../types.js';

const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-site-isolation-trials',
  '--ignore-certificate-errors',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-blink-features=AutomationControlled',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-sync',
  '--metrics-recording-only',
  '--window-size=1920,1080',
];

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface PageLease {
  page: Page;
  release: () => Promise<void>;
}

/** A function that launches (or hands out) a Puppeteer Browser. */
export type Launcher = () => Promise<Browser>;

/**
 * Owns the Chromium instance. Pages are handed out via acquire()/release().
 * The browser is recycled after `recycleAfter` page loads (Chromium leaks
 * memory over long sessions); recycling happens once all leases drain.
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private active = 0;
  private served = 0;
  private closed = false;

  constructor(
    private recycleAfter = 40,
    private notify: Notify = () => {},
    private launch: Launcher = () =>
      puppeteer.launch({ headless: true, args: BROWSER_ARGS }),
  ) {}

  private async ensure(): Promise<Browser> {
    if (this.closed) throw new Error('BrowserManager is closed');
    if (this.browser) return this.browser;
    if (!this.launching) {
      this.launching = this
        .launch()
        .then(b => {
          this.browser = b;
          this.launching = null;
          this.notify({ type: 'log', msg: 'Browser ready.' });
          return b;
        })
        .catch(err => {
          this.launching = null;
          throw err;
        });
    }
    return this.launching;
  }

  private async recycle(): Promise<void> {
    const old = this.browser;
    this.browser = null;
    this.served = 0;
    if (old) {
      this.notify({ type: 'log', msg: 'Recycling browser (memory hygiene)...' });
      await old.close().catch(() => {});
    }
    await this.ensure();
  }

  async acquire(): Promise<PageLease> {
    // Recycle only when nothing is in flight so we never kill an active page.
    if (this.served >= this.recycleAfter && this.active === 0) {
      await this.recycle();
    }
    const browser = await this.ensure();
    this.active++;
    this.served++;
    let page: Page | null = null;
    try {
      page = await browser.newPage();
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent(USER_AGENT);
    } catch (err) {
      this.active--;
      throw err;
    }
    const p = page;
    return {
      page: p,
      release: async () => {
        this.active--;
        await p.close().catch(() => {});
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    const b = this.browser;
    this.browser = null;
    if (b) await b.close().catch(() => {});
  }
}
