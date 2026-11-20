'use client';

import { EntityLabel } from './adaptive-entity-group';
import { LogoLinkImage } from './logolink-image';
import { GraduationCap } from 'lucide-react';
import type { ReactNode } from 'react';
import { profileUrl } from '@/lib/profile-photo';

export { organizationKind } from '@/lib/organization-logo';

/** Five hues from the looot chart palette; a company keeps the same one on every render. */
const MONOGRAM_HUES = [163, 92, 244, 55, 300];

/** The hue for a company's letter tile, picked from its name so the same company always gets the same color. */
export function monogramHue(name: string): number {
	let hash = 0;
	for (const char of name.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return MONOGRAM_HUES[hash % MONOGRAM_HUES.length];
}

/** A company's first letter on a tinted tile. No third-party logo is fetched. */
function Monogram({ name }: { name: string }) {
	const hue = monogramHue(name);
	const letter = name.trim().match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? '?';
	return <span aria-hidden data-monogram className="grid size-4 place-items-center rounded-[4px] text-[10px] font-semibold leading-none" style={{ background: `oklch(0.9 0.05 ${hue} / 0.55)`, color: `oklch(0.42 0.11 ${hue})` }}>{letter}</span>;
}

/** A company or school chip: its logo when the row has a Logo column, else a letter tile. */
export function OrganizationChip({ name, kind, logo, children }: { children?: ReactNode; name: string; kind: 'company' | 'school'; domain?: string; logo?: string | null }) {
	return (
		<span title={name} aria-label={name} data-organization-chip={kind} className="inline-flex min-w-0 max-w-full shrink items-center gap-1 rounded-md bg-neutral-5 px-1.5 py-0.5 text-caption text-fg-muted">
				<LogoLinkImage src={profileUrl(logo)} size={16} className="rounded-[4px]" tile fallback={kind === 'school' ? <GraduationCap className="size-3" strokeWidth={1.5} /> : <Monogram name={name} />} />
				<EntityLabel name={name} />
				{children}
		</span>
	);
}
