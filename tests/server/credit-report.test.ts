import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { NextRequest } from 'next/server';
import { creditReportAuthorized, creditReportResponse, readCreditReport } from '../../src/lib/server/credit-report';
import { proxy } from '../../src/proxy';
import { CreditLedger, RESERVATION_LEASE_SECONDS } from '../../src/lib/server/credit-ledger';
import { workspaceId } from '../../src/lib/server/database';
import { testDatabase } from '../support/database';
import type { Account } from '../../src/lib/auth-identity';

const secret = 'test-report-secret-with-at-least-32-characters';
const url = 'https://www.enrichable.io/api/admin/credits';
function configure(t: TestContext) {
	const values = { ENRICHABLE_CREDITS_REPORT_SECRET: secret, ENRICHABLE_APP_URL: 'https://www.enrichable.io' };
	const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
	Object.assign(process.env, values);
	t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

test('report fails closed and does not access storage without its dedicated bearer token', async t => {
	configure(t);
	let reads = 0;
	const load = async () => { reads++; return { ok: true }; };
	for (const request of [new Request(url), new Request(`${url}?secret=${secret}`), new Request(url, { headers: { authorization: 'Bearer wrong', cookie: `secret=${secret}`, 'x-enrichable-password': secret } })]) {
		assert.equal((await creditReportResponse(request, load)).status, 401);
	}
	assert.equal(reads, 0);
	const request = new Request(url, { headers: { authorization: `Bearer ${secret}` } });
	assert.equal(creditReportAuthorized(request, ''), false);
	assert.equal(creditReportAuthorized(request, 'short'), false);
	const response = await creditReportResponse(request, load);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('cache-control'), 'private, no-store');
	assert.equal(response.headers.get('vary'), 'Authorization');
	const failed = await creditReportResponse(request, async () => { throw new Error('sensitive database credentials'); });
	assert.equal(failed.status, 503);
	assert.equal(JSON.stringify(await failed.json()).includes('sensitive'), false);
	assert.equal(proxy(new NextRequest(url)).status, 401);
	assert.equal(proxy(new NextRequest(url, { headers: { authorization: `Bearer ${secret}` } })).headers.get('x-middleware-next'), '1');
	assert.equal(proxy(new NextRequest('https://www.enrichable.io/api/enrich', { headers: { authorization: `Bearer ${secret}` } })).status, 401);
});

test('report includes unused organizations, orphan budgets, holds and uncertain charges without modifying ledgers', async t => {
	const { db, database } = await testDatabase(t);
	const actor: Account = { issuer: 'https://www.context.dev', organization: { id: 'one', name: 'One' }, user: { id: 'user', email: 'user@example.com', email_verified: true }, partition: 'test' };
	const id = workspaceId(actor);
	await db.query('INSERT INTO enrichable.workspaces (id, issuer, organization_id, name) VALUES ($1,$2,$3,$4), ($5,$2,$6,$7)', [id, actor.issuer, 'one', 'One', 'unused', 'two', 'Two']);
	await db.exec(`INSERT INTO enrichable.signed_in_users (issuer, user_id, first_signed_in_at) VALUES
		('issuer', 'today', now() - interval '1 hour'),
		('issuer', 'week', now() - interval '3 days'),
		('issuer', 'month', now() - interval '15 days'),
		('issuer', 'older', now() - interval '40 days');`);
	await db.query("INSERT INTO enrichable.signed_in_memberships (workspace_id,issuer,user_id) VALUES ($1,'issuer','today')", [id]);
	const ai = new CreditLedger('openai', database), email = new CreditLedger('enrichment', database);
	await ai.settle(await ai.reserve(actor, 300_000_000), 200_000_000);
	await ai.reserve(actor, 100_000_000);
	await ai.settle(await ai.reserve(actor, 50_000_000), null);
	await email.settle(await email.reserve(actor, 1_000_000_000), 1_200_000_000);
	await db.query("INSERT INTO enrichable.openai_budgets (id) VALUES ('org:orphan')");
	const snapshot = async () => (await db.query(`SELECT jsonb_build_object(
		'ai', (SELECT jsonb_agg(b ORDER BY id) FROM enrichable.openai_budgets b),
		'email', (SELECT jsonb_agg(b ORDER BY id) FROM enrichable.enrichment_budgets b),
		'aiReservations', (SELECT jsonb_agg(r ORDER BY id) FROM enrichable.openai_reservations r),
		'emailReservations', (SELECT jsonb_agg(r ORDER BY id) FROM enrichable.enrichment_reservations r)) AS value`)).rows;
	const before = await snapshot();
	const report = await readCreditReport(database);
	assert.equal(report.organizationCount, 3);
	assert.equal(report.users.totalObserved, 4);
	assert.equal(report.users.firstSeenLast24Hours, 1);
	assert.equal(report.users.firstSeenLast7Days, 2);
	assert.equal(report.users.firstSeenLast30Days, 3);
	assert.ok(report.users.trackingStartedAt);
	assert.equal(report.users.firstSeenByDayUtc.reduce((sum, row) => sum + row.users, 0), 3);
	const organization = report.organizations.find(org => org.workspaceId === id)!;
	assert.equal(organization.name, 'One');
	assert.equal(organization.users.totalObserved, 1);
	assert.equal(report.organizations.find(org => org.workspaceId === 'unused')!.users.totalObserved, 0);
	assert.deepEqual(organization.openai, { grantedUsd: 1, spentUsd: 0.35, remainingUsd: 0.65, usedPercent: 35, settledUsd: 0.2, heldUsd: 0.1, uncertainUsd: 0.05, activeRequests: 1, lastRequestAt: (organization.openai as { lastRequestAt: unknown }).lastRequestAt });
	assert.equal((organization.enrichment as { remainingUsd: number }).remainingUsd, 0);
	assert.equal((report.organizations.find(org => org.workspaceId === 'unused')!.openai as { remainingUsd: number }).remainingUsd, 1);
	assert.equal(report.organizations.find(org => org.workspaceId === 'orphan')!.name, null);
	assert.equal((report.deployment.openai as { spentUsd: number }).spentUsd, 0.35);
	assert.equal((report.deployment.enrichment as { spentUsd: number }).spentUsd, 1.2);
	assert.equal((report.deployment.openai as { grantedUsd: number }).grantedUsd, 1000);
	await db.query("UPDATE enrichable.credit_limits SET cap_nano=2500000000000 WHERE kind='openai'");
	const updated = await readCreditReport(database);
	assert.equal((updated.deployment.openai as { grantedUsd: number }).grantedUsd, 2500);
	assert.deepEqual(await snapshot(), before);
	for (const store of [ai, email]) {
		await assert.rejects(store.reserve(actor, -1), /Invalid/);
		await assert.rejects(store.reserve(actor, NaN), /Invalid/);
		await assert.rejects(store.settle('untrusted-id', -1), /Invalid/);
	}
	assert.deepEqual(await snapshot(), before);
	await assert.rejects(db.transaction(async tx => {
		await tx.query('SET TRANSACTION READ ONLY');
		await tx.query('UPDATE enrichable.openai_budgets SET spent_nano=0');
	}), /read.only/i);
});

test('holds past their lease are reported as uncertain without modifying the ledger', async t => {
	const { db, database } = await testDatabase(t);
	const actor: Account = { issuer: 'https://www.context.dev', organization: { id: 'one', name: 'One' }, user: { id: 'user', email: 'user@example.com', email_verified: true }, partition: 'test' };
	const ai = new CreditLedger('openai', database);
	const killed = await ai.reserve(actor, 100_000_000);
	await ai.reserve(actor, 50_000_000);
	await db.query(`UPDATE enrichable.openai_reservations SET created_at = now() - interval '${RESERVATION_LEASE_SECONDS + 1} seconds' WHERE id = $1`, [killed]);
	const report = await readCreditReport(database);
	const openai = report.organizations.find(org => org.workspaceId === workspaceId(actor))!.openai as Record<string, unknown>;
	assert.equal(openai.heldUsd, 0.05);
	assert.equal(openai.uncertainUsd, 0.1);
	assert.equal(openai.activeRequests, 1);
	assert.equal((await db.query<{ held: number }>("SELECT count(*)::int AS held FROM enrichable.openai_reservations WHERE status = 'held'")).rows[0].held, 2, 'the report is read-only');
});
