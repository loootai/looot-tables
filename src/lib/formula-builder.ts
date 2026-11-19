import { z } from 'zod';

export const FormulaBuilderRequestSchema = z.object({
	ask: z.string().trim().min(1).max(4000),
	formula: z.string().max(8000).default(''),
	target: z.string().regex(/^[A-Z]+[1-9]\d*$/),
	columns: z.array(z.object({ name: z.string().max(200), address: z.string().regex(/^[A-Z]+$/) })).max(500),
	feedback: z.object({
		error: z.string().max(2000).optional(),
		samples: z.array(z.object({ address: z.string(), error: z.string().max(2000), inputs: z.record(z.string(), z.string().max(500)) })).max(10),
	}).optional(),
});
export type FormulaBuilderRequest = z.infer<typeof FormulaBuilderRequestSchema>;
export interface FormulaBuilderResponse { formula: string; explanation: string }

/** Saving is allowed while some preview rows error (e.g. a blank divisor); a formula that fails on every row is blocked. */
export function previewErrors(results: ReadonlyArray<{ error: boolean }>): { errors: number; blocking: boolean; message: string | null } {
	const errors = results.filter((result) => result.error).length;
	if (!errors) return { errors, blocking: false, message: null };
	if (errors === results.length) return { errors, blocking: true, message: results.length === 1 ? 'This formula returns an error. Fix it to continue.' : `All ${results.length} preview rows return errors. Fix the formula to continue.` };
	return { errors, blocking: false, message: `${errors} of ${results.length} preview rows return errors` };
}
