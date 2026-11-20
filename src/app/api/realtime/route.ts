import { z } from 'zod';
import { parseInput } from '@/lib/workspace';
import { apiRoute } from '@/lib/server/api-route';
import { sealWorkspaceQueries } from '@/lib/server/realtime';

export const GET = apiRoute('realtime.capabilities', async ({ account, request }) => sealWorkspaceQueries(account, parseInput(z.string().min(1).max(128).optional(), new URL(request.url).searchParams.get('sheetId') ?? undefined, 'Invalid sheet ID.')));
