import { track } from '@databuddy/sdk';

/** Databuddy is off unless a deployment sets its client ID, so self-hosted copies send nothing. */
export const ANALYTICS_CLIENT_ID = process.env.NEXT_PUBLIC_DATABUDDY_CLIENT_ID?.trim() || undefined;

/** Product events. Properties describe the action only: never sheet contents, prompts or keys. */
export interface AnalyticsEvents {
	sheet_created: { source: 'blank' | 'companies' | 'people' | 'websites' | 'import' };
	rows_requested: { kind: string };
	column_added: { kind: string };
	enrichment_started: { cells: number };
	sheet_exported: { format: string };
	keys_saved: { providers: number };
}

export function trackEvent<Name extends keyof AnalyticsEvents>(name: Name, properties: AnalyticsEvents[Name]) {
	if (!ANALYTICS_CLIENT_ID) return;
	track(name, { ...properties });
}
