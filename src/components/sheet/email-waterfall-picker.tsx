'use client';
import { useState } from 'react';
import Image from 'next/image';
import { GripVertical } from 'lucide-react';
import { EMAIL_PROVIDERS, type EmailProvider } from '@/lib/types';
import { EMAIL_PROVIDER_INFO } from '@/lib/email-waterfall';
import { Sortable, SortableItem, SortableItemHandle } from '@/components/ui/sortable';
import { HelpTooltip } from '@/components/ui/help-tooltip';
import { useSettings } from '@/components/app/settings-context';

/** Find email's provider order. Unchecked providers keep their place so re-checking restores the order. */
export function EmailWaterfallPicker({ value, onChange }: { value: EmailProvider[]; onChange: (value: EmailProvider[]) => void }) {
	const { selfHosted, server } = useSettings();
	const includedCredit = !selfHosted && Boolean(server?.enrichmentTrial);
	const [order, setOrder] = useState<EmailProvider[]>(() => {
		const chosen = new Set(value);
		return [...value, ...EMAIL_PROVIDERS.filter((provider) => !chosen.has(provider))];
	});
	const enabled = new Set(value);
	return <div className="w-full">
		<div className="flex items-center gap-1 pb-1 text-body-sm">Providers, in order<HelpTooltip label="About Find email providers">
			<span>Providers run from top to bottom. Drag to reorder or uncheck to skip. Stops at the first work email found, without additional verification.</span>
			<span>Uses the person’s name and company domain, with optional company name and LinkedIn URL.</span>
			{includedCredit ? <>
				<span>Prices are base USD prices for included credit. ContactOut adds $0.10 when a work email is found. Unsuccessful lookups may still incur charges.</span>
				<span>This workspace shares a one-time $1 allowance. Your saved provider keys override included credit for that provider and use your own provider plan.</span>
			</> : <span>Connect provider keys in Configuration → Connections. Lookups use your provider plan and quotas; unsuccessful lookups may still incur charges.</span>}
		</HelpTooltip></div>
		<Sortable value={order} onValueChange={(next) => { setOrder(next); onChange(next.filter((provider) => enabled.has(provider))); }} getItemValue={(provider) => provider} className="space-y-0.5">
			{order.map((provider) => {
				const info = EMAIL_PROVIDER_INFO[provider];
				return <SortableItem key={provider} value={provider} className="flex h-9 items-center gap-2 rounded-md border-0 bg-surface px-1 shadow-none ring-0 hover:bg-neutral-5">
					<SortableItemHandle render={<button type="button" />} aria-label={`Reorder ${info.name}`} className="grid size-6 touch-none place-items-center text-fg-subtle"><GripVertical className="size-3.5" /></SortableItemHandle>
					<Image src={info.logo} alt="" width={18} height={18} unoptimized className="size-[18px] rounded object-contain" />
					<span className="flex-1 text-[12px]">{info.name}</span>{includedCredit && <span className="text-[11px] tabular-nums text-fg-subtle">${info.baseUsd.toFixed(4).replace(/0+$/, '')}</span>}
					<input type="checkbox" aria-label={`Use ${info.name}`} checked={enabled.has(provider)} onChange={(event) => onChange(order.filter((entry) => entry === provider ? event.target.checked : enabled.has(entry)))} className="mx-1 size-3.5 accent-blue-600" />
				</SortableItem>;
			})}
		</Sortable>
	</div>;
}
