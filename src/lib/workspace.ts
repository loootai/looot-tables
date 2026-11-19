import { DATE_FORMATS } from './date-format';
import { z } from 'zod';
import { ColumnOpSchema, PopulateRequestSchema, COLUMN_FORMATS } from './types';

export const MAX_SHEETS = 10;
export const MAX_ROWS = 1000;
/** Sheets saved before version 1 may still call their website column "Domain", and before version 2 may hold results
    fingerprinted by column name (`v1:`); see `upgradeGrid`. */
export const SHEET_DATA_VERSION = 2;
const identifier = z.string().min(1).max(128);
const cellValue = z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(z.string())]);
export const sheetSchema = z.object({
	id: identifier, name: z.string().min(1).max(300),
	columns: z.array(z.object({ id: identifier, name: z.string().max(300), type: z.enum(['source', 'enriched']), op: ColumnOpSchema.optional(), width: z.number().finite().positive(), hidden: z.boolean().optional(), format: z.enum(COLUMN_FORMATS).optional(), categoryOptions: z.array(z.string().trim().min(1).max(200)).min(1).max(100).refine((options) => new Set(options).size === options.length, 'Categories must be unique.').optional(), categoryColors: z.record(z.string().min(1).max(200), z.string().regex(/^#[a-f0-9]{6}$/i)).refine((colors) => Object.keys(colors).length <= 100, 'Up to 100 category colors.').optional(), currency: z.enum(['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'INR', 'JPY']).optional(), unit: z.string().max(30).optional(), dateFormat: z.enum(DATE_FORMATS).optional(), useGrouping: z.boolean().optional(), decimalPlaces: z.number().int().min(0).max(10).optional(), createdAt: z.number().finite() })).max(200).refine((columns) => columns.every((column) => column.format !== 'category' || Boolean(column.categoryOptions?.length)), 'Add at least one category.'),
	filters: z.array(z.object({ id: identifier, columnId: identifier, op: z.enum(['contains', 'not_contains', 'equals', 'not_equals', 'empty', 'not_empty', 'true', 'false', 'gt', 'lt', 'error']), value: z.string().optional() })),
	sort: z.object({ columnId: identifier, dir: z.enum(['asc', 'desc']) }).nullable(),
	populate: PopulateRequestSchema.optional(), dataVersion: z.number().int().positive().optional(), createdAt: z.number().finite(), updatedAt: z.number().finite(),
});
export const rowSchema = z.object({
	id: identifier, sheetId: identifier, order: z.number().finite(), createdAt: z.number().finite(),
	cells: z.record(identifier, z.object({ v: cellValue, f: z.string().optional(), s: z.enum(['idle', 'queued', 'running', 'done', 'error']), e: z.string().optional(), m: z.record(z.string(), z.unknown()).optional(), owner: identifier.optional(), t: z.number().finite() })),
});
export const createSheetSchema = z.object({ sheet: sheetSchema, rows: z.array(rowSchema).max(MAX_ROWS).default([]) });
export const patchSheetSchema = z.object({ revision: z.number().int().positive(), sheet: sheetSchema, rows: z.array(rowSchema).max(MAX_ROWS), deleted: z.array(identifier).max(MAX_ROWS) });

export class WorkspaceError extends Error {
	constructor(message: string, public status = 400) { super(message); }
}

/** Parses what a caller sent. Only this kind of schema failure is the caller's (400); one on stored data is the server's. */
export function parseInput<S extends z.ZodType>(schema: S, value: unknown, fallback = 'Invalid request.'): z.output<S> {
	const parsed = schema.safeParse(value);
	if (!parsed.success) throw new WorkspaceError(parsed.error.issues[0]?.message || fallback, 400);
	return parsed.data;
}
