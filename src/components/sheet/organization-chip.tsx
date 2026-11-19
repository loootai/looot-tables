'use client';

import { EntityLabel } from './adaptive-entity-group';
import { LogoLinkImage } from './logolink-image';
import { Building2, GraduationCap } from 'lucide-react';
import type { ReactNode } from 'react';

export { organizationKind } from '@/lib/organization-logo';

export function OrganizationChip({ name, kind, children }: { children?: ReactNode; name: string; kind: 'company' | 'school'; domain?: string }) {
	const Icon = kind === 'school' ? GraduationCap : Building2;
	return (
		<span title={name} aria-label={name} data-organization-chip={kind} className="inline-flex min-w-0 max-w-full shrink items-center gap-1 rounded-md bg-neutral-5 px-1.5 py-0.5 text-caption text-fg-muted">
				<LogoLinkImage src={null} size={16} className="rounded-[4px]" fallback={<Icon className="size-3" strokeWidth={1.5} />} />
				<EntityLabel name={name} />
				{children}
		</span>
	);
}
