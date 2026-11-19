import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import { failureOf, newTrace } from './api-route';
import { withDatabase, type Database } from './database';
import { DOLLAR_NANO, LEDGER_KINDS, LEDGERS, readCreditCaps, ORGANIZATION_GRANT_USD, RESERVATION_LEASE_SECONDS, type LedgerKind } from './credit-ledger';

export const CREDIT_REPORT_PATH = '/api/admin/credits';

export function creditReportAuthorized(request: Request, secret = process.env.ENRICHABLE_CREDITS_REPORT_SECRET) {
	if (!secret || secret.length < 32) return false;
	const authorization = request.headers.get('authorization');
	if (!authorization?.startsWith('Bearer ')) return false;
	const digest = (value: string) => createHash('sha256').update(value).digest();
	return timingSafeEqual(digest(authorization.slice(7)), digest(secret));
}

// A hold past its lease belongs to a killed request; report it as the uncertain debit the next reservation will record.
const budgets = LEDGER_KINDS.map((kind) => `SELECT '${kind}' AS kind, id, spent_nano FROM ${LEDGERS[kind].budgets}`).join(' UNION ALL ');
const reservations = LEDGER_KINDS.map((kind) => `SELECT '${kind}' AS kind, budget_id, CASE WHEN status = 'held' AND created_at < now() - interval '${RESERVATION_LEASE_SECONDS} seconds' THEN 'uncertain' ELSE status END AS status, reserved_nano, COALESCE(charged_nano, reserved_nano) AS charged_nano, created_at FROM ${LEDGERS[kind].reservations}`).join(' UNION ALL ');

export async function readCreditReport(database: Database) {
	const { signups, dailySignups, memberships, rows, limits } = await database.transaction(async (client) => {
		await client.query("SET LOCAL statement_timeout = '10s'");
		const signups = (await client.query(`
			SELECT (SELECT started_at FROM enrichable.signup_tracking WHERE id = true) AS tracking_started_at,
				count(*) AS total,
				count(*) FILTER (WHERE first_signed_in_at >= now() - interval '24 hours') AS last_24_hours,
				count(*) FILTER (WHERE first_signed_in_at >= now() - interval '7 days') AS last_7_days,
				count(*) FILTER (WHERE first_signed_in_at >= now() - interval '30 days') AS last_30_days
			FROM enrichable.signed_in_users
		`)).rows[0];
		const dailySignups = (await client.query(`
			SELECT to_char(first_signed_in_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date, count(*) AS users
			FROM enrichable.signed_in_users
			WHERE first_signed_in_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - interval '29 days'
			GROUP BY 1 ORDER BY 1
		`)).rows;
		const memberships = (await client.query(`
			SELECT workspace_id, count(*) AS total,
				count(*) FILTER (WHERE first_signed_in_at >= now() - interval '24 hours') AS last_24_hours,
				count(*) FILTER (WHERE first_signed_in_at >= now() - interval '7 days') AS last_7_days,
				count(*) FILTER (WHERE first_signed_in_at >= now() - interval '30 days') AS last_30_days
			FROM enrichable.signed_in_memberships GROUP BY workspace_id
		`)).rows;
		const { rows } = await client.query(`
			WITH budgets AS (${budgets}), reservations AS (${reservations}), totals AS (
				SELECT kind, budget_id,
					COALESCE(sum(charged_nano) FILTER (WHERE status = 'settled'), 0) AS settled_nano,
					COALESCE(sum(reserved_nano) FILTER (WHERE status = 'held'), 0) AS held_nano,
					COALESCE(sum(charged_nano) FILTER (WHERE status = 'uncertain'), 0) AS uncertain_nano,
					count(*) FILTER (WHERE status = 'held') AS active_requests,
					max(created_at) AS last_request_at
				FROM reservations GROUP BY kind, budget_id
			), organizations AS (
				SELECT id FROM enrichable.workspaces
				UNION SELECT substring(id FROM 5) FROM budgets WHERE id LIKE 'org:%'
			), subjects AS (
				SELECT id AS workspace_id, 'org:' || id AS budget_id FROM organizations
				UNION ALL SELECT NULL, 'global'
			)
			SELECT s.workspace_id, w.organization_id, w.name, w.issuer, k.kind,
				COALESCE(b.spent_nano, 0) AS spent_nano,
				COALESCE(t.settled_nano, 0) AS settled_nano,
				COALESCE(t.held_nano, 0) AS held_nano,
				COALESCE(t.uncertain_nano, 0) AS uncertain_nano,
				COALESCE(t.active_requests, 0) AS active_requests, t.last_request_at
			FROM subjects s CROSS JOIN (VALUES ${LEDGER_KINDS.map((kind) => `('${kind}')`).join(', ')}) k(kind)
			LEFT JOIN enrichable.workspaces w ON w.id = s.workspace_id
			LEFT JOIN budgets b ON b.id = s.budget_id AND b.kind = k.kind
			LEFT JOIN totals t ON t.budget_id = s.budget_id AND t.kind = k.kind
			ORDER BY s.workspace_id NULLS FIRST, k.kind
		`);
		return { signups, dailySignups, memberships, rows, limits: await readCreditCaps(client) };
	}, { readOnly: true });
	const balance = (row: Record<string, unknown>, grantedUsd: number) => {
		const spentUsd = Number(row.spent_nano) / DOLLAR_NANO;
		return { grantedUsd, spentUsd, remainingUsd: Math.max(0, grantedUsd - spentUsd), usedPercent: spentUsd / grantedUsd * 100 };
	};
	const organizations = new Map<string, { workspaceId: string; organizationId: unknown; name: unknown; issuer: unknown } & Partial<Record<LedgerKind, unknown>>>();
	const deployment: Record<string, unknown> = {};
	for (const row of rows) {
		const kind = row.kind as LedgerKind;
		if (row.workspace_id === null) {
			deployment[kind] = balance(row, limits[kind] / DOLLAR_NANO);
			continue;
		}
		const workspaceId = String(row.workspace_id);
		const organization = organizations.get(workspaceId) ?? { workspaceId, organizationId: row.organization_id, name: row.name, issuer: row.issuer };
		organization[kind] = { ...balance(row, ORGANIZATION_GRANT_USD), settledUsd: Number(row.settled_nano) / DOLLAR_NANO, heldUsd: Number(row.held_nano) / DOLLAR_NANO, uncertainUsd: Number(row.uncertain_nano) / DOLLAR_NANO, activeRequests: Number(row.active_requests), lastRequestAt: row.last_request_at };
		organizations.set(workspaceId, organization);
	}
	const userCounts = (row?: Record<string, unknown>) => ({ totalObserved: Number(row?.total ?? 0), firstSeenLast24Hours: Number(row?.last_24_hours ?? 0), firstSeenLast7Days: Number(row?.last_7_days ?? 0), firstSeenLast30Days: Number(row?.last_30_days ?? 0) });
	const membershipCounts = new Map(memberships.map(row => [String(row.workspace_id), userCounts(row)]));
	return {
		generatedAt: new Date().toISOString(),
		users: {
			...userCounts(signups),
			trackingStartedAt: signups.tracking_started_at,
			definition: 'First observed successful Enrichable OAuth sign-in; historical signups before tracking are unknown. Returning users first seen after tracking began are included.',
			firstSeenByDayUtc: dailySignups.map(row => ({ date: row.date, users: Number(row.users) })),
		},
		deployment,
		organizationCount: organizations.size,
		organizations: [...organizations.values()].map(org => ({ ...org, users: membershipCounts.get(org.workspaceId) ?? userCounts() })),
	};
}

export const loadCreditReport = () => withDatabase((database) => readCreditReport(database));

export async function creditReportResponse(request: Request, load: () => Promise<unknown>) {
	const headers = { 'Cache-Control': 'private, no-store', 'Vary': 'Authorization' };
	if (!creditReportAuthorized(request)) return Response.json({ error: 'Unauthorized.' }, { status: 401, headers });
	const trace = newTrace('admin.credits');
	try { return Response.json(await load(), { headers }); }
	catch (error) {
		const { status, error: message } = failureOf(error, trace);
		return Response.json({ error: message }, { status, headers: { ...headers, 'x-request-id': trace.requestId } });
	}
}
