import { ComposeColumnRequestSchema } from '@/lib/types';
import { CredentialError, jsonError, NO_STORE_HEADERS } from '@/lib/server/credentials';
import { classifyFailure } from '@/lib/server/enrich-failure';
import { routeInput } from '@/lib/server/provider-access';
import { composeColumn } from '@/lib/server/compose';

export const maxDuration = 180;

export async function POST(request: Request) {
	const prepared = await routeInput(request, ComposeColumnRequestSchema);
	if (prepared instanceof Response) return prepared;
	const { input, access } = prepared;
	try {
		const result = await composeColumn(access, { ...input, hasJev: input.hasJev ?? Boolean(access.key('typesafe')) });
		return new Response(JSON.stringify(result), { status: 200, headers: NO_STORE_HEADERS });
	} catch (error) {
		return jsonError(access.redact(error), error instanceof CredentialError ? error.status : 500, classifyFailure(error));
	}
}
