import { z } from 'zod';
import { NO_STORE_HEADERS, jsonError } from '@/lib/server/credentials';
import { classifyFailure } from '@/lib/server/enrich-failure';
import { routeInput } from '@/lib/server/provider-access';

const FeedbackSchema = z.object({
	runId: z.string().min(1).max(200),
	endpointId: z.string().max(200).optional(),
	message: z.string().trim().min(3).max(2000),
});

/** Free. "Report bad result": tells looot which run answered wrongly. Never sends the sheet's other data. */
export async function POST(request: Request) {
	const prepared = await routeInput(request, FeedbackSchema);
	if (prepared instanceof Response) return prepared;
	const { access, input } = prepared;
	try {
		const sent = await access.looot().feedback({ kind: 'bug', message: input.message, runId: input.runId, ...(input.endpointId ? { endpointId: input.endpointId } : {}) });
		return Response.json({ feedbackId: sent.feedbackId ?? null }, { headers: NO_STORE_HEADERS });
	} catch (error) {
		const outcome = classifyFailure(error, 'looot');
		return jsonError(access.redact(error), outcome?.reason === 'credential_invalid' ? 401 : 502, outcome);
	}
}
