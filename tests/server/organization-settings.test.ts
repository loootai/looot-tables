import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SELF_HOSTED_ISSUER } from '../../src/lib/auth-identity';
import { OrganizationStore, organizationPersistenceEnabled } from '../../src/lib/server/organization-store';
import { MCP_POLICY, mcpAccess, mcpInputs, resolveGrant } from '../../src/lib/server/provider-access';
import { McpOperations } from '../../src/lib/server/mcp-tools';
import { testAccess } from './access-fixture';
import { McpStore } from '../../src/lib/server/mcp-store';
import { WorkspaceStore } from '../../src/lib/server/workspace-store';
import { workspaceId } from '../../src/lib/server/database';
import { handleMcpRequest } from '../../src/lib/server/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Account } from '../../src/lib/auth-identity';
import { testDatabase } from '../support/database';

const actor = (org='one', user='alice'): Account => ({issuer:'https://organizations.test',user:{id:user,email:`${user}@example.com`,email_verified:true},organization:{id:org,name:org},partition:user});
const root = 'organization-tests-stable-encryption-root';
async function fixture(t: {after(fn:()=>Promise<void>):void}) {
 const {db,database}=await testDatabase(t);
 return {db,database,store:new OrganizationStore(database,()=>root),keys:new McpStore(database,()=>root),sheets:new WorkspaceStore(database)};
}

test('organization settings and encrypted credentials share across members/devices and isolate organizations',async t=>{
 const {db,store,database}=await fixture(t);
 const saved=await store.patch(actor(),{revision:0,preferences:{model:'test-model',concurrency:2},providers:{openai:'org-openai-secret',context:'org-context-secret'},importOnly:false});
 assert.equal(saved.revision,1);
 assert.deepEqual(await store.get(actor('one','bob')),saved);
 assert.equal((await store.credentials(actor('one','bob'))).keys.openai,'org-openai-secret');
 assert.equal((await store.get(actor('two'))).providers.openai,undefined);
 assert.deepEqual((await store.credentials(actor('two'))).keys,{});
 assert.equal((await new OrganizationStore(database,()=>root).credentials(actor())).keys.context,'org-context-secret');
 assert.ok(!JSON.stringify((await db.query('SELECT * FROM enrichable.organization_providers')).rows).includes('org-openai-secret'));
 assert.ok(!JSON.stringify(saved).includes('org-openai-secret'));
 await assert.rejects(new OrganizationStore(database,()=> 'wrong-root-with-at-least-32-characters').credentials(actor()),/could not be decrypted/);
 const audit=await db.query('SELECT * FROM enrichable.organization_settings_audit');
 assert.ok(!JSON.stringify(audit.rows).includes('org-openai-secret'));
 await assert.rejects(store.patch(actor(),{revision:0,preferences:{concurrency:9},importOnly:false}),/changed/);
 const changes=await Promise.allSettled([store.patch(actor(),{revision:1,preferences:{concurrency:3},importOnly:false}),store.patch(actor('one','bob'),{revision:1,preferences:{concurrency:4},importOnly:false})]);
 assert.equal(changes.filter(x=>x.status==='fulfilled').length,1);
});

test('sign-in connections preserve manual keys and disconnects, keep the longest-lived grant, honor expiry and reconnect',async t=>{
 const {store,db}=await fixture(t);
 const now=Date.now();
 await store.saveSignin(actor(),'signin-alice',now+600_000);
 const firstSignin=(await db.query<{first_signed_in_at:Date}>('SELECT first_signed_in_at FROM enrichable.signed_in_users')).rows[0].first_signed_in_at;
 await store.saveSignin(actor('one','bob'),'signin-bob-shorter',now+300_000);
 assert.equal((await store.credentials(actor('one','bob'))).keys.context,'signin-alice','A shorter grant never replaces a longer one');
 assert.equal((await store.credentials(actor('one','bob'))).contextUserEmail,'alice@example.com');
 // Alice's 09:00 grant would expire during Bob's 16:00 session; Bob's later grant takes over.
 await store.saveSignin(actor('one','bob'),'signin-bob',now+650_000);
 assert.equal((await store.credentials(actor())).keys.context,'signin-bob');
 assert.equal((await store.credentials(actor())).contextUserEmail,'bob@example.com');
 assert.equal((await store.get(actor())).providers.context?.expiresAt,now+650_000);
 await store.saveSignin(actor(),'renewed-alice',now+700_000);
 assert.equal((await store.credentials(actor())).keys.context,'renewed-alice');
 const info=await store.get(actor());
 await store.patch(actor('one','bob'),{revision:info.revision,providers:{context:'manual-context'},importOnly:false});
 await store.saveSignin(actor(),'signin-replacement',Date.now()+700_000);
 assert.equal((await store.credentials(actor())).keys.context,'manual-context');
 await assert.rejects(store.saveSignin(actor(),'expired',Date.now()-1),/expired/);
 const latest=await store.get(actor());
 await store.patch(actor(),{revision:latest.revision,providers:{context:null},importOnly:false});
 assert.equal((await store.credentials(actor())).keys.context,undefined);
 await store.saveSignin(actor('one','bob'),'should-not-restore',Date.now()+600_000);
 assert.equal((await store.credentials(actor())).keys.context,undefined);
 await store.saveSignin(actor('one','bob'),'explicit-reconnect',Date.now()+600_000,true);
 assert.equal((await store.credentials(actor())).keys.context,'explicit-reconnect');
 await store.saveSignin(actor('two'),'signin-alice-other-org',Date.now()+600_000);
 assert.equal((await db.query('SELECT * FROM enrichable.signed_in_users')).rows.length,2);
 assert.equal((await db.query('SELECT * FROM enrichable.signed_in_memberships')).rows.length,3);
 assert.deepEqual((await db.query<{first_signed_in_at:Date}>("SELECT first_signed_in_at FROM enrichable.signed_in_users WHERE user_id='alice'")).rows[0].first_signed_in_at,firstSignin);
 assert.equal((await db.query("SELECT * FROM enrichable.signed_in_users WHERE user_id='bob'")).rows.length,1);
});

test('expired connections are unavailable to MCP and import cannot overwrite existing organization preferences or keys',async t=>{
 const {store,db}=await fixture(t);
 await store.saveSignin(actor(),'signin-key',Date.now()+600_000);
 const info=await store.get(actor());
 await store.patch(actor(),{revision:info.revision,preferences:{model:'imported-model'},providers:{openai:'imported-openai'},importOnly:true});
 const saved=await store.get(actor());
 await assert.rejects(store.patch(actor(),{revision:saved.revision,preferences:{model:'overwrite'},importOnly:true}),/already exist/);
 await db.query('UPDATE enrichable.organization_providers SET expires_at=1 WHERE provider=$1',['context']);
 assert.equal((await store.get(actor())).providers.context?.reconnectRequired,true);
 assert.equal((await store.credentials(actor())).keys.context,undefined);
 await store.saveSignin(actor('one','bob'),'reconnected',Date.now()+600_000);
 assert.equal((await store.credentials(actor())).keys.context,'reconnected');
});

test('credential encryption authenticates the provider and workspace; disconnect does not affect other providers',async t=>{
 const {store,db}=await fixture(t);
 await store.patch(actor(),{revision:0,providers:{openai:'openai-secret',hunter:'hunter-secret'},importOnly:false});
 await db.query("UPDATE enrichable.organization_providers SET encrypted_secret=(SELECT encrypted_secret FROM enrichable.organization_providers WHERE provider='hunter') WHERE provider='openai'");
 await assert.rejects(store.credentials(actor()),/could not be decrypted/);
 await store.patch(actor(),{revision:1,providers:{openai:null},importOnly:false});
 assert.equal((await store.credentials(actor())).keys.hunter,'hunter-secret');
});

test('credentials sealed before the shared envelope still decrypt',async t=>{
 const {db,store}=await fixture(t);
 // Written by the previous OrganizationStore.encrypt for actor('legacy') under the fixture root.
 const sealed='v1.i6YC_IUkCp5qaWQR.a4o0GQDLp81EgCw9oY5HLA.b-C0aUkXVd9_U9mzTsPUMaF4dN0';
 await db.query("INSERT INTO enrichable.workspaces (id,issuer,organization_id,name) VALUES ($1,'https://organizations.test','legacy','legacy')",[workspaceId(actor('legacy'))]);
 await db.query("INSERT INTO enrichable.organization_providers (workspace_id,provider,encrypted_secret,prefix,source,subject_id,subject_email,updated_at) VALUES ($1,'openai',$2,'legacy-','manual','alice','alice@example.com',1)",[workspaceId(actor('legacy')),sealed]);
 assert.equal((await store.credentials(actor('legacy'))).keys.openai,'legacy-openai-secret');
});

test('MCP authenticates with only its org key, uses organization providers/models, and preserves explicit overrides',async t=>{
 const {store,keys,sheets}=await fixture(t);
 await store.patch(actor(),{revision:0,preferences:{model:'org-model',classifierModel:'org-classifier'},providers:{openai:'org-openai',context:'org-context'},importOnly:false});
 const resolved=await mcpAccess(new Headers(),actor('one','bob'),store);
 assert.equal(resolved.key('openai'),'org-openai');assert.equal(resolved.key('context'),'org-context');assert.equal(resolved.model,'org-model');assert.equal(resolved.classifierModel,'org-classifier');assert.equal(resolved.trial,false);
 const headers=new Headers({'x-openai-key':'explicit-key','x-openai-model':'explicit-model'});
 const override=await mcpAccess(headers,actor(),store);
 assert.equal(override.key('openai'),'explicit-key');assert.equal(override.model,'explicit-model');
 const changedEndpoint=new Headers({'x-openai-base-url':'https://example.com/v1'});
 await assert.rejects(mcpAccess(changedEndpoint,actor(),store),/explicit OpenAI key/);
 changedEndpoint.set('x-openai-key','own-endpoint-key');
 assert.equal(resolveGrant(MCP_POLICY,await mcpInputs(changedEndpoint,actor(),store)).openaiBaseUrl,'https://example.com/v1');
 const key=await keys.issueKey(actor());
 const client=new Client({name:'org-key-only',version:'1'});
 await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'),{requestInit:{headers:{authorization:`Bearer ${key.secret}`}},fetch:async(input,init)=>handleMcpRequest(new Request(input,init),{keys,sheets,organization:store})}));
 t.after(()=>client.close());
 const created=await client.callTool({name:'create_sheet',arguments:{sheetId:'org-sheet',name:'Org sheet'}});
 assert.ok(!created.isError);
 // Execute through the shared resolver with a provider stub: no paid traffic in unit tests.
 const ops=new McpOperations(sheets,keys,actor(),resolved,async access=>{assert.equal(access.key('openai'),'org-openai');return {value:'provider-result',meta:{durationMs:1}}});
 await ops.call('upsert_rows',{sheetId:'org-sheet',revision:1,rows:[{id:'org-row',cells:{source_1:'Acme'}}]});
 await ops.call('configure_column',{sheetId:'org-sheet',revision:2,column:{id:'answer',name:'Answer',type:'enriched',op:{kind:'ai',prompt:'{{Name}}',research:'none'}}});
 const result=await ops.call('enrich_cells',{sheetId:'org-sheet',columnId:'answer',rowIds:['org-row'],idempotencyKey:'org-provider'});
 assert.equal((result.outcomes as {cell:{v:string}}[])[0].cell.v,'provider-result');
});


test('production organization sessions require persistence even if database configuration is missing', () => {
 const previous={mode:process.env.NODE_ENV,database:process.env.DATABASE_URL};
 Object.assign(process.env,{NODE_ENV:'production'});delete process.env.DATABASE_URL;
 try {
  assert.equal(organizationPersistenceEnabled(actor()),true);
  assert.equal(organizationPersistenceEnabled({...actor(),issuer:SELF_HOSTED_ISSUER}),false);
 } finally {Object.assign(process.env,{NODE_ENV:previous.mode});if(previous.mode===undefined)Reflect.deleteProperty(process.env,'NODE_ENV');if(previous.database===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous.database}
});


test('provider errors cannot echo organization credentials into saved cells', () => {
 const secret='organization-secret-value';
 const message=testAccess({keys:{openai:secret}}).redact({status:401,message:`Rejected ${secret}`});
 assert.ok(!message.includes(secret));assert.match(message,/redacted/);
 const longSecret='credential-'.repeat(60);
 const truncated=testAccess({keys:{openai:longSecret}}).redact(new Error(`Rejected ${longSecret}`));
 assert.ok(!truncated.includes('credential-'));assert.match(truncated,/redacted/);
});
