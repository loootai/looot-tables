import { apiRoute } from '@/lib/server/api-route';
import { creditLedger } from '@/lib/server/credit-ledger';
import { typesafeTrialEnabled } from '@/lib/server/typesafe-trial';

export const GET = apiRoute('typesafe.usage', async ({ account, database }) => typesafeTrialEnabled() ? { enabled: true, ...await creditLedger('typesafe', database).balance(account) } : { enabled: false });
