interface Rect { left: number; right: number; top: number; bottom: number }

/** Keep documentation beside the list, or outside its entire bounds when stacking. */
export function positionFormulaDocumentation(list: Rect, option: Rect, info: Rect, viewport: Rect) {
	const gap = 8;
	const left = viewport.left + gap, right = viewport.right - gap;
	const top = viewport.top + gap, bottom = viewport.bottom - gap;
	const desiredWidth = 360;
	const minSideWidth = 240;
	const infoHeight = Math.min(info.bottom - info.top, bottom - top);
	const rightSpace = right - list.right - gap;
	const leftSpace = list.left - gap - left;
	if (Math.max(rightSpace, leftSpace) >= minSideWidth) {
		const useRight = rightSpace >= minSideWidth;
		const width = Math.min(desiredWidth, useRight ? rightSpace : leftSpace);
		const y = Math.max(top, Math.min(option.top, bottom - infoHeight));
		return { left: useRight ? list.right + gap : list.left - gap - width, top: y, width, maxHeight: bottom - y };
	}
	const width = Math.min(desiredWidth, right - left);
	const x = Math.max(left, Math.min(list.left, right - width));
	const below = Math.max(0, bottom - list.bottom - gap);
	const above = Math.max(0, list.top - gap - top);
	if (below >= 120 || below >= above) return { left: x, top: list.bottom + gap, width, maxHeight: below };
	const height = Math.min(infoHeight, above);
	return { left: x, top: list.top - gap - height, width, maxHeight: height };
}
