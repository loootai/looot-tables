import { expect, test, type BrowserContext } from '@playwright/test';
import { memberCookie } from './authenticated-test';

const defaults = { model: 'gpt-6-luna', classifierModel: 'decisions', concurrency: 4, preferJev: true, logolinkKey: '', openaiBaseUrl: '' };

test('organization keys stay on server, work on a second device/member, and reject concurrent settings edits', async ({ browser, baseURL }) => {
 let revision = 0;
 let preferences = { ...defaults };
 const keys: Record<string,string> = {};
 const contexts: BrowserContext[] = [];
 async function device(user: string) {
  const context = await browser.newContext(); contexts.push(context);
  await context.addCookies([{name:'enrichable.session',value:memberCookie(user),url:baseURL!,httpOnly:true,sameSite:'Lax'}]);
  await context.route('**/api/sheets',route=>route.fulfill({json:[]}));
  await context.route('**/api/mcp-key',route=>route.fulfill({json:{key:null}}));
  await context.route('**/api/looot/balance*',route=>route.fulfill({json:{available:5,reserved:0}}));
  await context.route('**/api/openai/usage*',route=>route.fulfill({json:{enabled:false}}));
  await context.route('**/api/organization-settings',async route=>{
   const request=route.request();
   expect(request.headers()['x-enrichable-account']).toBeTruthy();
   if(request.method()==='PATCH') {
    const patch=request.postDataJSON();
    if(patch.revision!==revision)return route.fulfill({status:409,json:{error:'Organization settings changed. Reload before saving.'}});
    preferences={...preferences,...patch.preferences};
    for(const [provider,key]of Object.entries(patch.providers??{})){if(key===null)delete keys[provider];else keys[provider]=String(key)}
    revision++;
   }
   return route.fulfill({json:{revision,preferences,providers:Object.fromEntries(Object.entries(keys).map(([provider,key])=>[provider,{configured:true,prefix:key.slice(0,7),source:'manual'}]))}});
  });
  await context.route('**/api/keys/verify*',route=>{
   const headers=route.request().headers();
   const openai=Boolean(keys.openai||headers['x-openai-key']);
   const ctxt=Boolean(keys.context||headers['x-looot-key']);
   return route.fulfill({json:route.request().method()==='GET'?{openai,context:ctxt,contextConnected:ctxt,typesafe:false,passwordRequired:false}:{openai:{ok:openai,inference:openai},context:{ok:ctxt},typesafe:{configured:false,ok:false}}});
  });
  return context.newPage();
 }
 try {
  const first=await device('org-settings-alice');
  await first.goto('/app/settings');
  const setup=first.getByRole('dialog',{name:'Set up enrichment'});
  await expect(setup).toBeVisible();
  await expect(setup.getByRole('button',{name:'Reconnect Context.dev',exact:true})).toBeVisible();
  await setup.getByLabel('OpenAI API key',{exact:true}).fill('sk-fake-org-secret');
  await setup.getByRole('button',{name:'Save and start',exact:true}).click();
  await expect(setup).toHaveCount(0);
  expect(keys.openai).toBe('sk-fake-org-secret');
  await first.getByRole('button',{name:'Context.dev actions',exact:true}).click();
  await first.getByRole('menuitem',{name:'Use an API key instead',exact:true}).click();
  const connect=first.getByRole('dialog',{name:'Connect Context.dev'});
  await connect.getByLabel('Context.dev API key',{exact:true}).fill('ctxt_fake_org_secret');
  await connect.getByRole('button',{name:'Save',exact:true}).click();
  await expect(connect).toHaveCount(0);
  expect(keys.context).toBe('ctxt_fake_org_secret');
  expect(await first.evaluate(()=>JSON.stringify(localStorage))).not.toContain('sk-fake-org-secret');
  expect(await first.evaluate(()=>JSON.stringify(localStorage))).not.toContain('ctxt_fake_org_secret');
  await first.reload();
  await expect(first.getByRole('heading',{name:'Connections'})).toBeVisible();
  await expect(first.getByRole('dialog')).toHaveCount(0);
  const second=await device('org-settings-bob');
  await second.goto('/app/settings');
  await expect(second.getByRole('heading',{name:'Connections'})).toBeVisible();
  await expect(second.getByRole('region',{name:'Connections'}).getByRole('listitem').filter({hasText:'OpenAI'})).toContainText('sk-fake');
  await expect(second.getByRole('dialog')).toHaveCount(0);
  expect(await second.evaluate(()=>JSON.stringify(localStorage))).not.toContain('sk-fake-org-secret');
  await first.getByRole('spinbutton',{name:'Parallel cells',exact:true}).fill('2');
  await second.getByRole('spinbutton',{name:'Parallel cells',exact:true}).fill('7');
  await second.getByRole('button',{name:'Save defaults'}).click();
  await expect(second.getByRole('button',{name:'Save defaults'})).toBeDisabled();
  await first.getByRole('button',{name:'Save defaults'}).click();
  await expect(first.getByRole('alert').filter({hasText:'Organization settings changed.'}).first()).toBeVisible();
  expect(preferences.concurrency).toBe(7);
  await first.reload();
  await expect(first.getByRole('spinbutton',{name:'Parallel cells',exact:true})).toHaveValue('7');
  await second.getByRole('button',{name:'OpenAI actions',exact:true}).click();
  await second.getByRole('menuitem',{name:'Disconnect',exact:true}).click();
  const confirmation=second.getByRole('dialog',{name:'Disconnect OpenAI?'});
  await confirmation.getByRole('button',{name:'Disconnect',exact:true}).click();
  await expect(confirmation).toHaveCount(0);
  expect(Object.keys(keys)).toHaveLength(1);
 } finally {await Promise.all(contexts.map(context=>context.close()))}
});
