import assert from 'node:assert/strict';
import { test } from 'node:test';
import { positionFormulaDocumentation } from '../src/lib/formula-popup';

const info = { left: 0, right: 360, top: 0, bottom: 260 };
const list = { left: 240, right: 560, top: 180, bottom: 360 };
const option = { ...list, bottom: 210 };
function check(viewport: { left: number; top: number; right: number; bottom: number }, bounds = list) {
	const position = positionFormulaDocumentation(bounds, { ...option, left: bounds.left, right: bounds.right, top: bounds.top }, info, viewport);
	assert.ok(position.left >= viewport.left && position.left + position.width <= viewport.right);
	assert.ok(position.top >= viewport.top && position.top + position.maxHeight <= viewport.bottom);
	const separated = position.left >= bounds.right || position.left + position.width <= bounds.left || position.top >= bounds.bottom || position.top + position.maxHeight <= bounds.top;
	assert.ok(separated, 'documentation must not obscure any suggestions');
	return position;
}

test('documentation opens beside suggestions when space is available', () => {
	assert.ok(check({ left: 0, top: 0, right: 1360, bottom: 900 }).left > list.right);
});
test('narrow windows stack documentation below the full list, not the selected row', () => {
	const position = check({ left: 0, top: 0, right: 672, bottom: 800 });
	assert.ok(position.top > list.bottom);
});
test('near the right edge documentation opens to the left', () => {
	const bounds = { left: 900, right: 1220, top: 180, bottom: 360 };
	assert.ok(check({ left: 0, top: 0, right: 1360, bottom: 900 }, bounds).left < bounds.left);
});
test('near the bottom of a narrow window documentation stacks above with bounded height', () => {
	const bounds = { left: 12, right: 332, top: 350, bottom: 480 };
	const position = check({ left: 0, top: 0, right: 375, bottom: 500 }, bounds);
	assert.ok(position.top + position.maxHeight < bounds.top);
});
