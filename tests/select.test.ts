import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Select } from '../src/components/ui/select';

test('custom selects expose the selected label and combobox semantics without native form controls', () => {
 const html = renderToStaticMarkup(createElement(Select, {
  value: 'none', onValueChange: () => {}, 'aria-label': 'Research',
 }, [
   createElement('option', { key: 'web', value: 'web' }, 'Search the web'),
   createElement(Fragment, { key: 'other' }, createElement('option', { value: 'none' }, 'Row only')),
  ]));
 assert.match(html, /role="combobox"/);
 assert.match(html, /aria-label="Research"/);
 assert.match(html, /aria-expanded="false"/);
 assert.match(html, /Row only/);
 assert.doesNotMatch(html, /<select|<option/);
 assert.doesNotMatch(html, /Search the web/);
});
