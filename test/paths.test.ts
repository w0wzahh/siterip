import { test } from 'node:test';
import assert from 'node:assert/strict';
import { urlToLocalPath, relPath, depthOf } from '../src/util/paths.js';
import { contentTypeToExt } from '../src/util/mime.js';

const ORIGIN = 'https://example.com';

test('root page maps to index.html', () => {
  assert.equal(urlToLocalPath('https://example.com/', 'text/html', true, ORIGIN), 'index.html');
});

test('nested page maps to dir/index.html', () => {
  const p = urlToLocalPath('https://example.com/about/team', 'text/html', true, ORIGIN);
  assert.equal(p.replace(/\\/g, '/'), 'about/team/index.html');
});

test('page with .html extension keeps filename', () => {
  const p = urlToLocalPath('https://example.com/x/page.html', 'text/html', true, ORIGIN);
  assert.equal(p.replace(/\\/g, '/'), 'x/page.html');
});

test('assets keep their extension', () => {
  const p = urlToLocalPath('https://example.com/css/app.css', 'text/css', false, ORIGIN);
  assert.equal(p.replace(/\\/g, '/'), 'css/app.css');
});

test('extensionless asset gets extension from content type', () => {
  const p = urlToLocalPath('https://example.com/api/data', 'application/json', false, ORIGIN);
  assert.match(p, /api\/data\.json$/);
});

test('cross-origin assets go under _cdn', () => {
  const p = urlToLocalPath('https://cdn.foo.net/lib.js', 'application/javascript', false, ORIGIN);
  assert.match(p.replace(/\\/g, '/'), /^_cdn\/cdn\.foo\.net\/lib\.js$/);
});

test('query strings produce distinct files', () => {
  const a = urlToLocalPath('https://example.com/app.js?v=1', 'application/javascript', false, ORIGIN);
  const b = urlToLocalPath('https://example.com/app.js?v=2', 'application/javascript', false, ORIGIN);
  assert.notEqual(a, b);
  assert.match(a, /app\.[a-z0-9]+\.js$/i);
});

test('path traversal is stripped', () => {
  const p = urlToLocalPath('https://example.com/../../etc/passwd', 'text/html', true, ORIGIN);
  assert.ok(!p.includes('..'), p);
});

test('relPath computes correct relative links', () => {
  assert.equal(relPath('.', 'css/app.css'), './css/app.css');
  assert.equal(relPath('about', 'css/app.css'), '../css/app.css');
  assert.equal(relPath('a/b', 'index.html'), '../../index.html');
});

test('depthOf counts directory levels', () => {
  assert.equal(depthOf('index.html'), 0);
  assert.equal(depthOf('about/index.html'), 1);
  assert.equal(depthOf('a/b/c/index.html'), 3);
});

test('contentTypeToExt maps common types', () => {
  assert.equal(contentTypeToExt('text/html; charset=utf-8'), '.html');
  assert.equal(contentTypeToExt('image/webp'), '.webp');
  assert.equal(contentTypeToExt('application/json'), '.json');
  assert.equal(contentTypeToExt(''), '');
});
