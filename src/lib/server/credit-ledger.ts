import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Account } from '../auth-identity';
import { OPENAI_KEY_REQUIRED } from '../ai-trial';
import type { FailureProvider } from '../types';
import { EnrichError } from './enrich-failure';
import { withDatabase, workspaceId, type Database, type Sql } from './database';
import { logWorkspaceError } from './workspace-logging';

export const DOLLAR_NANO = 1_000_000_000;
/** Every organization receives this grant in each ledger. */
export const ORGANIZATION_GRANT_USD = 1;
/** Longer than any request lives (maxDuration is 300 s). A function killed mid-call never settles its hold. */
export const RESERVATION_LEASE_SECONDS = 360;
const MAX_ACTIVE = 8, MAX_PER_MINUTE = 120;

export type LedgerKind = 'openai' | 'typesafe' | 'enrichment';
export const LEDGERS = {
	openai: { budgets: 'enrichable.openai_budgets', reservations: 'enrichable.openai_reservations', label: 'AI trial', keyRequired: OPENAI_KEY_REQUIRED, provider: 'openai' },
	typesafe: { budgets: 'enrichable.typesafe_budgets', reservations: 'enrichable.typesafe_reservations', label: 'TypeSafe trial', keyRequired: 'Add your own TypeSafe key in Configuration to continue.', provider: 'typesafe' },
	enrichment: { budgets: 'enrichable.enrichment_budgets', reservations: 'enrichable.enrichment_reservations', label: 'enrichment', keyRequired: 'Add your own provider keys in Configuration to continue enriching.', provider: 'email' },
} as const satisfies Record<LedgerKind, { budgets: string; reservations: string; label: string; keyRequired: string; provider: FailureProvider }>;
export const LEDGER_KINDS = Object.keys(LEDGERS) as LedgerKind[];

export type BudgetReason = 'org_exhausted' | 'deployment_exhausted' | 'rate_limited';
export class CreditBudgetError extends EnrichError {
	readonly status: number;
	constructor(readonly ledger: LedgerKind, readonly reason: BudgetReason) {
		const { label, keyRequired } = LEDGERS[ledger];
		const retry = ' If requests are still running, you can also wait for them to finish and try again.';
		super(reason === 'rate_limited' ? `This workspace is making too many ${label} requests. Wait a moment and try again.`
			: reason === 'org_exhausted' ? `This workspace has insufficient ${label} credit for this request. ${keyRequired}${retry}`
			: `The deployment’s shared ${label} budget cannot fund this request. ${keyRequired}${retry}`,
		{ reason: reason === 'rate_limited' ? 'rate_limited' : 'credits_exhausted', retryable: reason === 'rate_limited', provider: LEDGERS[ledger].provider });
		this.status = reason === 'rate_limited' ? 429 : 402;
	}
}

/** Caps are read on every operation, never cached in a process or taken from deployment environment variables. */
export function creditCapNano(value: unknown): number {
	const cap = Number(value);
	if (!Number.isSafeInteger(cap) || cap <= 0) throw new Error('Missing or invalid deployment credit cap.');
	return cap;
}

export async function readCreditCaps(client: Sql): Promise<Record<LedgerKind, number>> {
	const { rows } = await client.query('SELECT kind, cap_nano FROM enrichable.credit_limits');
	return Object.fromEntries(LEDGER_KINDS.map(kind => [kind, creditCapNano(rows.find(row => row.kind === kind)?.cap_nano)])) as Record<LedgerKind, number>;
}

/** Every statement a ledger runs, built once from its fixed LEDGERS table names; values travel only as bind parameters. */
function ledgerStatements({ budgets, reservations }: (typeof LEDGERS)[LedgerKind]) {
	return {
		ensureGlobal: `INSERT INTO ${budgets} (id) VALUES ('global') ON CONFLICT DO NOTHING`,
		lockGlobal: `SELECT id FROM ${budgets} WHERE id='global' FOR UPDATE`,
		ensureBudget: `INSERT INTO ${budgets} (id) VALUES ($1) ON CONFLICT DO NOTHING`,
		spent: `SELECT id, spent_nano FROM ${budgets} WHERE id IN ($1, 'global')`,
		debit: `UPDATE ${budgets} SET spent_nano=spent_nano+$2 WHERE id IN ($1, 'global')`,
		expireHolds: `UPDATE ${reservations} SET status='uncertain', charged_nano=reserved_nano WHERE budget_id=$1 AND status='held' AND created_at < now() - $2::int * interval '1 second'`,
		countHolds: `SELECT count(*) FILTER (WHERE status='held')::int AS active, count(*) FILTER (WHERE created_at > now() - interval '1 minute')::int AS recent FROM ${reservations} WHERE budget_id=$1 AND (status='held' OR created_at > now() - interval '1 minute')`,
		hold: `INSERT INTO ${reservations} (id, budget_id, reserved_nano) VALUES ($1,$2,$3)`,
		settle: `UPDATE ${reservations} SET status=$2, charged_nano=COALESCE($3, reserved_nano) WHERE id=$1 AND status='held' RETURNING budget_id, reserved_nano`,
	};
}

/** Durable debits include in-flight reservations. Lock the global budget first on every write. */
export class CreditLedger {
	private readonly label: string;
	private readonly sql: ReturnType<typeof ledgerStatements>;
	constructor(readonly kind: LedgerKind, private database: Database) {
		this.label = LEDGERS[kind].label;
		this.sql = ledgerStatements(LEDGERS[kind]);
	}
	private transaction<T>(operation: (client: Sql) => Promise<T>): Promise<T> {
		return this.database.transaction(async (client) => {
			await client.query(this.sql.ensureGlobal);
			await client.query(this.sql.lockGlobal);
			return operation(client);
		});
	}
	private id(account: Account) { return `org:${workspaceId(account)}`; }
	private async spent(client: Sql, budget: string) {
		await client.query(this.sql.ensureBudget, [budget]);
		const { rows } = await client.query(this.sql.spent, [budget]);
		const of = (id: string) => {
			const row = rows.find((entry) => entry.id === id);
			if (!row) throw new Error(`The ${this.label} ledger is missing budget ${id}.`);
			return Number(row.spent_nano);
		};
		// A cap edit waits for in-flight budget checks, so each reservation sees one atomic cap and debit.
		const caps = await client.query('SELECT cap_nano FROM enrichable.credit_limits WHERE kind=$1 FOR SHARE', [this.kind]);
		return { organization: of(budget), deployment: of('global'), ceiling: creditCapNano(caps.rows[0]?.cap_nano) };
	}
	async balance(account: Account) {
		return this.transaction(async (client) => {
			const spent = await this.spent(client, this.id(account));
			return { grantedUsd: ORGANIZATION_GRANT_USD, remainingUsd: Math.max(0, ORGANIZATION_GRANT_USD * DOLLAR_NANO - spent.organization) / DOLLAR_NANO, deploymentAvailable: spent.deployment < spent.ceiling };
		});
	}
	async reserve(account: Account, amount: number) {
		if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`Invalid ${this.label} reservation.`);
		return this.transaction(async (client) => {
			const budget = this.id(account), id = randomUUID();
			const spent = await this.spent(client, budget);
			if (spent.organization + amount > ORGANIZATION_GRANT_USD * DOLLAR_NANO) throw new CreditBudgetError(this.kind, 'org_exhausted');
			if (spent.deployment + amount > spent.ceiling) throw new CreditBudgetError(this.kind, 'deployment_exhausted');
			// An expired hold keeps its whole debit (like any uncertain call) but stops occupying a throttle slot.
			await client.query(this.sql.expireHolds, [budget, RESERVATION_LEASE_SECONDS]);
			const counts = await client.query(this.sql.countHolds, [budget]);
			if (Number(counts.rows[0]?.active) >= MAX_ACTIVE || Number(counts.rows[0]?.recent) >= MAX_PER_MINUTE) throw new CreditBudgetError(this.kind, 'rate_limited');
			await client.query(this.sql.debit, [budget, amount]);
			await client.query(this.sql.hold, [id, budget, amount]);
			return id;
		});
	}
	/** null means billing is uncertain: retain the whole debit; never auto-release a timed-out call. */
	async settle(id: string, actual: number | null) {
		if (actual !== null && (!Number.isSafeInteger(actual) || actual < 0)) throw new Error(`Invalid ${this.label} charge.`);
		return this.transaction(async (client) => {
			const result = await client.query(this.sql.settle, [id, actual === null ? 'uncertain' : 'settled', actual]);
			const row = result.rows[0];
			if (!row) return;
			const adjustment = (actual ?? Number(row.reserved_nano)) - Number(row.reserved_nano);
			await client.query(this.sql.debit, [row.budget_id, adjustment]);
		});
	}
}

export type LedgerAccess = <T>(operation: (ledger: CreditLedger) => Promise<T>) => Promise<T>;
/** The ledger of `kind` with its live database cap. */
export const creditLedger = (kind: LedgerKind, database: Database) => new CreditLedger(kind, database);
/** The ledger of `kind` on Neon, for the length of one operation. */
const ledgerAccess = (kind: LedgerKind): LedgerAccess => (operation) => withDatabase((database) => operation(creditLedger(kind, database)));
export const openaiLedger = ledgerAccess('openai');
export const typesafeLedger = ledgerAccess('typesafe');
export const enrichmentLedger = ledgerAccess('enrichment');
export interface Meter {
	readonly reservation: string;
	/** Final charge in nanodollars. Leave null unless the call proves its cost: null retains the whole reservation. */
	charge: number | null;
}

/** Reserve, call, then settle on one ledger access. A failed or interrupted call may still have been billed, so it
    settles with whatever charge it proved. A settlement that fails leaves the hold to expire as uncertain, which keeps
    the whole reservation debited, so it never costs the caller a result that was paid for. */
export function meteredCall<T>(access: LedgerAccess, account: Account, amount: number, call: (meter: Meter) => Promise<T>): Promise<T> {
	return access(async (ledger) => {
		const meter: Meter = { reservation: await ledger.reserve(account, amount), charge: null };
		let value: T;
		try { value = await call(meter); }
		catch (error) {
			await ledger.settle(meter.reservation, meter.charge).catch(() => {});
			throw error;
		}
		await ledger.settle(meter.reservation, meter.charge).catch((error) => logWorkspaceError(error, { requestId: meter.reservation, operation: `credit-ledger.${ledger.kind}`, phase: 'settle', durationMs: 0 }));
		return value;
	});
}
