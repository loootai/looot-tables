'use client';

import { EntityLabel } from './adaptive-entity-group';
import { LogoLinkImage } from './logolink-image';
import { useSettings } from '@/components/app/settings-context';
import { contextRequest } from '@/lib/context-credits';
import { keyHeaders } from '@/lib/keys';
import { logoDomain, logoLinkUrl } from '@/lib/organization-logo';
import { Building2, GraduationCap } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';

export { organizationKind } from '@/lib/organization-logo';

// Share in-flight lookups across visible cells. Retain only a bounded session cache.
const lookups = new Map<string, Promise<string | null>>();

export function OrganizationChip({ name, kind, domain, children }: { children?: ReactNode; name: string; kind: 'company' | 'school'; domain?: string }) {
	const { settings, server, logolinkPublicId } = useSettings();
	const knownDomain = logoDomain(domain) ?? logoDomain(name);
	const clientId = settings.logolinkKey || logolinkPublicId;
	const canResolve = Boolean(settings.contextKey || server?.context);
	const lookupKey = JSON.stringify([name, settings.contextKey, settings.accessPassword]);
	const [resolved, setResolved] = useState<{ key: string; domain: string | null } | null>(null);

	useEffect(() => {
		if (!clientId || knownDomain || !canResolve || !name.trim()) return;
		let cancelled = false;
		let lookup = lookups.get(lookupKey);
		if (!lookup) {
			lookup = contextRequest('/api/logos/resolve', { method: 'POST', headers: keyHeaders(settings), body: JSON.stringify({ name }) })
				.then(async (response) => response.ok ? (await response.json() as { domain: string | null }).domain : null)
				.catch(() => null);
			if (lookups.size >= 500) lookups.delete(lookups.keys().next().value!);
			lookups.set(lookupKey, lookup);
		}
		void lookup.then((value) => { if (!cancelled) setResolved({ key: lookupKey, domain: logoDomain(value ?? undefined) }); });
		return () => { cancelled = true; };
	}, [clientId, knownDomain, canResolve, name, lookupKey, settings]);

	const resolvedDomain = knownDomain ?? (resolved?.key === lookupKey ? resolved.domain : null);
	const src = clientId && resolvedDomain ? logoLinkUrl(clientId, resolvedDomain) : null;
	const resolving = Boolean(clientId && !knownDomain && canResolve && name.trim() && resolved?.key !== lookupKey);
	const Icon = kind === 'school' ? GraduationCap : Building2;
	return (
		<span title={name} aria-label={name} data-organization-chip={kind} className="inline-flex min-w-0 max-w-full shrink items-center gap-1 rounded-md bg-neutral-5 px-1.5 py-0.5 text-caption text-fg-muted">
				<LogoLinkImage src={src} size={16} className="rounded-[4px]" loading={resolving} fallback={<Icon className="size-3" strokeWidth={1.5} />} />
				<EntityLabel name={name} />
				{children}
		</span>
	);
}
