import { z } from 'zod';
import { DEFAULT_MODEL } from './types';
import { logoDomain } from './organization-logo';

export const PROVIDERS = ['openai', 'looot', 'typesafe', 'moltsets', 'anthropic'] as const;
export type Provider = typeof PROVIDERS[number];
export const providerField = { openai: 'openaiKey', looot: 'loootKey', typesafe: 'typesafeKey', moltsets: 'moltsetsKey', anthropic: 'anthropicKey' } as const;
export const MODEL_ID = /^[a-z0-9.\-_:/]+$/i;
/** Classifier setting that selects the Decisions API (TypeSafe Jev) rather than naming a model. */
export const DECISIONS_CLASSIFIER = 'decisions';
export const organizationPreferencesSchema = z.object({
 companyDomain: z.string().max(253).refine((value) => !value || Boolean(logoDomain(value)), 'Enter a valid company website.').optional(),
 model: z.string().min(1).max(100).regex(MODEL_ID).default(DEFAULT_MODEL),
 classifierModel: z.string().min(1).max(100).regex(MODEL_ID).default(DECISIONS_CLASSIFIER),
 openaiBaseUrl: z.string().max(512).default(''),
 concurrency: z.number().int().min(1).max(16).default(4),
 preferJev: z.boolean().default(true),
});
export type OrganizationPreferences = z.infer<typeof organizationPreferencesSchema>;
export type ProviderStatus = { configured: boolean; disconnected?: boolean; prefix?: string; source?: 'manual' | 'signin'; expiresAt?: number; reconnectRequired?: boolean; updatedAt?: number };
export type OrganizationSettings = { revision: number; preferences: OrganizationPreferences; providers: Partial<Record<Provider, ProviderStatus>> };
export const organizationSettingsPatchSchema = z.strictObject({
 revision: z.number().int().min(0),
 preferences: organizationPreferencesSchema.partial().optional(),
 providers: z.partialRecord(z.enum(PROVIDERS), z.string().trim().min(1).max(512).regex(/^[^\r\n]+$/).nullable()).optional(),
 importOnly: z.boolean().default(false),
});
