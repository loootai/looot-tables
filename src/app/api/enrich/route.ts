import { EnrichRequestSchema } from '@/lib/types';
import { NO_STORE_HEADERS } from '@/lib/server/credentials';
import { routeInput } from '@/lib/server/provider-access';
import { guardedRun, withGuard } from '@/lib/server/guarded-run';

export const maxDuration = 300;

export async function POST(request: Request) {
	const prepared = await routeInput(request, EnrichRequestSchema);
	if (prepared instanceof Response) return prepared;
	const result = await withGuard(prepared.access.account, (guard) => guardedRun(prepared.access, prepared.input, guard));
	return new Response(JSON.stringify(result), { status: 200, headers: NO_STORE_HEADERS });
}
