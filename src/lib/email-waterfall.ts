import type { Column, ColumnOp, EmailProvider } from './types';
import { roleColumn, type ColumnRole } from './column-roles';
export const EMAIL_PROVIDER_INFO: Record<EmailProvider, { name: string; baseUsd: number; logo: string }> = {
 quickenrich: { name: 'QuickEnrich', baseUsd: 0.0072, logo: '/providers/quickenrich.png' },
 hunter: { name: 'Hunter', baseUsd: 0.0245, logo: '/providers/hunter.png' },
 apollo: { name: 'Apollo', baseUsd: 0.026, logo: '/providers/apollo.svg' },
 prospeo: { name: 'Prospeo', baseUsd: 0.066, logo: '/providers/prospeo.png' },
 contactout: { name: 'ContactOut', baseUsd: 0.02, logo: '/providers/contactout.png' },
};
export function defaultEmailWaterfall(columns: Column[]): Extract<ColumnOp, { kind: 'email-enrichment' }> {
 const ref = (role: ColumnRole) => { const column = roleColumn(columns, role); return column ? `{{${column.name}}}` : ''; };
 return { kind: 'email-enrichment', name: ref('person') || [ref('first-name'), ref('last-name')].filter(Boolean).join(' '), company: ref('company'), domain: ref('website'), profileUrl: ref('profile'), providers: ['quickenrich', 'hunter', 'apollo', 'prospeo', 'contactout'] };
}
