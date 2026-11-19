import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ImagePreviews } from '../src/components/sheet/image-previews';
import { detailValue } from '../src/lib/detail-value';

const render = (value: unknown) => renderToStaticMarkup(createElement(ImagePreviews, { value: detailValue(value) }));

test('saved image URL lists render lazy previews and original links, including extensionless URLs', () => {
	const html = render(JSON.stringify(['https://example.com/photo.png', 'https://cdn.example.com/asset?id=1']));
	assert.equal((html.match(/<img /g) ?? []).length, 2);
	for (const text of ['src="https://example.com/photo.png"', 'src="https://cdn.example.com/asset?id=1"', 'loading="lazy"', 'referrerPolicy="no-referrer"', 'object-contain', 'Open image 1', 'rel="noopener noreferrer"']) assert.ok(html.includes(text), text);
});

test('empty, malformed and unsafe values stay readable without image requests', () => {
	assert.ok(render([]).includes('No images found'));
	assert.ok(render(null).includes('Empty'));
	assert.ok(render('{invalid').includes('{invalid'));
	const html = render(['javascript:alert(1)', '<script>alert(1)</script>', 42]);
	assert.ok(!html.includes('<img'));
	assert.ok(!html.includes('href='));
	assert.ok(html.includes('&lt;script&gt;'));
	assert.ok(html.includes('42'));
});
