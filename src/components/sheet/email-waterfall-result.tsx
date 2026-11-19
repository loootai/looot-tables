'use client';

import Image from 'next/image';
import { CircleCheck, CircleMinus, CircleX } from 'lucide-react';
import { EMAIL_PROVIDER_INFO } from '@/lib/email-waterfall';
import type { CellMeta, EmailProvider } from '@/lib/types';

/** Keep the actual attempt order, then show the remaining configured steps. */
export function EmailWaterfallResult({ enrichment, providers }: { enrichment: NonNullable<CellMeta['enrichment']>; providers: EmailProvider[] }) {
 const order = [...new Set([...enrichment.attempts.map(attempt => attempt.provider), ...providers])];
 return <ol aria-label="Email enrichment waterfall results" className="flex flex-col">
  {order.map((provider, index) => {
   const info = EMAIL_PROVIDER_INFO[provider];
   const attempt = enrichment.attempts.find(item => item.provider === provider);
   const found = attempt?.status === 'Found' || attempt?.status === 'Verified';
   const status = !attempt ? 'Not attempted' : found ? `Email found · Provider verification: ${enrichment.verificationStatus ?? (attempt.status === 'Verified' ? 'verified' : 'unknown')}` : attempt.status;
   const StatusIcon = !attempt ? CircleMinus : found ? CircleCheck : CircleX;
   return <li key={provider} className="relative flex min-h-9 items-center gap-2" title={`${info.name}: ${status}${attempt ? ` · ${attempt.source === 'own-key' ? 'Your key' : 'Included credit'}` : ''}`}>
    {index < order.length - 1 && <span aria-hidden="true" className="absolute top-8 left-3.5 h-2 w-px bg-line-subtle" />}
    <span className={`relative z-10 flex size-7 shrink-0 items-center justify-center rounded-md border border-line-subtle bg-surface ${!attempt ? 'opacity-40 grayscale' : ''}`}>
     <Image src={info.logo} alt="" width={18} height={18} unoptimized className="size-[18px] rounded-sm object-contain" />
    </span>
    <span className={`min-w-0 flex-1 text-body-sm ${!attempt ? 'text-fg-subtle' : 'text-fg'}`}>{info.name}</span>
    {!attempt && <span className="text-[11px] text-fg-subtle">Not attempted</span>}
    <StatusIcon aria-hidden="true" strokeWidth={1.75} className={`size-[18px] shrink-0 ${!attempt ? 'rotate-90 text-fg-subtle opacity-50' : found ? 'text-emerald-600' : 'text-danger'}`} />
    <span className="sr-only">{status}</span>
   </li>;
  })}
 </ol>;
}
