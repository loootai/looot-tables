import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentLogoData } from '../../src/lib/server/document-logo';

const publicHost = async () => [{ address: '203.0.113.10' }];

test('embeds provider logos without depending on browser CORS headers', async (t) => {
 const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>';
 t.mock.method(globalThis, 'fetch', async (_url: URL, options: RequestInit) => {
  assert.equal(options.redirect, 'error');
  return new Response(svg, { headers: { 'content-type': 'image/svg+xml' } });
 });
 assert.equal(await documentLogoData('https://cdn.provider.example/logo.svg', publicHost), `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
});

test('rejects insecure, private and credentialed URLs before fetching, and rejects oversized or invalid assets', async (t) => {
 const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('not an image', { headers: { 'content-type': 'text/html' } }));
 for (const url of ['http://cdn.provider.example/logo.png', 'https://127.0.0.1/logo.png', 'https://cdn.provider.example:444/logo.png', 'https://user@example.com/logo.png']) await assert.rejects(documentLogoData(url, publicHost));
 await assert.rejects(documentLogoData('https://internal.example/logo.png', async () => [{ address: '10.0.0.5' }]), /not public/, 'a public name that resolves to a private address');
 assert.equal(fetch.mock.callCount(), 0);
 await assert.rejects(documentLogoData('https://cdn.provider.example/logo.png', publicHost), /unavailable/);
 fetch.mock.mockImplementation(async () => new Response(new Uint8Array(5_000_001), { headers: { 'content-type': 'image/png' } }));
 await assert.rejects(documentLogoData('https://cdn.provider.example/logo.png', publicHost), /too large/);
});
