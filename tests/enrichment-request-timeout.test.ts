import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enrichCell, ENRICHMENT_REQUEST_MS } from '../src/lib/api';

const op = { kind: 'search' as const, query: 'example', pick: 'url' as const, numResults: 1 };

test('a stalled enrichment request has a deadline and a retryable user message', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 let signal: AbortSignal | undefined;
 t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
  signal = init?.signal ?? undefined;
  return new Promise<Response>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
 });
 const request = enrichCell(op, {});
 const rejected = assert.rejects(request, /took too long.*Run this cell again/);
 assert.ok(signal);
 t.mock.timers.tick(ENRICHMENT_REQUEST_MS);
 await rejected;
 assert.equal(signal.aborted, true);
});

test('explicit cancellation remains cancellation rather than a timeout error', async t => {
 const controller = new AbortController();
 t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })));
 const request = enrichCell(op, {}, controller.signal);
 const rejected = assert.rejects(request, { name: 'AbortError' });
 controller.abort();
 await rejected;
});
