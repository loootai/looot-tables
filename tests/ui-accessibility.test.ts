import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import nextConfig from '../next.config';
import { announce } from '../src/components/ui/announcer';
import { Field, Input } from '../src/components/ui/field';
import { isImeComposing } from '../src/components/ui/keyboard';
import { ToastProvider } from '../src/components/ui/toast';
import { formatColumnNumber } from '../src/lib/column-format';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const renderField = (props: Parameters<typeof Field>[0]) => renderToStaticMarkup(createElement(Field, props));

test('Enter during IME composition is recognised, including Safari keyCode 229 after compositionend', () => {
	assert.equal(isImeComposing({ nativeEvent: { isComposing: true }, keyCode: 13 }), true);
	assert.equal(isImeComposing({ nativeEvent: { isComposing: false }, keyCode: 229 }), true);
	assert.equal(isImeComposing({ nativeEvent: { isComposing: false }, keyCode: 13 }), false);
});

test('announce prefers document.ariaNotify with a priority matching the urgency', async () => {
	const calls: Array<[string, unknown]> = [];
	Object.assign(globalThis, { document: { ariaNotify: (message: string, options: unknown) => calls.push([message, options]) } });
	try {
		announce('  Saved  ', { delay: 0 });
		announce('Connection lost', { assertive: true, delay: 0 });
		announce('   ', { delay: 0 });
		await tick();
		assert.deepEqual(calls, [['Saved', { priority: 'normal' }], ['Connection lost', { priority: 'high' }]]);
	} finally {
		Reflect.deleteProperty(globalThis, 'document');
	}
});

test('announce falls back to one shared live region per politeness and makes repeats differ', async () => {
	const appended: Array<{ attributes: Record<string, string>; textContent: string; className: string }> = [];
	const document = {
		body: { append: (node: (typeof appended)[number]) => appended.push(node) },
		createElement: () => ({ attributes: {} as Record<string, string>, textContent: '', className: '', isConnected: true, setAttribute(name: string, value: string) { this.attributes[name] = value; } }),
	};
	Object.assign(globalThis, { document });
	try {
		announce('Exported 3 rows', { delay: 0 });
		await tick();
		announce('Exported 3 rows', { delay: 0 });
		await tick();
		announce('Could not save', { assertive: true, delay: 0 });
		await tick();
		assert.equal(appended.length, 2);
		const [polite, assertive] = appended;
		assert.equal(polite.attributes['aria-live'], 'polite');
		assert.equal(polite.attributes['aria-atomic'], 'true');
		assert.equal(polite.className, 'sr-only');
		assert.equal(polite.textContent, 'Exported 3 rows ');
		assert.equal(assertive.attributes['aria-live'], 'assertive');
		assert.equal(assertive.textContent, 'Could not save');
	} finally {
		Reflect.deleteProperty(globalThis, 'document');
	}
});

test('a field error marks its control invalid and describes it only while shown', () => {
	const invalid = renderField({ label: 'Column name', error: 'Give the column a name', children: (id) => createElement(Input, { id, 'aria-describedby': 'hint' }) });
	const errorId = invalid.match(/<p id="([^"]+)"/)?.[1];
	assert.ok(errorId);
	assert.match(invalid, /aria-invalid="true"/);
	assert.ok(invalid.includes(`aria-describedby="hint ${errorId}"`));
	assert.match(invalid, /Give the column a name/);
	const valid = renderField({ label: 'Column name', children: (id) => createElement(Input, { id }) });
	assert.match(valid, /aria-invalid="false"/);
	assert.doesNotMatch(valid, /aria-describedby/);
	const outside = renderToStaticMarkup(createElement(Input, { id: 'free' }));
	assert.doesNotMatch(outside, /aria-invalid/);
});

test('custom field controls receive the same error wiring through the render argument', () => {
	const html = renderField({ label: 'Format', error: 'Choose a format', children: (id, aria) => createElement('button', { id, ...aria }) });
	const errorId = html.match(/<p id="([^"]+)"/)?.[1];
	assert.ok(html.includes(`aria-describedby="${errorId}"`));
	assert.match(html, /<button[^>]*aria-invalid="true"/);
});

test('toasts live in a named notifications region without a chatty container live region', () => {
	const html = renderToStaticMarkup(createElement(ToastProvider, null, 'content'));
	assert.match(html, /role="region"/);
	assert.match(html, /aria-label="Notifications"/);
	assert.doesNotMatch(html, /aria-live/);
});

test('every response carries a report-only CSP that keeps outbound connections and embedding locked down', async () => {
	const rules = await nextConfig.headers!();
	const headers = rules.find((rule) => rule.source === '/(.*)')!.headers;
	const csp = headers.find((header) => header.key === 'Content-Security-Policy-Report-Only')?.value ?? '';
	const directives = Object.fromEntries(csp.split(';').map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
	assert.deepEqual(directives['object-src'], ["'none'"]);
	assert.deepEqual(directives['base-uri'], ["'none'"]);
	assert.deepEqual(directives['frame-ancestors'], ["'none'"]);
	assert.deepEqual(directives['form-action'], ["'self'"]);
	assert.deepEqual(directives['connect-src'], ["'self'", 'https://basket.databuddy.cc', 'https://api.databuddy.cc']);
	assert.ok(directives['script-src'].includes("'wasm-unsafe-eval'"));
	assert.ok(directives['script-src'].includes('https://cdn.databuddy.cc'));
	assert.equal(headers.some((header) => header.key === 'Content-Security-Policy'), false);
});

test('reused number formatters keep per-column options apart', () => {
	assert.equal(formatColumnNumber(1234.5, { format: 'currency' }), '$1,234.50');
	assert.equal(formatColumnNumber(1234.5, { format: 'currency', currency: 'EUR' }), '€1,234.50');
	assert.equal(formatColumnNumber(1234.5, { format: 'currency' }), '$1,234.50');
	assert.equal(formatColumnNumber(0.256, { format: 'percent' }), '25.6%');
	assert.equal(formatColumnNumber(1234.5, { format: 'number', decimalPlaces: 0 }), '1,235');
});
