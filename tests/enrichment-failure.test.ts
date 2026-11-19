import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, enrichCell, parseFailure } from '../src/lib/api';
import { notifyTrialLimit, OPENAI_KEY_REQUIRED, OPENAI_KEY_REQUIRED_EVENT } from '../src/lib/ai-trial';

const op = { kind: 'search' as const, query: 'example', pick: 'url' as const, numResults: 1 };

test('enrichment failures carry their structured reason on results and on errors', async (t) => {
	const failure = { reason: 'credits_exhausted', retryable: false, provider: 'looot' } as const;
	const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ value: null, error: 'Out of credits (402)', failure }));
	assert.deepEqual((await enrichCell(op, {})).failure, failure);
	fetch.mock.mockImplementation(async () => Response.json({ error: 'No looot token', failure: { reason: 'credential_missing', retryable: false, provider: 'looot' } }, { status: 400 }));
	await assert.rejects(enrichCell(op, {}), (error) => error instanceof ApiError && error.status === 400 && error.message === 'No looot token' && error.failure?.reason === 'credential_missing');
	fetch.mock.mockImplementation(async () => new Response('Bad gateway', { status: 502 }));
	await assert.rejects(enrichCell(op, {}), (error) => error instanceof ApiError && error.status === 502 && error.failure === undefined && /502/.test(error.message));
});

test('malformed failures from the network are ignored', () => {
	assert.equal(parseFailure({ reason: 'meltdown', retryable: true }), undefined);
	assert.equal(parseFailure({ reason: 'timeout' }), undefined);
	assert.equal(parseFailure('rate_limited'), undefined);
	assert.deepEqual(parseFailure({ reason: 'timeout', retryable: true, provider: 'elsewhere' }), { reason: 'timeout', retryable: true });
});

test('the OpenAI key prompt follows the structured failure, with message text only as a fallback', (t) => {
	const target = new EventTarget();
	const seen: string[] = [];
	target.addEventListener(OPENAI_KEY_REQUIRED_EVENT, (event) => seen.push((event as CustomEvent<string>).detail));
	Object.assign(globalThis, { window: target });
	t.after(() => { delete (globalThis as { window?: unknown }).window; });
	notifyTrialLimit('Trial used up', { reason: 'credits_exhausted', retryable: false, provider: 'openai' });
	notifyTrialLimit(undefined, { reason: 'credential_missing', retryable: false, provider: 'openai' });
	notifyTrialLimit(`looot is out of credits. ${OPENAI_KEY_REQUIRED}`, { reason: 'credits_exhausted', retryable: false, provider: 'looot' });
	notifyTrialLimit('Slow down', { reason: 'rate_limited', retryable: true, provider: 'openai' });
	notifyTrialLimit(`Older server. ${OPENAI_KEY_REQUIRED}`);
	notifyTrialLimit('Unrelated');
	assert.deepEqual(seen, ['Trial used up', OPENAI_KEY_REQUIRED, `Older server. ${OPENAI_KEY_REQUIRED}`]);
});
