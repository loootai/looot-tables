import type { Column } from './types';

export const CATEGORY_COLORS = ['#d9f2e6', '#dcfce7', '#fef3c7', '#fce7f3', '#ede9fe', '#ffedd5', '#cffafe', '#f1f5f9'];

export function categoryColor(column: Pick<Column, 'categoryOptions' | 'categoryColors'>, option: string) {
	return column.categoryColors && Object.hasOwn(column.categoryColors, option) ? column.categoryColors[option] : CATEGORY_COLORS[Math.max(0, column.categoryOptions?.indexOf(option) ?? 0) % CATEGORY_COLORS.length];
}

export function categoryColorStyle(color: string) {
	const channels = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
	const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
	return { backgroundColor: color, color: luminance > 0.179 ? '#000000' : '#ffffff' };
}
