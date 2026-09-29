import * as cheerio from 'cheerio';
import path from 'path';
import { relPath } from '../util/paths.js';

export type UrlMap = Map<string, string>; // absolute URL -> local path

const SKIP_SCHEME = /^(data:|#|javascript:|mailto:|tel:|blob:|about:)/i;

function makeRewriter(pageUrl: string, u2p: UrlMap, dir: string) {
  return (raw: string): string => {
    if (!raw) return raw;
    const s = raw.trim();
    if (!s || SKIP_SCHEME.test(s)) return raw;
    try {
      const abs = new URL(s, pageUrl).href;
      const lp = u2p.get(abs);
      return lp ? relPath(dir, lp) : raw;
    } catch {
      return raw;
    }
  };
}

export function rewriteCssUrls(
  css: string,
  baseUrl: string,
  u2p: UrlMap,
  dir: string,
): string {
  const rw = makeRewriter(baseUrl, u2p, dir);
  return css
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, q, raw) => {
      if (!raw || /^(data:|#)/i.test(raw)) return match;
      const out = rw(raw);
      return out === raw ? match : `url(${q}${out}${q})`;
    })
    .replace(/@import\s+(['"])(.*?)\1/gi, (match, q, raw) => {
      const out = rw(raw);
      return out === raw ? match : `@import ${q}${out}${q}`;
    });
}

/**
 * Rewrite all known URL-bearing attributes in an HTML document to local
 * relative paths. Anything the service worker will handle anyway is left
 * alone if it isn't in the map.
 */
export function rewriteHtml(
  html: string,
  pageUrl: string,
  u2p: UrlMap,
  localPath: string,
): string {
  const $ = cheerio.load(html);
  const dir = path.posix.dirname(localPath.replace(/\\/g, '/'));
  const rw = makeRewriter(pageUrl, u2p, dir);

  const rwAttr = (sel: string, attr: string) =>
    $(sel).each((_, el) => {
      const v = $(el).attr(attr);
      if (v != null) $(el).attr(attr, rw(v));
    });

  rwAttr('script[src]', 'src');
  rwAttr('link[href]', 'href');
  rwAttr('img', 'src');
  rwAttr('img', 'data-src');
  rwAttr('img', 'data-lazy-src');
  rwAttr('img', 'data-original');
  rwAttr('source', 'src');
  rwAttr('source', 'data-src');
  rwAttr('video', 'src');
  rwAttr('video', 'poster');
  rwAttr('audio', 'src');
  rwAttr('iframe', 'src');
  rwAttr('a', 'href');
  rwAttr('form', 'action');
  rwAttr('use', 'href');
  rwAttr('use', 'xlink:href');
  rwAttr('image', 'href');
  rwAttr('image', 'xlink:href');
  rwAttr('meta[property="og:image"]', 'content');
  rwAttr('meta[name="twitter:image"]', 'content');

  $('[srcset], [data-srcset]').each((_, el) => {
    for (const attr of ['srcset', 'data-srcset']) {
      const srcset = $(el).attr(attr);
      if (!srcset) continue;
      const rewritten = srcset
        .split(',')
        .map(part => {
          const m = part.trim().match(/^(\S+)(\s.*)?$/);
          return m ? rw(m[1]) + (m[2] ?? '') : part;
        })
        .join(', ');
      $(el).attr(attr, rewritten);
    }
  });

  $('style').each((_, el) => {
    const css = $(el).html();
    if (css) $(el).html(rewriteCssUrls(css, pageUrl, u2p, dir));
  });
  $('[style]').each((_, el) => {
    const s = $(el).attr('style');
    if (s) $(el).attr('style', rewriteCssUrls(s, pageUrl, u2p, dir));
  });

  $('head base').remove();
  return $.html();
}
