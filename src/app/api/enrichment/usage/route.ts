import { apiRoute } from '@/lib/server/api-route';
import { creditLedger } from '@/lib/server/credit-ledger';
import { enrichmentEnabled } from '@/lib/server/enrichment-config';

export const GET = apiRoute('enrichment.usage', async ({ account, database }) => enrichmentEnabled(account) ? { enabled: true, ...await creditLedger('enrichment', database).balance(account) } : { enabled: false });
