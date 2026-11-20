import { parseNumericInput } from './formula-input';
import { uniqueName } from './references';
import { exportValue } from './cell-admission';
import { formatValue } from './template';
import type { CellValue, Column, Row } from './types';

/** RFC 4180-ish parser: quotes, escaped quotes, embedded newlines, CRLF, BOM. */
export function parseCsv(text: string): string[][] {
	const input = text.replace(/^﻿/, '');
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let inQuotes = false;
	const delimiter = detectDelimiter(input);
	for (let i = 0; i < input.length; i++) {
		const char = input[i];
		if (inQuotes) {
			if (char === '"') {
				if (input[i + 1] === '"') {
					field += '"';
					i++;
				} else inQuotes = false;
			} else field += char;
			continue;
		}
		if (char === '"') inQuotes = true;
		else if (char === delimiter) {
			row.push(field);
			field = '';
		} else if (char === '\n' || char === '\r') {
			if (char === '\r' && input[i + 1] === '\n') i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
		} else field += char;
	}
	if (field !== '' || row.length) {
		row.push(field);
		rows.push(row);
	}
	return rows.filter((entry) => entry.some((cell) => cell.trim() !== ''));
}

function detectDelimiter(text: string): string {
	const counts = new Map([[',', 0], ['\t', 0], [';', 0]]);
	let inQuotes = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char === '"') {
			if (inQuotes && text[i + 1] === '"') i++;
			else inQuotes = !inQuotes;
		} else if (!inQuotes) {
			if (char === '\n' || char === '\r') {
				if (text.slice(0, i).trim()) break;
			} else if (counts.has(char)) counts.set(char, counts.get(char)! + 1);
		}
	}
	return [...counts].sort((a, b) => b[1] - a[1])[0][0];
}

export function csvToRecords(rows: string[][]): { headers: string[]; records: Record<string, CellValue>[] } {
	if (rows.length === 0) return { headers: [], records: [] };
	const headers: string[] = [];
	for (const [index, header] of rows[0].entries()) headers.push(uniqueName(header.trim() || `Column ${index + 1}`, headers));
	const records = rows.slice(1).map((cells) => Object.fromEntries(headers.map((header, index) => {
		const raw = (cells[index] ?? '').trim();
		return [header, raw === '' ? null : (parseNumericInput(raw) ?? raw)];
	})));
	return { headers, records };
}

function escapeCsv(value: string): string {
	return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(columns: Column[], rows: Row[], options: { includeMeta?: boolean } = {}): string {
	const visible = columns.filter((column) => !column.hidden);
	const headers = visible.flatMap((column) => (options.includeMeta && column.type === 'enriched' ? [column.name, `${column.name} (confidence)`, `${column.name} (sources)`] : [column.name]));
	const lines = [headers.map(escapeCsv).join(',')];
	for (const row of rows) {
		const cells = visible.flatMap((column) => {
			const cell = row.cells[column.id];
			const value = formatValue(exportValue(column, cell));
			if (options.includeMeta && column.type === 'enriched') {
				const confidence = cell?.m?.probability ?? cell?.m?.confidence;
				return [value, confidence !== undefined ? confidence.toFixed(2) : '', (cell?.m?.sources ?? []).join(' ')];
			}
			return [value];
		});
		lines.push(cells.map(escapeCsv).join(','));
	}
	return `﻿${lines.join('\r\n')}`;
}

export function downloadBlob(blob: Blob, filename: string) {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = filename;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFilename(name: string): string {
	return name.replace(/[^a-z0-9-_ ]/gi, '').trim().replace(/\s+/g, '-').toLowerCase() || 'sheet';
}
