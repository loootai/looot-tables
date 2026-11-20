import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PersonAvatar } from '../src/components/sheet/person-avatar';
import { profileUrl } from '../src/lib/profile-photo';

test('photos load lazily with a simple placeholder until ready', () => {
 const html = renderToStaticMarkup(createElement(PersonAvatar, { src: 'https://cdn.example.com/person.jpg' }));
 assert.ok(html.includes('src="https://cdn.example.com/person.jpg"'));
 assert.ok(html.includes('loading="lazy"'));
 assert.ok(html.includes('referrerPolicy="no-referrer"'));
 assert.ok(html.includes('data-person-placeholder'));
 assert.ok(html.includes('<circle'));
});

test('missing or invalid photos render the person icon without an image request', () => {
 for (const src of [null, '', 'not a URL', 'javascript:alert(1)', 'data:image/svg+xml,test', 'https://user:pass@example.com/photo']) {
  const html = renderToStaticMarkup(createElement(PersonAvatar, { src }));
  assert.ok(html.includes('data-person-placeholder'));
  assert.ok(!html.includes('<img'));
  assert.equal(profileUrl(src), null);
 }
});

test('a path on this deployment is a photo; a protocol-relative or backslash path is not', () => {
 assert.equal(profileUrl('/demo/people/maya-rios.jpg'), '/demo/people/maya-rios.jpg');
 for (const src of ['//evil.example/a.jpg', '/\\evil.example/a.jpg', '/a b.jpg']) assert.equal(profileUrl(src), null, src);
});
