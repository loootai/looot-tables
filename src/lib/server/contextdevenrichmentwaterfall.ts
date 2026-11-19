import 'server-only';
import type { CellMeta, CellValue, ColumnOp, EmailProvider, EnrichFailure, EnrichResponse } from '../types';
import { renderTemplate, toDomain } from '../template';
import { EMAIL_PROVIDER_INFO } from '../email-waterfall';
import { CredentialError } from './credentials';
import type { ProviderAccess } from './provider-access';
import { CreditBudgetError, DOLLAR_NANO, enrichmentLedger, meteredCall, type LedgerAccess } from './credit-ledger';
import { contactLookup } from './contact-providers';
import { afterSpend, classifyFailure, EnrichError, failure, httpFailure, inputError } from './enrich-failure';
import { enrichmentEnabled } from './enrichment-config';

type Identity = { name: string; company: string; domain: string; profileUrl: string };
type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue => v && typeof v === 'object' && !Array.isArray(v) ? v as ObjectValue : {};
const string = (v: unknown) => typeof v === 'string' ? v : '';
const validEmail = (v: unknown): string | null => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && !/[*•]/.test(v) ? v : null;
const verified = (v: unknown) => typeof v === 'string' && ['valid', 'verified'].includes(v.toLowerCase());
export function emailCandidate(provider: EmailProvider, raw: unknown): { email: string | null; verified: boolean; verificationStatus: string } {
 const root = object(raw), data = root.data !== undefined ? object(root.data) : root;
 if (provider === 'hunter') return { email: validEmail(data.email), verified: verified(object(data.verification).status), verificationStatus: string(object(data.verification).status) || 'unknown' };
 if (provider === 'apollo') { const person = object(root.person); return { email: validEmail(person.email), verified: verified(person.email_status) && root.match_confidence !== 'none' && root.match_confidence !== 'low', verificationStatus: string(person.email_status) || 'unknown' }; }
 if (provider === 'prospeo') {
  const person = data.person !== undefined ? object(data.person) : data;
  const email = object(person.email);
  return { email: validEmail(email.email) ?? validEmail(person.email), verified: verified(email.status) || verified(person.emailStatus), verificationStatus: string(email.status) || string(person.emailStatus) || 'unknown' };
 }
 if (provider === 'quickenrich') return { email: validEmail(data.email), verified: Boolean(string(data.emailVerifiedUtc) || string(data.email_verification_date)), verificationStatus: string(data.emailVerifiedUtc) || string(data.email_verification_date) ? 'verified' : 'unknown' };
 const profile = object(root.profile ?? data.profile ?? data);
 const contacts = object(profile.contact_info);
 const emails = profile.work_email ?? contacts.work_email;
 return { email: validEmail(emails) ?? (Array.isArray(emails) ? emails.map(validEmail).find(Boolean) ?? null : null), verified: false, verificationStatus: 'unknown' };
}

export function sharedRequest(provider: EmailProvider, identity: Identity) {
 const { name, domain, company, profileUrl } = identity;
 const [firstName, ...rest] = name.split(/\s+/); const lastName = rest.join(' ');
 switch (provider) {
  case 'quickenrich': return { provider: 'anyapi', endpoint: '/email_finding.quickenrich', input: { body: { firstName, lastName, companyDomain: domain, ...(profileUrl ? { linkedinUrl: profileUrl } : {}) } }, boundUsd: 0.0072 };
  case 'hunter': return { provider: 'hunterio', endpoint: '/email-finder', input: { queryParams: { full_name: name, domain, max_duration: 10 } }, boundUsd: 0.0245 };
  case 'apollo': return { provider: 'apollo', endpoint: '/people/match', input: { queryParams: { name, domain, ...(company ? { organization_name: company } : {}), ...(profileUrl ? { linkedin_url: profileUrl } : {}), reveal_personal_emails: false, reveal_phone_number: false } }, boundUsd: 0.026 };
  case 'prospeo': return { provider: 'anyapi', endpoint: '/person_enrichment.prospeo', input: { body: { fullName: name, companyWebsite: domain, ...(profileUrl ? { linkedinUrl: profileUrl } : {}), onlyVerifiedEmail: false, enrichMobile: false } }, boundUsd: 0.066 };
  case 'contactout': return { provider: 'contactout', endpoint: '/v1/people/enrich/work-email', input: { body: { full_name: name, company_domain: [domain], ...(profileUrl ? { linkedin_url: profileUrl } : {}), include: ['work_email'] } }, boundUsd: 0.12 };
 }
}

type SharedRequest = { provider: string; endpoint: string; input: object; boundUsd: number };
class SharedRunError extends EnrichError {
 readonly uncertain: boolean; readonly costUsd: number;
 constructor(message: string, options: { uncertain?: boolean; costUsd?: number; failure?: EnrichFailure } = {}) {
  super(message, options.failure ?? failure('provider_error', 'email', false));
  this.uncertain = options.uncertain ?? false; this.costUsd = options.costUsd ?? 0;
 }
}
export async function includedRun(access: ProviderAccess, request: SharedRequest, ledger: LedgerAccess = enrichmentLedger): Promise<{ output: unknown; costUsd: number }> {
 if (!access.account || !enrichmentEnabled(access.account)) throw new CredentialError('Sign in to use included enrichment credit, or add your own provider keys in Configuration.', 401, 'credential_missing', 'email');
 const { boundUsd, ...payload } = request;
 const bound = Math.ceil(boundUsd * DOLLAR_NANO);
 return meteredCall(ledger, access.account, bound, async (meter) => {
  try {
   const base = new URL(process.env.ENRICHMENT_API_URL ?? '');
   if (base.protocol !== 'https:' || base.username || base.password) throw new Error('Invalid enrichment service configuration.');
   const headers = { Authorization: `Bearer ${process.env.ENRICHMENT_API_KEY}`, 'Content-Type': 'application/json' };
   const transport = access.fetch();
   const call = (path: string, options: RequestInit = {}) => transport(new URL(path, base), { ...options, headers: { ...headers, ...options.headers }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(35_000) });
   let response = await call('/v1/run', { method: 'POST', headers: { 'Idempotency-Key': meter.reservation }, body: JSON.stringify({ ...payload, maxCost: boundUsd, tag: `email-${meter.reservation}` }) });
   let run = object(await response.json());
   if (!run.runId && [400, 401, 402, 403, 404, 422, 429].includes(response.status)) {
    meter.charge = 0;
    throw response.status === 429 ? new SharedRunError('The included enrichment service is busy. Wait a moment and try again.', { failure: failure('rate_limited', 'email') }) : new SharedRunError('The included enrichment service is unavailable. Add your own provider keys or try later.');
   }
   const runId = string(run.runId);
   if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new SharedRunError('Enrichment returned an invalid run identifier.', { uncertain: true });
   // A synchronous response omits final cost. Retrieve the run for authoritative billing.
   const deadline = Date.now() + 60_000;
   for (let poll = 0; poll < 12 && Date.now() < deadline; poll++) {
    response = await call(`/v1/runs/${encodeURIComponent(runId)}`);
    if (!response.ok) throw new SharedRunError('Could not retrieve enrichment billing. Credit remains reserved.', { uncertain: true });
    run = object(await response.json());
    if (!['READY', 'RUNNING', 'STOPPING'].includes(string(run.status))) break;
    await new Promise(resolve => setTimeout(resolve, 5_000));
   }
   const cost = object(run.cost);
   if (cost.currency === 'USD' && typeof cost.value === 'number' && Number.isFinite(cost.value) && cost.value >= 0) meter.charge = Math.ceil(cost.value * DOLLAR_NANO);
   if (['BLOCKED', 'FAILED', 'STOPPED', 'TIMED_OUT'].includes(string(run.status))) { meter.charge ??= 0; throw new SharedRunError(`Enrichment ${string(run.status).toLowerCase().replace('_', ' ')}. No result was returned.`, { costUsd: meter.charge / DOLLAR_NANO }); }
   if (run.status !== 'COMPLETED' || meter.charge === null) throw new SharedRunError('Enrichment billing is pending. Credit remains reserved; do not immediately rerun this cell.', { uncertain: true });
   if (meter.charge > bound) throw new SharedRunError('Provider pricing exceeded its configured limit. Contact support before retrying.', { uncertain: true, costUsd: meter.charge / DOLLAR_NANO });
   const status = Number(object(run.providerResponse).httpStatus);
   if (status === 404) return { output: null, costUsd: meter.charge / DOLLAR_NANO };
   if (status >= 400) throw new SharedRunError('The enrichment provider could not complete this lookup.', { costUsd: meter.charge / DOLLAR_NANO });
   return { output: run.output, costUsd: meter.charge / DOLLAR_NANO };
  } catch (error) {
   if (error instanceof SharedRunError) throw error;
   throw new SharedRunError('Enrichment could not complete. Credit remains reserved when billing is uncertain.', { uncertain: true });
  }
 });
}

async function directRun(provider: EmailProvider, key: string, identity: Identity, access: ProviderAccess) {
 if (provider === 'hunter' || provider === 'prospeo') {
  const op: ColumnOp = provider === 'hunter' ? { kind: 'hunter', action: 'find', name: identity.name, domain: identity.domain } : { kind: 'prospeo', name: identity.name, domain: identity.domain, profileUrl: identity.profileUrl, field: 'email', onlyVerifiedEmail: false };
  const { result, verification } = await contactLookup(access, op, {});
  return { email: validEmail(result.value), verified: verified(verification), verificationStatus: verification ?? 'unknown' };
 }
 let url: URL, headers: Record<string, string>, body: object | undefined;
 if (provider === 'quickenrich') {
  url = new URL('https://app.quickenrich.io/api/employees/search');
  const [first, ...last] = identity.name.split(/\s+/);
  url.search = new URLSearchParams({ first_name: first, last_name: last.join(' '), company_url: identity.domain, ...(identity.profileUrl ? { linkedin_url: identity.profileUrl } : {}) }).toString();
  headers = { Authorization: `Bearer ${key}` };
 } else if (provider === 'apollo') {
  url = new URL('https://api.apollo.io/api/v1/people/match');
  headers = { 'X-Api-Key': key, 'Content-Type': 'application/json' };
  body = sharedRequest(provider, identity).input.queryParams;
 } else {
  url = new URL('https://api.contactout.com/v1/people/enrich');
  headers = { Authorization: 'basic', token: key, 'Content-Type': 'application/json' };
  body = sharedRequest(provider, identity).input.body;
 }
 const response = await access.fetch(provider)(url, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30_000) });
 if (response.status === 404) return { email: null, verified: false, verificationStatus: 'unknown' };
 if (!response.ok) throw new EnrichError(`${EMAIL_PROVIDER_INFO[provider].name} could not complete this lookup. Check your key and provider credits.`, httpFailure(response.status, 'email'));
 return emailCandidate(provider, await response.json());
}

/** Our own messages explain ledger and included-service failures; own-key provider errors are summarized so they never leak. */
function attemptStatus(error: unknown, outcome: EnrichFailure, ownKey: boolean) {
 if (error instanceof SharedRunError || error instanceof CreditBudgetError) return error.message;
 if (ownKey) return outcome.reason === 'rate_limited' ? 'Provider rate limited. Try again shortly' : 'Provider key, quota, or lookup failed';
 return 'Included credit unavailable. Add provider keys';
}

export async function runEmailWaterfall(access: ProviderAccess, op: Extract<ColumnOp, { kind: 'email-enrichment' }>, row: Record<string, CellValue>, ledger: LedgerAccess = enrichmentLedger): Promise<EnrichResponse> {
 const input = (value: string) => renderTemplate(value, row).trim();
 const identity = { name: input(op.name), company: input(op.company), domain: toDomain(input(op.domain)), profileUrl: input(op.profileUrl) };
 if (!identity.name || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(identity.domain)) throw inputError('Provide a person name and company domain for this row.', 'email');
 if (identity.profileUrl) {
  let profile: URL; try { profile = new URL(identity.profileUrl); } catch { throw inputError('Enter a valid LinkedIn profile URL.', 'email'); }
  if (profile.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(profile.hostname) || !/^\/(in|pub)\//.test(profile.pathname)) throw inputError('Enter a valid LinkedIn profile URL.', 'email');
 }
 const started = Date.now();
 const attempts: NonNullable<CellMeta['enrichment']>['attempts'] = [];
 const failures: EnrichFailure[] = [];
 let costUsd = 0;
 for (const provider of op.providers) {
  // Rerunning would spend again on providers already tried, so the runner must not repeat this automatically.
  if (Date.now() - started > 230_000) return { value: null, error: 'Waterfall time limit reached. Review attempts before retrying.', failure: failure('timeout', 'email', false), meta: { enrichment: { costUsd, attempts } } };
  const key = access.key(provider);
  const attempt = { provider, source: key ? 'own-key' as const : 'included' as const, status: 'No email found', costUsd: 0 };
  attempts.push(attempt);
  try {
   let candidate;
   if (key) candidate = await directRun(provider, key, identity, access);
   else { const result = await includedRun(access, sharedRequest(provider, identity), ledger); costUsd += result.costUsd; attempt.costUsd += result.costUsd; candidate = emailCandidate(provider, result.output); }
   if (!candidate.email) continue;
   attempt.status = 'Found';
   return { value: candidate.email, meta: { provider, reasoning: `Work email found. Provider verification status: ${candidate.verificationStatus}.`, enrichment: { costUsd, attempts, verified: candidate.verified, verificationStatus: candidate.verificationStatus } } };
  } catch (error) {
   // Never leak raw provider responses or silently replace a configured key with included credit.
   const outcome = classifyFailure(error, 'email') ?? failure('provider_error', 'email', false);
   failures.push(outcome);
   attempt.status = attemptStatus(error, outcome, Boolean(key));
   if (error instanceof SharedRunError) {
    costUsd += error.costUsd; attempt.costUsd += error.costUsd;
    if (error.uncertain) return { value: null, error: attempt.status, failure: outcome, meta: { enrichment: { costUsd, attempts } } };
   }
  }
 }
 // A provider that may answer later decides the outcome, unless retrying would pay again for providers that already ran:
 // an own key's lookup is billed out of our sight, so the run's spend says whether any provider did work.
 const later = failures.find(f => f.retryable) ?? failures[0];
 const outcome = later && afterSpend(later, access.spend.paid);
 const error = !outcome ? undefined
  : outcome.retryable ? 'No email found yet. Some providers were rate limited or temporarily unavailable; wait a moment and try again.'
  : later.retryable ? 'No email found. Some providers were rate limited or unavailable after others already ran; review the attempts before running it again.'
  : 'No email found. Some providers were unavailable; check your provider keys and enrichment credit.';
 return { value: null, ...(outcome ? { error, failure: outcome } : {}), meta: { reasoning: 'No work email found', enrichment: { costUsd, attempts } } };
}
