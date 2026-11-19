import 'server-only';
import type { Account } from '../auth-identity';
import { workspaceId, type Database } from './database';

export const COMPANY_CONTEXT_TTL = 30 * 24 * 60 * 60 * 1000;
export type CompanyBrand = { domain: string; title?: string; description?: string; links?: unknown };
export type CompanyProfile = { summary: string; sources: string[] };
export type CompanyRecord = { lookup_status: string; brand: CompanyBrand | null; profile: CompanyProfile | null; researched_at: number | null; research_token: string | null };

export class CompanyContextStore {
 constructor(private database: Database) {}
 // Every statement here stands alone; $1 is always the actor's workspace.
 private async read(actor: Account, text: string, args: unknown[] = []) { return (await this.database.read(text, [workspaceId(actor), ...args])).rows; }
 private write(actor: Account, text: string, args: unknown[] = []) { return this.database.transaction(async (sql) => (await sql.query(text, [workspaceId(actor), ...args])).rows); }
 /** Explicit query domains are cached separately and never overwrite the sign-in brand. */
 async forDomain(actor: Account, domain: string): Promise<CompanyResearchStore> {
  const write = (text: string, args: unknown[] = []) => this.write(actor, text, [domain, ...args]);
  await write('INSERT INTO enrichable.company_research (workspace_id,domain) VALUES ($1,$2) ON CONFLICT DO NOTHING');
  return {
   get: async () => {
    const row = (await this.read(actor, 'SELECT profile,researched_at,research_token FROM enrichable.company_research WHERE workspace_id=$1 AND domain=$2', [domain]))[0];
    return { lookup_status: 'ready', brand: { domain }, profile: row.profile as CompanyProfile | null, researched_at: row.researched_at == null ? null : Number(row.researched_at), research_token: row.research_token as string | null };
   },
   claimResearch: async (_actor, token, now = Date.now()) => (await write('UPDATE enrichable.company_research SET research_token=$3,research_until=$4 WHERE workspace_id=$1 AND domain=$2 AND research_until <= $5 AND (researched_at IS NULL OR researched_at <= $6) RETURNING domain', [token, now + 180_000, now, now - COMPANY_CONTEXT_TTL])).length > 0,
   finishResearch: async (_actor, token, profile, now = Date.now()) => { await write('UPDATE enrichable.company_research SET profile=$4::jsonb,researched_at=$5,research_token=NULL,research_until=0 WHERE workspace_id=$1 AND domain=$2 AND research_token=$3', [token, JSON.stringify(profile), now]); },
   failResearch: async (_actor, token, now = Date.now()) => { await write('UPDATE enrichable.company_research SET research_token=NULL,research_until=$4 WHERE workspace_id=$1 AND domain=$2 AND research_token=$3', [token, now + 60_000]); },
  };
 }
 async claimLookup(actor: Account, now = Date.now()) {
  return (await this.write(actor, 'INSERT INTO enrichable.company_context (workspace_id,lookup_at) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING workspace_id', [now])).length > 0;
 }
 async finishLookup(actor: Account, status: string, brand: CompanyBrand | null) {
  await this.write(actor, "UPDATE enrichable.company_context SET lookup_status=$2,brand=$3::jsonb WHERE workspace_id=$1 AND lookup_status='pending'", [status, JSON.stringify(brand)]);
 }
 async get(actor: Account): Promise<CompanyRecord | null> {
  const row = (await this.read(actor, 'SELECT lookup_status,brand,profile,researched_at,research_token FROM enrichable.company_context WHERE workspace_id=$1'))[0];
  return row ? { ...row, researched_at: row.researched_at == null ? null : Number(row.researched_at) } as CompanyRecord : null;
 }
 async claimResearch(actor: Account, token: string, now = Date.now()) {
  return (await this.write(actor, "UPDATE enrichable.company_context SET research_token=$2,research_until=$3 WHERE workspace_id=$1 AND lookup_status='ready' AND research_until <= $4 AND (researched_at IS NULL OR researched_at <= $5) RETURNING workspace_id", [token, now + 180_000, now, now - COMPANY_CONTEXT_TTL])).length > 0;
 }
 async finishResearch(actor: Account, token: string, profile: CompanyProfile, now = Date.now()) {
  await this.write(actor, 'UPDATE enrichable.company_context SET profile=$3::jsonb,researched_at=$4,research_token=NULL,research_until=0 WHERE workspace_id=$1 AND research_token=$2', [token, JSON.stringify(profile), now]);
 }
 async failResearch(actor: Account, token: string, now = Date.now()) {
  await this.write(actor, 'UPDATE enrichable.company_context SET research_token=NULL,research_until=$3 WHERE workspace_id=$1 AND research_token=$2', [token, now + 60_000]);
 }
}

export type CompanyResearchStore = Pick<CompanyContextStore, 'get' | 'claimResearch' | 'finishResearch' | 'failResearch'>;
