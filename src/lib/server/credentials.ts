import 'server-only';
import type { EnrichFailure, FailureProvider, FailureReason } from '../types';
import { EnrichError } from './enrich-failure';

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/* Credential primitives shared by the provider-access module and routes: the credential error, OpenAI endpoint
   safety, error text that never echoes a key, and the envelope stored secrets are encrypted in. Where each key comes
   from lives in provider-access.ts. */

export class CredentialError extends EnrichError {
	status: number;
	constructor(message: string, status = 401, reason: FailureReason = status === 401 ? 'credential_missing' : 'input_invalid', provider?: FailureProvider) {
		super(message, { reason, retryable: false, ...(provider ? { provider } : {}) });
		this.status = status;
	}
}

export const clean = (value: string | null | undefined) => {
	const text = (value ?? '').trim();
	if (!text || text.length > 512 || /[\r\n]/.test(text)) return null;
	return text;
};

export function safeBaseUrl(value: string | null | undefined): string | null {
	const text = clean(value);
	if (!text) return null;
	try {
		const url = new URL(text);
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
		if (!isAllowedHost(url.hostname)) return null;
		return url.toString().replace(/\/$/, '');
	} catch {
		return null;
	}
}

/* The server forwards requests to the base URL, so it must never be pointed at the deployment's own network.
   Loopback is allowed only outside production (local model servers, the mock in scripts/) or when opted in. */
function localAllowed(): boolean {
	return process.env.NODE_ENV !== 'production' || process.env.LOOOT_TABLES_ALLOW_LOCAL_BASE_URL === 'true';
}

/** True for loopback, link-local, private and otherwise non-public addresses (IPv4, IPv6 and IPv4-mapped IPv6). */
export function isPrivateAddress(address: string): boolean {
	let ip = address.toLowerCase().replace(/^\[|\]$/g, '');
	if (ip.startsWith('::ffff:')) {
		ip = ip.slice(7);
		// Hex form of an IPv4-mapped address (::ffff:a00:5) → dotted form.
		const hex = ip.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
		if (hex) {
			const high = parseInt(hex[1], 16);
			const low = parseInt(hex[2], 16);
			ip = `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
		}
	}
	if (isIP(ip) === 4) {
		const [a, b] = ip.split('.').map(Number);
		return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
	}
	if (isIP(ip) === 6) return ip === '::1' || ip === '::' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb');
	return false;
}

function isAllowedHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1') return localAllowed();
	if (isIP(host)) return !isPrivateAddress(host);
	return host.includes('.');
}

/** Rejects base URLs that are not public http(s), then resolves the host and rejects names that point at private
   addresses (DNS rebinding). The provider-access module runs this before every OpenAI request to a custom endpoint. */
export async function ensureSafeEndpoint(baseUrl: string | null | undefined, resolve: (host: string) => Promise<Array<{ address: string }>> = (host) => lookup(host, { all: true })): Promise<void> {
	if (!baseUrl) return;
	const safe = safeBaseUrl(baseUrl);
	if (!safe) throw new CredentialError('The OpenAI base URL must be a public http(s) URL.', 400);
	const host = new URL(safe).hostname.replace(/^\[|\]$/g, '');
	if (host === 'localhost' || host.endsWith('.localhost') || isIP(host)) return;
	let addresses: Array<{ address: string }>;
	try {
		addresses = await resolve(host);
	} catch {
		throw new CredentialError('The OpenAI base URL host could not be resolved.', 400);
	}
	if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address) && !localAllowed())) {
		throw new CredentialError('The OpenAI base URL must point at a public host.', 400);
	}
}

export const NO_STORE_HEADERS = { 'cache-control': 'no-store', 'content-type': 'application/json' } as const;

export function jsonError(message: string, status = 400, failure?: EnrichFailure): Response {
	return new Response(JSON.stringify({ error: message, ...(failure ? { failure } : {}) }), { status, headers: NO_STORE_HEADERS });
}

/** Normalize SDK validation arrays and nested messages before formatting or redacting. */
function errorText(value: unknown): string | undefined {
 if (typeof value === 'string') return value || undefined;
 if (typeof value === 'number' || typeof value === 'boolean') return String(value);
 if (Array.isArray(value)) return value.map((item) => errorText(item)).filter(Boolean).join('; ') || undefined;
 if (value && typeof value === 'object' && 'message' in value) {
  const detail = value as { message?: unknown; path?: unknown };
  if (detail.message === value) return undefined;
  const message = errorText(detail.message);
  const path = Array.isArray(detail.path) ? detail.path.filter((part) => typeof part === 'string' || typeof part === 'number').join('.') : '';
  return message ? `${path ? `${path}: ` : ''}${message}` : undefined;
 }
 return undefined;
}

/** Turn SDK/API failures into a short message safe to show in a cell. */
export function describeError(error: unknown): string {
 if (error instanceof EnrichError) return error.message;
 if (error && typeof error === 'object') {
  const detail = error as { status?: unknown; message?: unknown; error?: unknown; name?: unknown };
  const status = typeof detail.status === 'number' ? detail.status : undefined;
  const message = errorText(detail.error) ?? errorText(detail.message) ?? errorText(detail.name) ?? 'Request failed';
  if (status === 401) return `Unauthorized (401): ${message}`;
  if (status === 402) return `Out of credits (402): ${message}`;
  if (status === 429) return 'Rate limited (429). Wait a moment and try again.';
  if (status) return `${message} (${status})`;
  return message.slice(0, 300);
 }
 return (errorText(error) ?? 'Request failed').slice(0, 300);
}

/** Provider errors can echo credentials. Redact before truncation or persistence. */
export function redactError(error: unknown, secrets: Iterable<string | undefined>): string {
 const detail = error && typeof error === 'object' ? error as { status?: unknown; message?: unknown; error?: unknown; name?: unknown } : null;
 let message = detail ? errorText(detail.error) ?? errorText(detail.message) ?? errorText(detail.name) ?? 'Request failed' : errorText(error) ?? 'Request failed';
 for (const key of secrets) {
  if (key && key.length >= 4) message = message.replaceAll(key, '[redacted]');
 }
 // Our own failures carry their wording; the status prefix is for unexplained upstream errors.
 return error instanceof EnrichError ? message.slice(0, 300) : describeError({ status: detail?.status, message });
}

/** An AES-256-GCM envelope, `v1.iv.tag.ciphertext` in base64url, authenticated to `context` (whose secret it is). */
export function encryptSecret(key: Buffer, value: string, context: unknown[]) {
	const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
	cipher.setAAD(Buffer.from(JSON.stringify(context)));
	const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
	return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

/** The secret, or null when the envelope is malformed, was sealed with another key or belongs to another context. */
export function decryptSecret(key: Buffer, envelope: string, context: unknown[]): string | null {
	try {
		const [version, iv, tag, ciphertext, extra] = envelope.split('.');
		if (version !== 'v1' || !iv || !tag || !ciphertext || extra) return null;
		const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
		decipher.setAAD(Buffer.from(JSON.stringify(context)));
		decipher.setAuthTag(Buffer.from(tag, 'base64url'));
		return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
	} catch { return null; }
}
