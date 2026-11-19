import 'server-only';
import { hkdfSync } from 'node:crypto';
import { SELF_HOSTED_ISSUER, type Account } from '../auth-identity';
import { PROVIDERS, organizationPreferencesSchema, organizationSettingsPatchSchema, type OrganizationSettings, type Provider } from '../organization-settings';
import { parseInput, WorkspaceError } from '../workspace';
import { decryptSecret, encryptSecret, ensureSafeEndpoint, safeBaseUrl } from './credentials';
import type { Database, Sql } from './database';

/** Signed-in organizations keep settings and connections on the server; production always does, so a missing database fails loudly. */
export const organizationPersistenceEnabled = (actor: Account | null | undefined) => Boolean(actor && actor.issuer !== SELF_HOSTED_ISSUER && (process.env.DATABASE_URL || process.env.NODE_ENV === 'production'));

export class OrganizationStore {
 constructor(private database: Database, private encryptionSecret = () => process.env.ENRICHABLE_MCP_ENCRYPTION_SECRET) {}
 private key() {
  const secret = this.encryptionSecret();
  if (!secret || secret.length < 32) throw new WorkspaceError('Organization credential encryption is not configured.', 503);
  return Buffer.from(hkdfSync('sha256', secret, '', 'enrichable:organization-providers:v1', 32));
 }
 private decrypt(value: string, workspace: string, provider: Provider) {
  const secret = decryptSecret(this.key(), value, [workspace, provider]);
  if (secret === null) throw new WorkspaceError('The organization connection could not be decrypted. Check the shared server encryption secret.', 503);
  return secret;
 }
 private read<T>(actor: Account, run: (sql: Sql, workspace: string) => Promise<T>) { return this.database.transaction(run, { workspace: actor, readOnly: true }); }
 private write<T>(actor: Account, run: (sql: Sql, workspace: string) => Promise<T>) {
  return this.database.transaction(async (sql, workspace) => {
   await sql.query('INSERT INTO enrichable.organization_settings (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING', [workspace]);
   return run(sql, workspace);
  }, { workspace: actor });
 }
 private async snapshot(sql: Sql, workspace: string): Promise<OrganizationSettings> {
  const config = (await sql.query('SELECT revision,preferences FROM enrichable.organization_settings WHERE workspace_id=$1', [workspace])).rows[0];
  const rows = (await sql.query('SELECT provider,prefix,source,expires_at,updated_at,disabled FROM enrichable.organization_providers WHERE workspace_id=$1', [workspace])).rows;
  return { revision: Number(config?.revision ?? 0), preferences: organizationPreferencesSchema.parse(config?.preferences ?? {}), providers: Object.fromEntries(rows.map((row) => [String(row.provider), { configured: !row.disabled && (!row.expires_at || Number(row.expires_at) > Date.now()), disconnected: Boolean(row.disabled), prefix: String(row.prefix), source: row.source, ...(row.expires_at ? { expiresAt: Number(row.expires_at), reconnectRequired: Number(row.expires_at) <= Date.now() } : {}), updatedAt: Number(row.updated_at) }])) };
 }
 async get(actor: Account) { return this.read(actor, (sql, workspace) => this.snapshot(sql, workspace)); }
 private async audit(sql: Sql, workspace: string, actor: Account, action: string, fields: string[]) {
  await sql.query('INSERT INTO enrichable.organization_settings_audit (workspace_id,actor_id,action,fields,created_at) VALUES ($1,$2,$3,$4::jsonb,$5)', [workspace, actor.user.id, action, JSON.stringify(fields), Date.now()]);
 }
 async patch(actor: Account, input: unknown) {
  const args = parseInput(organizationSettingsPatchSchema, input);
  const endpoint = args.preferences?.openaiBaseUrl;
  // Saved settings never name an endpoint the server would refuse to call, including by DNS.
  if (endpoint) { await ensureSafeEndpoint(endpoint); args.preferences!.openaiBaseUrl = safeBaseUrl(endpoint)!; }
  return this.write(actor, async (sql, workspace) => {
   const current = await this.snapshot(sql, workspace);
   if (current.revision !== args.revision) throw new WorkspaceError('Organization settings changed. Reload before saving.', 409);
   const savedPreferences = (await sql.query('SELECT preferences FROM enrichable.organization_settings WHERE workspace_id=$1', [workspace])).rows[0]?.preferences as Record<string, unknown>;
   if (args.importOnly && Object.keys(savedPreferences ?? {}).length > 0) throw new WorkspaceError('Organization settings already exist. Import cannot overwrite them.', 409);
   const preferences = parseInput(organizationPreferencesSchema, { ...current.preferences, ...args.preferences });
   for (const provider of PROVIDERS) {
    const secret = args.providers?.[provider];
    if (secret === undefined) continue;
    if (args.importOnly && current.providers[provider]) throw new WorkspaceError('An organization provider already exists. Import cannot overwrite it.', 409);
    if (secret === null) {
     await this.saveProvider(sql, workspace, actor, provider, '', 'manual', null);
     await sql.query('UPDATE enrichable.organization_providers SET disabled=true WHERE workspace_id=$1 AND provider=$2', [workspace, provider]);
    }
    else await this.saveProvider(sql, workspace, actor, provider, secret, 'manual', null);
   }
   await sql.query('UPDATE enrichable.organization_settings SET preferences=$2::jsonb,revision=revision+1 WHERE workspace_id=$1', [workspace, JSON.stringify(preferences)]);
   await this.audit(sql, workspace, actor, args.importOnly ? 'import' : 'update', [...Object.keys(args.preferences ?? {}), ...Object.keys(args.providers ?? {})]);
   return this.snapshot(sql, workspace);
  });
 }
 private async saveProvider(sql: Sql, workspace: string, actor: Account, provider: Provider, secret: string, source: 'manual' | 'signin', expiresAt: number | null) {
  await sql.query('INSERT INTO enrichable.organization_providers (workspace_id,provider,encrypted_secret,prefix,source,subject_id,subject_email,expires_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (workspace_id,provider) DO UPDATE SET encrypted_secret=excluded.encrypted_secret,prefix=excluded.prefix,source=excluded.source,subject_id=excluded.subject_id,subject_email=excluded.subject_email,expires_at=excluded.expires_at,updated_at=excluded.updated_at,disabled=false', [workspace, provider, encryptSecret(this.key(), secret, [workspace, provider]), secret.length >= 12 ? secret.slice(0, 7) : '', source, actor.user.id, actor.user.email, expiresAt, Date.now()]);
 }
 async credentials(actor: Account) {
  return this.read(actor, async (sql, workspace) => {
   const settings = await this.snapshot(sql, workspace);
   const rows = (await sql.query('SELECT provider,encrypted_secret,source,expires_at,subject_email,disabled FROM enrichable.organization_providers WHERE workspace_id=$1', [workspace])).rows;
   const keys: Partial<Record<Provider, string>> = {};
   for (const row of rows) {
    if (row.disabled || row.expires_at && Number(row.expires_at) <= Date.now()) continue;
    const provider = row.provider as Provider;
    keys[provider] = this.decrypt(String(row.encrypted_secret), workspace, provider);
   }
   return { settings, keys };
  });
 }
}
