import { z } from 'zod';
import { parseInput } from '@/lib/workspace';
import { apiRoute, readJson } from '@/lib/server/api-route';
import { SpendGuard } from '@/lib/server/spend-guard';

const updateSchema = z.union([
	z.object({ capUsd: z.number().finite().min(0).max(10_000) }),
	z.object({ resumeColumn: z.string().min(1).max(128) }),
]);

/** The sheet's spend cap, what it spent and holds, and its halted columns. */
export const GET = apiRoute<{ id: string }>('sheets.spend', ({ account, database, params }) => new SpendGuard(database, account).state(params.id));

/** Change the cap, or resume a halted column. */
export const PUT = apiRoute<{ id: string }>('sheets.spend.update', async ({ account, database, request, params }) => {
	const guard = new SpendGuard(database, account);
	const update = parseInput(updateSchema, await readJson(request));
	if ('capUsd' in update) return guard.setCap(params.id, update.capUsd);
	await guard.resumeColumn(params.id, update.resumeColumn);
	return guard.state(params.id);
});
