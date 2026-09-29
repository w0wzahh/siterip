import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteHtml, rewriteCssUrls } from '../src/core/rewrite.js';
import { serviceWorkerSource, swRegisterSnippet } from '../src/core/offline.js';

const PAGE = 'https://example.com/about/';
const u2p = new Map<string, string>([
  ['https://example.com/css/app.css', 'css/app.css'],
  ['https://example.com/img/logo.png', 'img/logo.png'],
  ['https://example.com/contact', 'contact/index.html'],
]);

test('rewrites stylesheet and anchor hrefs relative to page dir', () => {
  const html = `<html><head><link rel="stylesheet" href="/css/app.css"></head>
    <body><a href="/contact">c</a></body></html>`;
  const out = rewriteHtml(html, PAGE, u2p, 'about/index.html');
  assert.match(out, /href="\.\.\/css\/app\.css"/);
  assert.match(out, /href="\.\.\/contact\/index\.html"/);
});

test('rewrites srcset entries', () => {
  const html = `<img src="/img/logo.png" srcset="/img/logo.png 1x, /img/logo.png 2x">`;
  const out = rewriteHtml(html, PAGE, u2p, 'index.html');
  assert.match(out, /srcset="\.\/img\/logo\.png 1x, \.\/img\/logo\.png 2x"/);
});

test('leaves data: and external unmapped URLs alone', () => {
  const html = `<img src="data:image/png;base64,AAA"><a href="https://other.com/x">x</a>`;
  const out = rewriteHtml(html, PAGE, u2p, 'index.html');
  assert.match(out, /src="data:image\/png;base64,AAA"/);
  assert.match(out, /href="https:\/\/other\.com\/x"/);
});

test('removes <base> tag', () => {
  const html = `<head><base href="https://example.com/"></head>`;
  const out = rewriteHtml(html, PAGE, u2p, 'index.html');
  assert.ok(!out.includes('<base'));
});

test('rewriteCssUrls maps url() references', () => {
  const css = `a{background:url('/img/logo.png')}b{src:url(data:font/woff2;base64,AA)}`;
  const out = rewriteCssUrls(css, 'https://example.com/css/app.css', u2p, 'css');
  assert.match(out, /url\('?\.\.\/img\/logo\.png'?\)/);
  assert.match(out, /data:font\/woff2/);
});

test('service worker manifest covers navigation fallback', () => {
  const src = serviceWorkerSource({ '/': 'index.html', '/about': 'about/index.html' });
  assert.match(src, /MANIFEST/);
  assert.match(src, /mode === 'navigate'/);
});

test('sw register snippet uses correct relative path by depth', () => {
  assert.match(swRegisterSnippet('index.html'), /register\("\.\/sw\.js"\)/);
  assert.match(swRegisterSnippet('about/index.html'), /register\("\.\.\/sw\.js"\)/);
  assert.match(swRegisterSnippet('a/b/index.html'), /register\("\.\.\/\.\.\/sw\.js"\)/);
});
