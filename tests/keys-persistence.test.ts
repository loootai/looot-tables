import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setStorageAccount } from '../src/lib/account-storage';
import { DEFAULT_SETTINGS, keyHeaders, loadSettings, saveSettings } from '../src/lib/keys';

test('provider settings recover after early reads and stay synchronized with browser storage', () => {
 const storage = new Map<string, string>();
 const key = 'enrichable.settings.v1.account.persistence-test';
 const saved = { ...DEFAULT_SETTINGS, openaiKey: 'test-saved-openai', loootKey: 'test-saved-looot' };
 storage.set(key, JSON.stringify(saved));
 let failWrites = false;
 const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
 Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: {
  getItem: (name: string) => storage.get(name) ?? null,
  setItem: (name: string, value: string) => { if (failWrites) throw new Error('Storage unavailable'); storage.set(name, value); },
 } } });
 try {
  assert.equal(loadSettings().openaiKey, '', 'Before account initialization only defaults are available');
  setStorageAccount({ partition: 'persistence-test', sessionId: 'test-session' });
  assert.equal(loadSettings().openaiKey, saved.openaiKey, 'An early read must not hide persisted credentials');
  assert.equal(keyHeaders()['x-looot-key'], saved.loootKey);
  assert.equal(loadSettings(), loadSettings(), 'Unchanged snapshots keep a stable React snapshot');
  storage.set(key, JSON.stringify({ ...saved, openaiKey: 'test-updated-in-another-tab' }));
  assert.equal(loadSettings().openaiKey, 'test-updated-in-another-tab');
  saveSettings({ concurrency: 2 });
  assert.equal(JSON.parse(storage.get(key)!).openaiKey, 'test-updated-in-another-tab', 'Saving another preference preserves stored keys');
  failWrites = true;
  assert.throws(() => saveSettings({ openaiKey: 'not-saved' }), /Storage unavailable/);
  assert.equal(loadSettings().openaiKey, 'test-updated-in-another-tab', 'A failed write never updates the in-memory saved state');
 } finally {
  if (previous) Object.defineProperty(globalThis, 'window', previous);
  else Reflect.deleteProperty(globalThis, 'window');
 }
});
