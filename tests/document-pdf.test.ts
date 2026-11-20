import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentPdfDefinition } from '../src/lib/document-pdf';

test('PDF export keeps document structure and text formatting, and excludes executable HTML and unsafe links', () => {
 const definition = documentPdfDefinition('# Brief\n\n**Bold** and *italic*. [Source](https://example.com)\n\n- First\n- Second\n\n| Metric | Value |\n| --- | --- |\n| Team | 20 |\n\n<script>alert(1)</script>\n\n[Unsafe](javascript:alert%281%29)', 'Document');
 assert.equal(definition.info?.title, 'Brief');
 const serialized = JSON.stringify(definition.content);
 assert.ok(serialized.includes('"bold":true'));
 assert.ok(serialized.includes('"italics":true'));
 assert.ok(serialized.includes('"ul":'));
 assert.ok(serialized.includes('"headerRows":1'));
 assert.ok(serialized.includes('"link":"https://example.com"'));
 assert.ok(serialized.includes('Second'));
 assert.ok(serialized.includes('Unsafe'));
 assert.ok(!serialized.includes('javascript:'));
 assert.ok(!serialized.includes('<script>'));
});

test('primary brand controls the full-height accent, with an optional secondary mark', () => {
 const definition = documentPdfDefinition('# Dossier', 'Document', { primary: { name: 'Publisher', domain: 'publisher.com', accentColor: '#c72555' }, secondary: { name: 'Client', domain: 'client.com', accentColor: '#00ff00' } });
 assert.equal(typeof definition.background, 'function');
 if (typeof definition.background !== 'function') throw new Error('Missing page background');
 const background = JSON.stringify(definition.background(1, { width: 595, height: 842, orientation: 'portrait' }));
 assert.ok(background.includes('#c72555'));
 assert.ok(background.includes('842'));
 assert.ok(!background.includes('#00ff00'));
 const header = JSON.stringify(definition.header);
 assert.ok(header.indexOf('Publisher') < header.indexOf('Client'));
 assert.ok(header.includes('"alignment":"left"'));
 assert.ok(header.includes('"alignment":"right"'));
 assert.equal(definition.info?.title, 'Publisher × Client');
 const content = JSON.stringify(definition.content);
 assert.ok(content.includes('Publisher × Client'));
 assert.ok(!content.includes('Dossier'));
});

test('branded titles preserve the body and are added when the document has no main heading', () => {
 const branding = { primary: { name: 'Publisher', domain: 'publisher.com', logoData: 'data:image/png;base64,primary' }, secondary: { name: 'Client', domain: 'client.com', logoData: 'data:image/png;base64,secondary' } };
 const definition = documentPdfDefinition('## Overview\n\nBody text.', 'Document', branding);
 const content = JSON.stringify(definition.content);
 assert.ok(content.indexOf('Publisher × Client') < content.indexOf('Overview'));
 assert.ok(content.includes('Body text.'));
 const header = JSON.stringify(definition.header);
 assert.ok(header.includes(branding.primary.logoData));
 assert.ok(header.includes(branding.secondary.logoData));
});

test('single-page exports omit page numbering; multiple pages show current and total', () => {
 const definition = documentPdfDefinition('# Dossier', 'Document');
 if (typeof definition.footer !== 'function') throw new Error('Missing footer');
 const size = { width: 595, height: 842, orientation: 'portrait' as const };
 assert.ok(!JSON.stringify(definition.footer(1, 1, size)).includes('1 / 1'));
 assert.ok(JSON.stringify(definition.footer(2, 3, size)).includes('2 / 3'));
});

test('same-company dossiers show one brand and invalid accent colors use a neutral fallback', () => {
 const primary = { name: 'Publisher', domain: 'publisher.com', accentColor: 'not-a-color' };
 const definition = documentPdfDefinition('# Dossier', 'Document', { primary, secondary: primary });
 assert.ok(!JSON.stringify(definition.header).includes('×'));
 if (typeof definition.background !== 'function') throw new Error('Missing background');
 assert.ok(JSON.stringify(definition.background(1, { width: 595, height: 842, orientation: 'portrait' })).includes('#64748b'));
});
