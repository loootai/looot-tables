import { z } from 'zod';

export const SELF_HOSTED_ISSUER = 'https://self-hosted.enrichable.localhost';

export const identitySchema = z.object({
	issuer: z.string().url(),
	scope: z.string().max(512).optional(),
	user: z.object({ id: z.string().min(1).max(256), email: z.string().email().max(320), email_verified: z.literal(true), name: z.string().max(256).optional() }),
	organization: z.object({ id: z.string().min(1).max(256), name: z.string().max(256), logolink_public_id: z.string().regex(/^brandLL_[A-Za-z0-9_-]{1,200}$/).optional() }),
});
export type Account = z.infer<typeof identitySchema> & { partition: string };
