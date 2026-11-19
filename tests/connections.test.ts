import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS } from '../src/lib/keys';
import { contextReconnectHref, deriveConnections, formatExpiry, isReady, mcpConfig } from '../src/components/app/providers';

const server = { openai: false, context: false, typesafe: false, passwordRequired: false };

test('self-hosted saved keys read as saved, including optional providers without a live check', () => {
	const connections = deriveConnections({ settings: { ...DEFAULT_SETTINGS, contextKey: 'ctxt_1234567890', apolloKey: 'apollo-key-12345' }, organization: null, server: { ...server, openaiTrial: { model: 'gpt-6-luna' } }, selfHosted: true, trialLimited: false });
	assert.equal(connections.context.state, 'saved');
	assert.equal(connections.apollo.state, 'saved');
	assert.equal(connections.quickenrich.state, 'missing');
	assert.equal(connections.openai.state, 'missing', 'Self-hosted never offers the hosted trial');
	assert.equal(isReady(connections.context) && isReady(connections.openai), false);
});

test('hosted connections report expiry, the included trial, and its limit per provider', () => {
	const expiresAt = Date.now() + 3 * 3_600_000;
	const organization = { revision: 2, preferences: { ...DEFAULT_SETTINGS }, providers: { context: { configured: true, source: 'signin' as const, expiresAt, prefix: 'ctxt_ab' } } };
	const hosted = deriveConnections({ settings: DEFAULT_SETTINGS, organization, server: { ...server, openai: true, context: true, openaiTrial: { model: 'gpt-6-luna' } }, selfHosted: false, trialLimited: false });
	assert.deepEqual(hosted.context, { state: 'connected', source: 'signin', expiresAt, detail: 'Context.dev sign-in' });
	assert.equal(hosted.openai.state, 'included');
	assert.equal(isReady(hosted.openai), true);
	assert.equal(deriveConnections({ settings: DEFAULT_SETTINGS, organization, server: { ...server, openai: true, openaiTrial: { model: 'gpt-6-luna' } }, selfHosted: false, trialLimited: true }).openai.state, 'missing');
	const expired = deriveConnections({ settings: DEFAULT_SETTINGS, organization: { ...organization, providers: { context: { configured: false, reconnectRequired: true, source: 'signin' as const, expiresAt: 1 } } }, server, selfHosted: false, trialLimited: false });
	assert.equal(expired.context.state, 'expired');
	assert.equal(isReady(expired.context), false);
	assert.equal(formatExpiry(expiresAt, expiresAt - 3 * 3_600_000), 'expires in 3 h');
	assert.equal(formatExpiry(1, 2), 'expired');
});

test('the hosted TypeSafe trial reads as included until a key of the workspace’s own replaces it', () => {
	const trial = { ...server, typesafe: true, typesafeTrial: true };
	const hosted = deriveConnections({ settings: DEFAULT_SETTINGS, organization: null, server: trial, selfHosted: false, trialLimited: true });
	assert.deepEqual(hosted.typesafe, { state: 'included', detail: 'Included TypeSafe trial' }, 'the AI trial limit does not end the TypeSafe trial');
	assert.equal(isReady(hosted.typesafe), true);
	assert.equal(deriveConnections({ settings: { ...DEFAULT_SETTINGS, typesafeKey: 'ts_own_1234567890' }, organization: null, server: trial, selfHosted: false, trialLimited: false }).typesafe.state, 'saved');
	assert.equal(deriveConnections({ settings: DEFAULT_SETTINGS, organization: null, server: trial, selfHosted: true, trialLimited: false }).typesafe.state, 'deployment', 'self-hosted never offers the hosted trial');
});

test('reconnect returns to the same page and the self-hosted MCP config carries required provider headers', () => {
	const href = new URL(contextReconnectHref('/app/sheets/abc?x=1'), 'https://www.enrichable.io');
	assert.equal(href.pathname, '/api/auth/start');
	assert.equal(href.searchParams.get('returnTo'), '/app/sheets/abc?x=1');
	assert.equal(href.searchParams.get('reconnect'), 'context');
	assert.deepEqual(JSON.parse(mcpConfig('https://self.example/mcp', 'enr_mcp_secret', true)).mcpServers.enrichable.headers, { Authorization: 'Bearer enr_mcp_secret', 'x-openai-key': 'YOUR_OPENAI_API_KEY', 'x-context-key': 'YOUR_CONTEXT_DEV_API_KEY' });
	assert.deepEqual(JSON.parse(mcpConfig('https://www.enrichable.io/mcp', undefined, false)).mcpServers.enrichable.headers, { Authorization: 'Bearer YOUR_AGENT_KEY' });
});
