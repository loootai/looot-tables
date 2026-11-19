import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMAIL_APPS, emailComposeLink } from '../src/lib/email-compose-link';
const draft = { to: 'alice+sales@example.com,bob@example.com', cc: 'cc@example.com', bcc: 'private@example.com', subject: 'Hello & welcome + café', body: 'Hi Alice,\nPrice: $5 & tax\nhttps://example.com/?a=1&b=2' };

test('direct web composers encode every draft field without losing special characters', () => {
 for (const app of EMAIL_APPS.filter((entry) => !['default', 'proton', 'zoho'].includes(entry.id))) {
  const url = new URL(emailComposeLink(app.id, draft));
  assert.equal(url.protocol, 'https:');
  if (app.id === 'slashy') { assert.equal(url.origin, 'https://slashy.com'); assert.equal(url.searchParams.get('compose'), 'true'); }
  for (const [key, value] of Object.entries(draft)) assert.equal(url.searchParams.get(key === 'subject' && app.id === 'gmail' ? 'su' : key), value, `${app.id}: ${key}`);
 }
});
test('default and nested mailto handlers preserve the same draft', () => {
 const mailto = emailComposeLink('default', draft);
 assert.equal(decodeURIComponent(mailto.split('?')[0]), `mailto:${draft.to}`);
 assert.equal(new URL(mailto).searchParams.get('body'), draft.body);
 assert.equal(decodeURIComponent(new URL(emailComposeLink('proton', draft)).hash.slice('#mailto='.length)), mailto);
 assert.equal(new URL(emailComposeLink('zoho', draft)).searchParams.get('ct'), mailto);
});
