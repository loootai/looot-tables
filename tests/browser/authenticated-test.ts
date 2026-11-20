import { createHash, createHmac } from 'node:crypto';
import { test as base } from '@playwright/test';

export function memberCookie(userId: string) {
	const issuer = 'http://127.0.0.1:3102';
	const user = { id: userId, email: `${userId}@example.com`, email_verified: true };
	const organization = { id: 'browser-org', name: 'Browser tests' };
	const partition = createHash('sha256').update(JSON.stringify([issuer, user.id, organization.id])).digest('hex');
	const body = Buffer.from(JSON.stringify({ value: { issuer, user, organization, partition, sessionId: 'browser-session'.repeat(3) }, purpose: 'session', exp: Date.now() + 3_600_000 })).toString('base64url');
	return `${body}.${createHmac('sha256', 'browser-test-session-secret-32-characters').update(body).digest('base64url')}`;
}

export const test = base.extend({
 context: async ({context,baseURL},runTest)=>{
  const appURL=baseURL??'http://127.0.0.1:3100';
  const user='browser-user',issuer='http://127.0.0.1:3102',org='browser-org';
  const partition=createHash('sha256').update(JSON.stringify([issuer,user,org])).digest('hex');
  await context.addCookies([{name:'looot-tables-session',value:memberCookie(user),url:appURL,httpOnly:true,sameSite:'Lax'}]);
  await context.route('**/api/looot/balance*',route=>route.fulfill({json:{credits:25000,used:0}}));
  const headers={'x-looot-tables-account':partition,'x-looot-tables-session':'browser-session'.repeat(3),origin:appURL};
  const index=await context.request.get(`${appURL}/api/sheets`,{headers});
  if(!index.ok())throw new Error('Browser tests require a migrated test Neon database.');
  for(const entry of await index.json())await context.request.delete(`${appURL}/api/sheets/${entry.sheet.id}?revision=${entry.sheet.revision}`,{headers});
  await runTest(context);
 }
});
