import { EncryptJWT } from 'jose';
import { createHash, hkdfSync, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { expect, test, type Page } from '@playwright/test';

const issuer = 'http://127.0.0.1:3102';
let userId = 'alice', orgId = 'org-1', server: Server;
let grantLogoPermission = true;
const grants = new Map<string, { challenge: string; userId: string; orgId: string; scope: string }>();
const partition = (user = userId, org = orgId) => createHash('sha256').update(JSON.stringify([issuer, user, org])).digest('hex');

test.beforeAll(async () => {
	server = createServer(async (request, response) => {
		const url = new URL(request.url!, issuer);
		if (url.pathname === '/oauth2/authorize') {
			const code = randomBytes(32).toString('base64url');
			grants.set(code, { challenge: url.searchParams.get('code_challenge')!, userId, orgId, scope: url.searchParams.get('scope')! });
			const destination = new URL(url.searchParams.get('redirect_uri')!);
			destination.searchParams.set('code', code); destination.searchParams.set('state', url.searchParams.get('state')!);
			response.writeHead(302, { location: destination.toString() }); response.end(); return;
		}
		let body = ''; for await (const chunk of request) body += chunk;
		const params = new URLSearchParams(body), code = params.get('code')!, grant = grants.get(code);
		grants.delete(code);
		if (url.pathname !== '/oauth2/token' || !grant || params.get('client_secret') !== 'browser-test-client-secret-32-characters' || createHash('sha256').update(params.get('code_verifier') || '').digest('base64url') !== grant.challenge) { response.writeHead(400); response.end(); return; }
		response.setHeader('content-type', 'application/json');
		const access_token=await new EncryptJWT({context_api_key:'ctxt_secret_browser_demo',context_api_key_id:'browser-key',organization_id:grant.orgId,scope:'data:execute logs:read'}).setProtectedHeader({alg:'dir',enc:'A256GCM',typ:'context-connection+jwt'}).setIssuer(issuer).setAudience('context-api:enrichable').setSubject(grant.userId).setIssuedAt().setExpirationTime('8h').encrypt(Buffer.from(hkdfSync('sha256','browser-test-client-secret-32-characters','','enrichable:context-connection:v1',32)));
		response.end(JSON.stringify({ access_token, issuer, scope: grantLogoPermission ? grant.scope : 'api.read', user: { id: grant.userId, email: `${grant.userId}@example.com`, email_verified: true, name: grant.userId }, organization: { id: grant.orgId, name: grant.orgId, logolink_public_id: 'brandLL_browser_public' } }));
	});
	await new Promise<void>((resolve) => server.listen(3102, '127.0.0.1', resolve));
});
test.afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
test.beforeEach(async ({ page }) => { grantLogoPermission = true; userId = 'alice'; orgId = `org-${randomBytes(8).toString('hex')}`; grants.clear(); await page.route('**/api/context/usage', route => route.fulfill({ json: { credits: 25000, used: 0 } })); });

async function signIn(page: Page) {
	await page.goto('/login');
	await expect(page.getByText('New to Context.dev? You can create a free account on the next screen.', { exact: false })).toBeVisible();
	await page.getByRole('link', { name: 'Sign in with Context.dev', exact: true }).click();
	await expect(page).toHaveURL(/\/app$/);
	await expect(page.getByText('Checking credits…')).toHaveCount(0, { timeout: 30_000 });
	await closeSetup(page);
}

/** Setup opens at most once per browser, and only when a required connection is missing. */
async function closeSetup(page: Page) {
	const setup = page.getByRole('dialog', { name: 'Set up enrichment' });
	if (await setup.isVisible()) await setup.getByRole('button', { name: 'Close', exact: true }).click();
}

test('only Context.dev can sign in; callback creates a secure session and logout protects pages and APIs', async ({ page, context }) => {
	await page.goto('/app');
	await expect(page).toHaveURL(/\/login\?/);
	await expect(page.getByRole('link', { name: 'Sign in with Context.dev', exact: true })).toBeVisible();
	expect((await page.request.post('/api/enrich', { data: {} })).status()).toBe(401);
	await signIn(page);
	const cookie = (await context.cookies()).find((cookie) => cookie.name === 'enrichable.session')!;
	expect(cookie.httpOnly).toBe(true); expect(cookie.sameSite).toBe('Lax');
	const connection = (await context.cookies()).find(cookie => cookie.name === 'enrichable.context')!;
	expect(connection.httpOnly).toBe(true); expect(connection.value).not.toContain('ctxt_secret_browser_demo');
	const session = await page.request.get('/api/auth/session').then(response => response.json());
	const availability = await page.request.get('/api/keys/verify', { headers: { 'x-enrichable-account': session.partition, 'x-enrichable-session': session.sessionId } }).then(response => response.json());
	expect(availability.contextConnected).toBe(true); expect(availability.context).toBe(true);
	await page.goto('/app/settings');
	await expect(page.getByRole('region', { name: 'Connections' }).getByRole('listitem').filter({ hasText: 'Context.dev' })).toContainText('Context.dev sign-in');
	expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('ctxt_secret_browser_demo');
	await page.getByRole('button', { name: 'Sign out', exact: true }).click();
	await expect(page).toHaveURL(/\/login$/);
	expect((await page.request.get('/api/context/usage')).status()).toBe(401);
	expect((await context.cookies()).some(cookie => cookie.name === 'enrichable.context')).toBe(false);
	await page.goto('/app'); await expect(page).toHaveURL(/\/login\?/);
});

test('sheets are shared within organizations, credentials stay personal, and organizations stay isolated', async ({ page }) => {
	test.setTimeout(90_000);
	const originalOrganization = orgId;
	await page.goto('/login');
	await page.evaluate(() => localStorage.setItem('enrichable.settings.v1', JSON.stringify({ openaiKey: 'anonymous-secret', contextKey: 'anonymous-context' })));
	await signIn(page);
	await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
	await page.getByLabel('Sheet name', { exact: true }).fill('Alice private sheet');
	await page.getByLabel('Or paste CSV', { exact: true }).fill('Name,Domain\nAlice,example.com');
	await page.getByRole('button', { name: 'Import', exact: true }).click();
	await expect(page.getByRole('gridcell').first()).toHaveAccessibleName(/Alice/, { timeout: 20_000 });
	const aliceSheetUrl = page.url();
	await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({ openaiKey: 'alice-secret', contextKey: 'alice-context' })), `enrichable.settings.v1.account.${partition()}`);
	await page.getByRole('button', { name: 'Sign out', exact: true }).click();
	userId = 'bob'; await signIn(page);
	await expect(page.getByRole('list', { name: 'Sheets', exact: true }).getByText('Alice private sheet', { exact: true })).toBeVisible();
	await page.goto(aliceSheetUrl);
	await expect(page.getByRole('gridcell').first()).toHaveAccessibleName(/Alice/, { timeout: 20_000 });
	await page.getByRole('button', { name: 'Sign out', exact: true }).click();
	grantLogoPermission = true; userId = 'alice'; orgId = 'org-2'; await signIn(page);
	await expect(page.getByText('Alice private sheet', { exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: 'Sign out', exact: true }).click();
	orgId = originalOrganization;
	await page.getByRole('link', { name: 'Sign in with Context.dev', exact: true }).click();
	await expect(page.getByRole('list', { name: 'Sheets', exact: true }).getByText('Alice private sheet', { exact: true })).toBeVisible();
	// Un-imported local data must survive logout.
	expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).openaiKey, `enrichable.settings.v1.account.${partition()}`)).toBe('alice-secret');
	expect(await page.evaluate(() => JSON.parse(localStorage.getItem('enrichable.settings.v1')!).openaiKey)).toBe('anonymous-secret');
});

test('an old tab cannot send API requests under a newly signed-in account', async ({ page, context }) => {
	await signIn(page);
	const session = await page.request.get('/api/auth/session').then((response) => response.json());
	const other = await context.newPage(); await other.goto('/app');
	await expect(other.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
	await other.getByRole('button', { name: 'Sign out', exact: true }).click();
	userId = 'bob'; await signIn(other);
	const response = await page.request.get('/api/context/usage', { headers: { 'x-enrichable-account': session.partition, 'x-enrichable-session': session.sessionId } });
	expect(response.status()).toBe(409);
	await page.bringToFront();
	await expect(page.getByText('alice', { exact: true })).toHaveCount(0);
});


test('uses the consented workspace public ID for logos without storing it as a manual key', async ({page})=>{
 test.setTimeout(60000);
 await page.route('https://logos.context.dev/**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="green"/></svg>'}));
 await signIn(page);
 await page.goto('/app/settings');
 await page.getByRole('button',{name:'Context.dev actions',exact:true}).click();
 await page.getByRole('menuitem',{name:'Logo Link key',exact:true}).click();
 await expect(page.getByLabel('Logo Link key (optional override)',{exact:true})).toHaveValue('');
 await page.getByRole('button',{name:'About Logo Link key (optional override)',exact:true}).click();
 await expect(page.getByRole('tooltip')).toContainText('Leave empty to use your workspace’s Logo Link client ID.');
 await page.keyboard.press('Tab');
 await page.getByRole('dialog',{name:'Logo Link key'}).getByRole('button',{name:'Close',exact:true}).click();
 await page.goto('/app');
 await page.getByRole('button',{name:'Import CSV',exact:true}).click();
 await page.getByLabel('Sheet name',{exact:true}).fill('Automatic logos');
 await page.getByLabel('Or paste CSV',{exact:true}).fill('Company\nexample.com');
 await page.getByRole('button',{name:'Import',exact:true}).click();
 const logo=page.locator('img[src*="publicClientId=brandLL_browser_public"]');
 await expect(logo.first()).toBeVisible({timeout:20000});
 expect(new URL((await logo.first().getAttribute('src'))!).searchParams.get('domain')).toBe('example.com');
 expect(await page.evaluate(()=>JSON.stringify(localStorage))).not.toContain('brandLL_browser_public');
});
test('does not use a returned public ID when the LogoLink scope was not granted',async({page})=>{
 grantLogoPermission=false;
 await signIn(page);
 await page.goto('/app/settings');
 await page.getByRole('button',{name:'Context.dev actions',exact:true}).click();
 await page.getByRole('menuitem',{name:'Logo Link key',exact:true}).click();
 await page.getByRole('button',{name:'About Logo Link key (optional override)',exact:true}).click();
 await expect(page.getByRole('tooltip')).toContainText('from your Context.dev dashboard');
});
