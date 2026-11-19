import 'server-only';
import { hkdfSync } from 'node:crypto';
import { jwtDecrypt } from 'jose';
import { z } from 'zod';
import type { Account } from '../auth-identity';
import { authConfig, authCookieName, readSession, SESSION_COOKIE } from './auth';

export const CONTEXT_CONNECTION_COOKIE = authCookieName('context');
const connectionSchema = z.object({ sub: z.string(), organization_id: z.string(), context_api_key: z.string().min(1).max(512).regex(/^[^\r\n]+$/), context_api_key_id: z.string().min(1), scope: z.literal('data:execute logs:read') });

export async function readContextConnection(token: string, account: Account) {
	if (token.length > 3800) throw new Error('Invalid Context.dev connection');
	const config = authConfig();
	const key = Buffer.from(hkdfSync('sha256', config.clientSecret, '', 'enrichable:context-connection:v1', 32));
	const { payload } = await jwtDecrypt(token, key, { issuer: config.issuer, audience: `context-api:${config.clientId}`, keyManagementAlgorithms: ['dir'], contentEncryptionAlgorithms: ['A256GCM'], typ: 'context-connection+jwt', requiredClaims: ['exp', 'iat', 'sub'] });
	const connection = connectionSchema.parse(payload);
	if (connection.sub !== account.user.id || connection.organization_id !== account.organization.id) throw new Error('Context.dev connection belongs to another account');
	return { key: connection.context_api_key, keyId: connection.context_api_key_id, expiresAt: payload.exp! * 1000 };
}

export async function decryptContextConnection(token: string, account: Account) { return (await readContextConnection(token, account)).key; }

export async function contextConnectionKey(request: Request): Promise<string | null> {
	const cookies = new Map((request.headers.get('cookie') ?? '').split(';').map((entry) => { const index = entry.indexOf('='); return [entry.slice(0, index).trim(), entry.slice(index + 1)] as const; }));
	const token = cookies.get(CONTEXT_CONNECTION_COOKIE);
	const account = readSession(cookies.get(SESSION_COOKIE));
	if (!token || !account) return null;
	try { return await decryptContextConnection(token, account); }
	catch { return null; }
}

