import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentLogoData } from '../../src/lib/server/document-logo';

test('embeds provider logos without depending on browser CORS headers', async (t) => {
 const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>';
 t.mock.method(globalThis, 'fetch', async (_url: URL, options: RequestInit) => {
  assert.equal(options.redirect, 'error');
  return new Response(svg, { headers: { 'content-type': 'image/svg+xml' } });
 });
 assert.equal(await documentLogoData('https://media.brand.dev/logo.svg'), `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
});

test('rejects off-provider URLs before fetching, and rejects oversized or invalid assets', async (t) => {
 const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('not an image', { headers: { 'content-type': 'text/html' } }));
 for (const url of ['http://media.brand.dev/logo.png', 'https://127.0.0.1/logo.png', 'https://media.brand.dev.evil.test/logo.png', 'https://media.brand.dev:444/logo.png', 'https://user@media.brand.dev/logo.png']) await assert.rejects(documentLogoData(url));
 assert.equal(fetch.mock.callCount(), 0);
 await assert.rejects(documentLogoData('https://media.brand.dev/logo.png'), /unavailable/);
 fetch.mock.mockImplementation(async () => new Response(new Uint8Array(5_000_001), { headers: { 'content-type': 'image/png' } }));
 await assert.rejects(documentLogoData('https://media.brand.dev/logo.png'), /too large/);
});
