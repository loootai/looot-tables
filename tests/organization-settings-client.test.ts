import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setStorageAccount } from '../src/lib/account-storage';
import { DEFAULT_SETTINGS, initializeOrganizationSettings, loadSettings, keyHeaders, importLocalOrganizationSettings, saveSettings, localSettingsToImport, organizationSettingsSnapshot } from '../src/lib/keys';

test('cloud bootstrap never sends legacy keys automatically; explicit import preserves originals on failure and removes them only after confirmation', async t=>{
 const storage=new Map<string,string>();
 const key='looot-tables.settings.v1.account.org-client-test';
 const runKey='looot-tables.run-scope.v2.account.org-client-test';
 storage.set(key,JSON.stringify({...DEFAULT_SETTINGS,openaiKey:'sk-legacy-private',contextKey:'ctxt-legacy-private',model:'legacy-model'}));
 storage.set(runKey,'100');
 const previous=Object.getOwnPropertyDescriptor(globalThis,'window');
 Object.defineProperty(globalThis,'window',{configurable:true,value:{localStorage:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)}}});
 setStorageAccount({partition:'org-client-test',sessionId:'session'});
 let revision=1,conflict=true;
 let preferences={model:'org-model',classifierModel:'decisions',openaiBaseUrl:'',logolinkKey:'',preferJev:true,concurrency:4};
 const requests:Record<string,unknown>[]=[];
 t.mock.method(globalThis,'fetch',async (_url:unknown,init:RequestInit)=>{
  const body=init.body?JSON.parse(String(init.body)):null;
  if(body)requests.push(body);
  if(body?.importOnly&&conflict)return Response.json({error:'Organization settings already exist.'},{status:409});
  if(body?.revision!==undefined){
   if(body.revision!==revision)return Response.json({error:'Organization settings changed.'},{status:409});
   revision++;preferences={...preferences,...body.preferences};
  }
  return Response.json({revision,preferences,providers:{looot:{configured:true,source:'manual',prefix:'lt_or'},...(revision>1?{openai:{configured:true,prefix:'sk-lega',source:'manual'}}:{})}});
 });
 try{
  assert.equal(await initializeOrganizationSettings(),true);
  assert.equal(JSON.stringify(requests),JSON.stringify([{action:'connect-signin'}]));
  assert.equal(loadSettings().openaiKey,'');
  assert.equal(keyHeaders()['x-openai-key'],undefined);
  assert.equal(localSettingsToImport()?.openaiKey,'sk-legacy-private');
  await assert.rejects(importLocalOrganizationSettings(),/already exist/);
  assert.ok(storage.has(key));assert.ok(storage.has(runKey));
  conflict=false;
  await importLocalOrganizationSettings();
  const imported=requests.findLast(request=>request.importOnly) as {providers:Record<string,string>;preferences:Record<string,unknown>};
  assert.deepEqual(imported.providers,{openai:'sk-legacy-private'});
  assert.equal('runScope' in imported.preferences,false,'run scope is a per-person browser preference, never an organization setting');
  assert.equal(storage.has(key),false);assert.equal(storage.get(runKey),'100');
  assert.equal(localSettingsToImport(),null);
  assert.equal(loadSettings().model,'legacy-model');
  assert.equal(loadSettings().openaiKey,'');
  await saveSettings({openaiKey:'sk-new-org-private',concurrency:2});
  assert.ok(!JSON.stringify([...storage]).includes('sk-new-org-private'));
  assert.equal(organizationSettingsSnapshot()?.revision,3);
 } finally {if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window')}
});
