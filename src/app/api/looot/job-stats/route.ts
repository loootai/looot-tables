import { NO_STORE_HEADERS, jsonError } from '@/lib/server/credentials';
import { classifyFailure } from '@/lib/server/enrich-failure';
import { routeAccess } from '@/lib/server/provider-access';
import { jobStats } from '@/lib/server/job-stats';
import { PREFER_VALUES, type Prefer } from '@/lib/server/looot';

/** Free. One job's providers that run now, in the order a routing choice tries them, with measured $/hit and p50. */
export async function GET(request: Request) {
	const access = await routeAccess(request);
	if (access instanceof Response) return access;
	if (!access.key('looot')) return jsonError('Add your looot token in Configuration.', 401);
	const params = new URL(request.url).searchParams;
	const job = params.get('job')?.trim() ?? '';
	const prefer = (PREFER_VALUES as readonly string[]).includes(params.get('prefer') ?? '') ? params.get('prefer') as Prefer : 'balanced';
	if (!/^[a-z0-9_.-]{3,80}$/i.test(job)) return jsonError('Name a looot job, such as people.email.find.', 400);
	try {
		const found = await access.looot().search(job, 50, { capability: job, prefer });
		return Response.json(jobStats(found.endpoints, job, prefer), { headers: { ...NO_STORE_HEADERS, 'cache-control': 'private, max-age=300' } });
	} catch (error) {
		const outcome = classifyFailure(error, 'looot');
		return jsonError(access.redact(error), outcome?.reason === 'credential_invalid' ? 401 : 502, outcome);
	}
}
