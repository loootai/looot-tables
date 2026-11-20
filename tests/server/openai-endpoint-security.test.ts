import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { generateText } from 'ai';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { CredentialError } from '../../src/lib/server/credentials';
import { requestGrant } from './access-fixture';
import { openaiModel } from '../../src/lib/server/openai';

function configure(t: TestContext) {
	const values = { NODE_ENV: 'production', LOOOT_TABLES_APP_URL: 'https://self-hosted.example', LOOOT_TABLES_DEV_AUTH: '', LOOOT_TABLES_PASSWORD: 'app-password', LOOOT_TABLES_ALLOW_SERVER_KEYS_WITHOUT_PASSWORD: 'false', OPENAI_API_KEY: 'server-test-key', OPENAI_BASE_URL: '' };
	const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	Object.assign(process.env, values);
	t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

const request = (headers: Record<string, string> = {}) => new Request('https://self-hosted.example/api/enrich', { headers: { 'x-looot-tables-password': 'app-password', ...headers } });

test('server OpenAI keys cannot be forwarded to caller-selected endpoints', async (t) => {
	configure(t);
	const override = { 'x-openai-base-url': 'https://attacker.example/v1' };
	await assert.rejects(requestGrant(request(override)), (error: unknown) => error instanceof CredentialError && error.status === 400);
	process.env.LOOOT_TABLES_PASSWORD = '';
	process.env.LOOOT_TABLES_ALLOW_SERVER_KEYS_WITHOUT_PASSWORD = 'true';
	await assert.rejects(requestGrant(request(override)), /explicit OpenAI key/);
	const ownKey = await requestGrant(request({ ...override, 'x-openai-key': 'caller-test-key' }));
	assert.equal(ownKey.keys.openai, 'caller-test-key');
	assert.equal(ownKey.openaiBaseUrl, override['x-openai-base-url']);
});

test('server OpenAI keys retain the configured endpoint and allow matching overrides', async (t) => {
	configure(t);
	const defaults = await requestGrant(request());
	assert.equal(defaults.keys.openai, 'server-test-key');
	assert.equal(defaults.openaiBaseUrl, null);
	process.env.OPENAI_BASE_URL = 'https://configured.example/v1/';
	assert.equal((await requestGrant(request())).openaiBaseUrl, 'https://configured.example/v1');
	assert.equal((await requestGrant(request({ 'x-openai-base-url': 'https://configured.example/v1/' }))).openaiBaseUrl, 'https://configured.example/v1');
	await assert.rejects(requestGrant(request({ 'x-openai-base-url': 'https://attacker.example/v1' })), /explicit OpenAI key/);
});

test('custom OpenAI inference rejects redirects before reaching internal addresses', async (t) => {
	const previous = getGlobalDispatcher();
	const mock = new MockAgent();
	mock.disableNetConnect();
	setGlobalDispatcher(mock);
	t.after(async () => { setGlobalDispatcher(previous); await mock.close(); });
	mock.get('https://provider.example').intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(307, '', { headers: { location: 'http://127.0.0.1:4444/private' } });
	let internalRequests = 0;
	mock.get('http://127.0.0.1:4444').intercept({ path: '/private', method: 'POST' }).reply(() => { internalRequests++; return { statusCode: 500, data: 'internal service' }; });
	await assert.rejects(generateText({ model: openaiModel('caller-test-key', 'test', 'https://provider.example/v1'), prompt: 'hello', maxRetries: 0 }));
	assert.equal(internalRequests, 0);
});
