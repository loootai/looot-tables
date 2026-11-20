import { z } from 'zod';

export const SELF_HOSTED_ISSUER = 'https://self-hosted.looot-tables.localhost';

export const identitySchema = z.object({
	issuer: z.string().url(),
	scope: z.string().max(512).optional(),
	user: z.object({ id: z.string().min(1).max(256), email: z.string().email().max(320), email_verified: z.literal(true), name: z.string().max(256).optional() }),
	organization: z.object({ id: z.string().min(1).max(256), name: z.string().max(256) }),
});
export type Account = z.infer<typeof identitySchema> & { partition: string };
