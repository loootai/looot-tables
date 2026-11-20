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
 const saved=await store.patch(actor(),{revision:0,preferences:{model:'test-model',concurrency:2},providers:{openai:'org-openai-secret',looot:'org-looot-secret'},importOnly:false});
 assert.equal(saved.revision,1);
 assert.deepEqual(await store.get(actor('one','bob')),saved);
 assert.equal((await store.credentials(actor('one','bob'))).keys.openai,'org-openai-secret');
 assert.equal((await store.get(actor('two'))).providers.openai,undefined);
 assert.deepEqual((await store.credentials(actor('two'))).keys,{});
 assert.equal((await new OrganizationStore(database,()=>root).credentials(actor())).keys.looot,'org-looot-secret');
 assert.ok(!JSON.stringify((await db.query('SELECT * FROM looot_tables.organization_providers')).rows).includes('org-openai-secret'));
 assert.ok(!JSON.stringify(saved).includes('org-openai-secret'));
 await assert.rejects(new OrganizationStore(database,()=> 'wrong-root-with-at-least-32-characters').credentials(actor()),/could not be decrypted/);
 const audit=await db.query('SELECT * FROM looot_tables.organization_settings_audit');
 assert.ok(!JSON.stringify(audit.rows).includes('org-openai-secret'));
 await assert.rejects(store.patch(actor(),{revision:0,preferences:{concurrency:9},importOnly:false}),/changed/);
 const changes=await Promise.allSettled([store.patch(actor(),{revision:1,preferences:{concurrency:3},importOnly:false}),store.patch(actor('one','bob'),{revision:1,preferences:{concurrency:4},importOnly:false})]);
 assert.equal(changes.filter(x=>x.status==='fulfilled').length,1);
});

test('expired connections are unavailable to MCP and import cannot overwrite existing organization preferences or keys',async t=>{
 const {store,db}=await fixture(t);
 const first=await store.get(actor());
 await store.patch(actor(),{revision:first.revision,preferences:{model:'imported-model'},providers:{openai:'imported-openai',looot:'looot-token'},importOnly:true});
 const saved=await store.get(actor());
 await assert.rejects(store.patch(actor(),{revision:saved.revision,preferences:{model:'overwrite'},importOnly:true}),/already exist/);
 assert.equal((await store.credentials(actor())).keys.looot,'looot-token');
 await db.query('UPDATE looot_tables.organization_providers SET expires_at=1 WHERE provider=$1',['looot']);
 assert.equal((await store.get(actor())).providers.looot?.reconnectRequired,true);
 assert.equal((await store.credentials(actor())).keys.looot,undefined);
 const latest=await store.get(actor());
 await store.patch(actor('one','bob'),{revision:latest.revision,providers:{looot:'replacement-token'},importOnly:false});
 assert.equal((await store.credentials(actor())).keys.looot,'replacement-token');
});

test('credential encryption authenticates the provider and workspace; disconnect does not affect other providers',async t=>{
 const {store,db}=await fixture(t);
 await store.patch(actor(),{revision:0,providers:{openai:'openai-secret',looot:'looot-secret'},importOnly:false});
 await db.query("UPDATE looot_tables.organization_providers SET encrypted_secret=(SELECT encrypted_secret FROM looot_tables.organization_providers WHERE provider='looot') WHERE provider='openai'");
 await assert.rejects(store.credentials(actor()),/could not be decrypted/);
 await store.patch(actor(),{revision:1,providers:{openai:null},importOnly:false});
 assert.equal((await store.credentials(actor())).keys.looot,'looot-secret');
});

test('credentials sealed before the shared envelope still decrypt',async t=>{
 const {db,store}=await fixture(t);
 // The previous OrganizationStore.encrypt format for actor('legacy') under the fixture root, re-sealed with the
 // looot-tables key-derivation label when the project was renamed (no deployment held the old label).
 const sealed='v1.i6YC_IUkCp5qaWQR.Y-3hwA31H28a8i5n4d0aXw.FW46dxuuXH7DL1IXqBdY0SfZT7k';
 await db.query("INSERT INTO looot_tables.workspaces (id,issuer,organization_id,name) VALUES ($1,'https://organizations.test','legacy','legacy')",[workspaceId(actor('legacy'))]);
 await db.query("INSERT INTO looot_tables.organization_providers (workspace_id,provider,encrypted_secret,prefix,source,subject_id,subject_email,updated_at) VALUES ($1,'openai',$2,'legacy-','manual','alice','alice@example.com',1)",[workspaceId(actor('legacy')),sealed]);
 assert.equal((await store.credentials(actor('legacy'))).keys.openai,'legacy-openai-secret');
});

test('MCP authenticates with only its org key, uses organization providers/models, and preserves explicit overrides',async t=>{
 const {store,keys,sheets}=await fixture(t);
 await store.patch(actor(),{revision:0,preferences:{model:'org-model',classifierModel:'org-classifier'},providers:{openai:'org-openai',looot:'org-looot'},importOnly:false});
 const resolved=await mcpAccess(new Headers(),actor('one','bob'),store);
 assert.equal(resolved.key('openai'),'org-openai');assert.equal(resolved.key('looot'),'org-looot');assert.equal(resolved.model,'org-model');assert.equal(resolved.classifierModel,'org-classifier');
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
