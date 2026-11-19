import { EnrichRequestSchema } from '@/lib/types';
import { NO_STORE_HEADERS } from '@/lib/server/credentials';
import { routeInput } from '@/lib/server/provider-access';
import { runOp } from '@/lib/server/enrich';

export const maxDuration = 300;

export async function POST(request: Request) {
	const prepared = await routeInput(request, EnrichRequestSchema);
	if (prepared instanceof Response) return prepared;
	const result = await runOp(prepared.access, prepared.input.op, prepared.input.row);
	return new Response(JSON.stringify(result), { status: 200, headers: NO_STORE_HEADERS });
}
