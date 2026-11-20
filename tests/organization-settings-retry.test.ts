import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setStorageAccount } from '../src/lib/account-storage';
import { DEFAULT_SETTINGS, initializeOrganizationSettings, keyHeaders, loadSettings, organizationSettingsEnabled, organizationSettingsSnapshot, refreshOrganizationSettings, saveSettings, subscribeSettings } from '../src/lib/keys';

test('a failed first organization load is retryable, never exposes browser secrets, and recovers on a later refresh', async t => {
	const storage = new Map<string, string>([['looot-tables.settings.v1.account.retry-test', JSON.stringify({ ...DEFAULT_SETTINGS, openaiKey: 'sk-browser-secret' })]]);
	const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
	Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } } });
	setStorageAccount({ partition: 'retry-test', sessionId: 'session' });
	let available = false, requests = 0, notifications = 0;
	const unsubscribe = subscribeSettings(() => notifications++);
	t.mock.method(globalThis, 'fetch', async () => {
		requests++;
		return available ? Response.json({ revision: 4, preferences: { ...DEFAULT_SETTINGS, model: 'org-model' }, providers: { context: { configured: true, source: 'signin' } } }) : Response.json({ error: 'Database is waking up.' }, { status: 503 });
	});
	try {
		await assert.rejects(initializeOrganizationSettings(), /waking up/);
		assert.equal(organizationSettingsEnabled(), true, 'A failed hosted load stays in organization mode');
		assert.equal(loadSettings(), DEFAULT_SETTINGS);
		assert.equal(keyHeaders()['x-openai-key'], undefined, 'Browser-local secrets are never sent while the vault is unavailable');
		await assert.rejects(Promise.resolve(saveSettings({ concurrency: 2 })), /still loading/);
		await assert.rejects(initializeOrganizationSettings(), /waking up/);
		assert.equal(requests, 2, 'The rejected promise is not cached');
		available = true;
		await refreshOrganizationSettings();
		assert.equal(requests, 3);
		assert.equal(organizationSettingsSnapshot()?.revision, 4);
		assert.equal(loadSettings().model, 'org-model');
		assert.equal(await initializeOrganizationSettings(), true);
		assert.equal(requests, 3, 'A loaded organization is not requested again');
		assert.ok(notifications >= 3);
	} finally {
		unsubscribe();
		if (previous) Object.defineProperty(globalThis, 'window', previous);
		else Reflect.deleteProperty(globalThis, 'window');
	}
});
