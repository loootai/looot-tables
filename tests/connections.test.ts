import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS } from '../src/lib/keys';
import { CONNECTION_ORDER, deriveConnections, formatExpiry, isReady, mcpConfig, REQUIRED_PROVIDERS } from '../src/components/app/providers';

const server = { openai: false, looot: false, typesafe: false, passwordRequired: false };

test('one looot token replaces the data provider and every email provider', () => {
	assert.deepEqual([...CONNECTION_ORDER], ['looot', 'openai', 'typesafe']);
	assert.deepEqual([...REQUIRED_PROVIDERS], ['looot', 'openai']);
});

test('saved keys read as saved, and a missing one reads as missing', () => {
	const connections = deriveConnections({ settings: { ...DEFAULT_SETTINGS, loootKey: 'looot-test-token-12345' }, organization: null, server });
	assert.equal(connections.looot.state, 'saved');
	assert.equal(connections.openai.state, 'missing', 'there is no included OpenAI trial');
	assert.equal(connections.typesafe.state, 'missing');
	assert.equal(isReady(connections.looot) && isReady(connections.openai), false);
});

test('a token the deployment provides reads as provided by the deployment, never as an included credit', () => {
	const connections = deriveConnections({ settings: DEFAULT_SETTINGS, organization: null, server: { ...server, looot: true, openai: true } });
	assert.deepEqual(connections.looot, { state: 'deployment', detail: 'Provided by this deployment' });
	assert.equal(connections.openai.state, 'deployment');
});

test('workspace connections report their expiry and when one must be replaced', () => {
	const expiresAt = Date.now() + 3 * 3_600_000;
	const organization = { revision: 2, preferences: { ...DEFAULT_SETTINGS }, providers: { looot: { configured: true, expiresAt, prefix: 'cs_ms_ab' } } };
	const hosted = deriveConnections({ settings: DEFAULT_SETTINGS, organization, server });
	assert.deepEqual(hosted.looot, { state: 'connected', expiresAt, detail: 'cs_ms_ab••••••••' });
	const expired = deriveConnections({ settings: DEFAULT_SETTINGS, organization: { ...organization, providers: { looot: { configured: false, reconnectRequired: true, expiresAt: 1 } } }, server });
	assert.equal(expired.looot.state, 'expired');
	assert.equal(isReady(expired.looot), false);
	assert.equal(formatExpiry(expiresAt, expiresAt - 3 * 3_600_000), 'expires in 3 h');
	assert.equal(formatExpiry(1, 2), 'expired');
});

test('the self-hosted MCP config carries the looot token header next to the OpenAI one', () => {
	assert.deepEqual(JSON.parse(mcpConfig('https://self.example/mcp', 'enr_mcp_secret', true)).mcpServers['looot-tables'].headers, { Authorization: 'Bearer enr_mcp_secret', 'x-openai-key': 'YOUR_OPENAI_API_KEY', 'x-looot-key': 'YOUR_LOOOT_TOKEN' });
	assert.deepEqual(JSON.parse(mcpConfig('https://tables.example/mcp', undefined, false)).mcpServers['looot-tables'].headers, { Authorization: 'Bearer YOUR_AGENT_KEY' });
});
