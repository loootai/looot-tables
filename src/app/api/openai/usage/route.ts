import { apiRoute } from '@/lib/server/api-route';
import { creditLedger } from '@/lib/server/credit-ledger';
import { trialEnabled, TRIAL_MODEL } from '@/lib/server/openai-trial';

export const GET = apiRoute('openai.usage', async ({ account, database }) => trialEnabled() ? { enabled: true, model: TRIAL_MODEL, ...await creditLedger('openai', database).balance(account) } : { enabled: false });
