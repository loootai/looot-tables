import assert from 'node:assert/strict';
import { test } from 'node:test';
import { populateStream } from '../../src/lib/server/populate';
import { personEnrichmentInput, listedPersonRow, type ListedPerson } from '../../src/lib/server/populate-people-list';
import { personHitOf } from '../../src/lib/server/looot-jobs';
import type { PopulateEvent } from '../../src/lib/types';
import { rowSchema } from '../../src/lib/workspace';
import { testAccess } from './access-fixture';

const access = testAccess({ keys: { openai: 'test-openai', looot: 'test-looot' }, model: 'test-model', openaiBaseUrl: 'https://model.example/v1' });
const MODEL = 'https://model.example/v1/chat/completions';
const person = (name: string, companyDomain: string | null = null): ListedPerson => ({ name, firstName: name.split(' ')[0], lastName: name.split(' ').slice(1).join(' ') || null, companyDomain, companyName: null, email: null, profileUrls: [], city: null, region: null, country: null, school: null });
const completion = (content: string) => Response.json({ id: 'plan', object: 'chat.completion', created: 0, model: 'test-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
const run = (result: unknown, outcome = 'hit', n = 1) => Response.json({ runId: `run_${n}`, status: 'completed', outcome, result, actualCost: outcome === 'hit' ? 0.016 : 0 }, { status: 201 });
const miss = (n = 1) => run({ data: null }, 'miss', n);

test('list routing enriches supplied people separately and retains unmatched and name-only people', async (t) => {
 const people = [person('Nikhil Radosevich', 'looot.ai'), { ...person('Adeline Kim'), companyName: 'Aside' }, person('Anicet Nougaret', 'boat.dev'), person('Name Only')];
 const requests: Array<{ endpointId: string; input: Record<string, unknown> }> = [];
 t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
  const request = new Request(input, options);
  if (request.url === MODEL) {
   const body = await request.json();
   assert.ok(!JSON.stringify(body.response_format).includes('\"format\":\"uri\"'));
   return completion(JSON.stringify({ mode: 'list', people }));
  }
  requests.push(await request.json());
  if (requests.length !== 3) return miss(requests.length);
  return run({ data: { full_name: 'Anicet Nougaret', avatar_url: 'https://cdn.example.com/anicet.jpg', title: 'Founder', company_name: 'Boat', website: 'boat.dev', profile_url: 'https://www.linkedin.com/in/anicet' } }, 'hit', 3);
 });
 const events: PopulateEvent[] = (await new Response(populateStream(access, { query: 'Nikhil Radosevich - looot.ai\nAdeline Kim - Aside\nAnicet Nougaret - boat.dev\nName Only', entity: 'people', target: 1, availableRows: 100 })).text()).trim().split('\n').map(line => JSON.parse(line));
 assert.deepEqual(events.filter(e => e.type === 'error'), []);
 assert.equal(requests.length, 3, 'a person with no clue to look up is kept without a paid lookup');
 assert.ok(requests.every(r => r.endpointId === 'job:people.enrich'));
 assert.deepEqual(requests.map(r => [r.input.domain, r.input.company]), [['looot.ai', undefined], [undefined, 'Aside'], ['boat.dev', undefined]]);
 assert.deepEqual([requests[2].input.first_name, requests[2].input.last_name], ['Anicet', 'Nougaret']);
 const rows = events.flatMap(e => e.type === 'rows' ? e.rows : []);
 assert.deepEqual(rows.map(r => r.Name), people.map(p => p.name));
 assert.deepEqual(rows.map(r => r['Enrichment status']), ['No match', 'No match', 'Candidate found', 'No match']);
 assert.equal(rows[1]['Supplied company'], 'Aside');
 assert.equal(rows[1].Company, null);
 assert.equal(rows[2]['Company domain'], 'boat.dev');
 assert.equal(rows[2]['Profile photo'], 'https://cdn.example.com/anicet.jpg');
 assert.equal(rows[0]['Profile photo'], null);
 for (const [index, row] of rows.entries()) rowSchema.parse({ id: `row-${index}`, sheetId: 'people', order: index, createdAt: 1, cells: Object.fromEntries(Object.entries(row).map(([column, v]) => [column, { v, s: 'done', t: 1 }])) });
});

test('discovery routing retains the people search agent, with a company finder beside it', async (t) => {
 let modelCalls = 0;
 t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
  const request = new Request(input, options);
  if (request.url === MODEL) {
   if (++modelCalls === 1) return completion(JSON.stringify({ mode: 'discovery', people: [] }));
   const body = await request.json();
   assert.deepEqual(body.tools.map((tool: { function: { name: string } }) => tool.function.name).sort(), ['findCompanies', 'searchPeople']);
   return completion('No results');
  }
  throw new Error(`Unexpected API: ${request.url}`);
 });
 const events = await new Response(populateStream(access, { query: 'Founders of fintech companies in the US', entity: 'people', target: 3 })).text();
 assert.equal(modelCalls, 2);
 assert.ok(events.includes('"type":"done"'));
 assert.ok(!events.includes('"type":"error"'));
});

test('an API failure keeps the supplied person and continues with the next person', async (t) => {
 let calls = 0;
 t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
  const request = new Request(input, options);
  if (request.url === MODEL) return completion(JSON.stringify({ mode: 'list', people: [person('First Person', 'first.example'), person('Second Person', 'second.example')] }));
  calls++;
  if (calls === 1) return Response.json({ error: { code: 'validation_error', message: 'Invalid identity' } }, { status: 422 });
  return miss(calls);
 });
 const events: PopulateEvent[] = (await new Response(populateStream(access, { query: 'First Person and Second Person', entity: 'people', target: 3 })).text()).trim().split('\n').map(line => JSON.parse(line));
 assert.equal(calls, 2);
 assert.deepEqual(events.flatMap(e => e.type === 'rows' ? e.rows.map(r => r['Enrichment status']) : []), ['Lookup failed', 'No match']);
 assert.equal(events.at(-1)?.type, 'error');
});

test('identity clues are passed together and an unmatched person keeps only what was supplied', () => {
 const input = { ...person('Ada Lovelace', 'engines.example'), companyName: 'Engines', city: 'London', school: 'School', email: 'ada@example.com', profileUrls: ['https://www.linkedin.com/in/ada'] };
 assert.deepEqual(personEnrichmentInput(input), { name: 'Ada Lovelace', email: 'ada@example.com', profileUrl: 'https://www.linkedin.com/in/ada', company: 'Engines', companyDomain: 'engines.example' });
 const row = listedPersonRow(input, null);
 assert.equal(row.Company, null);
 assert.equal(row['Supplied company'], 'Engines');
 assert.equal(row['Enrichment status'], 'No match');
 assert.equal(row.LinkedIn, 'https://www.linkedin.com/in/ada');
 assert.equal(personEnrichmentInput(person('Name Only')), null);
 const found = listedPersonRow(person('Grace Hopper', 'navy.example'), personHitOf({ full_name: 'Grace Hopper', title: 'Rear Admiral', company_name: 'US Navy', website: 'navy.example', profile_url: 'https://www.linkedin.com/in/grace' }));
 assert.deepEqual([found.Title, found.Company, found['Enrichment status']], ['Rear Admiral', 'US Navy', 'Candidate found']);
});

test('list processing respects sheet capacity and cancellation', async (t) => {
 const { populatePeopleList } = await import('../../src/lib/server/populate-people-list');
 let calls = 0;
 t.mock.method(globalThis, 'fetch', async () => miss(++calls));
 const people = [person('First Person', 'first.example'), person('Second Person', 'second.example')];
 const events: PopulateEvent[] = [];
 await populatePeopleList(access, { query: 'List', entity: 'people', target: 100, availableRows: 1 }, people, event => events.push(event), new AbortController().signal);
 assert.equal(calls, 1);
 assert.equal(events.filter(e => e.type === 'rows').length, 1);
 assert.equal(events.at(-1)?.type, 'error');
 const abort = new AbortController();
 abort.abort();
 await assert.rejects(populatePeopleList(access, { query: 'List', entity: 'people', target: 100 }, people, () => {}, abort.signal), { name: 'AbortError' });
 assert.equal(calls, 1);
});

test('supplied people are looked up a few at a time, emitted in order, and never beyond the remaining rows', async (t) => {
 const { populatePeopleList } = await import('../../src/lib/server/populate-people-list');
 let active = 0, maxActive = 0, calls = 0;
 t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
  const request = new Request(input, options);
  calls++; active++; maxActive = Math.max(maxActive, active);
  const { input: lookup } = await request.json();
  // Later people answer first; rows must still arrive in the supplied order.
  await new Promise(resolve => setTimeout(resolve, 40 - Number(String(lookup.domain).split('.')[0].slice(1)) * 3));
  active--;
  return miss(calls);
 });
 const people = Array.from({ length: 10 }, (_, i) => person(`Person ${i}`, `p${i}.example`));
 const events: PopulateEvent[] = [];
 await populatePeopleList(access, { query: 'List', entity: 'people', target: 100, availableRows: 6 }, [...people, people[0]], event => events.push(event), new AbortController().signal);
 assert.equal(calls, 6, 'no lookup is paid for a row that cannot fit');
 assert.ok(maxActive > 1 && maxActive <= 4, `bounded parallel lookups (saw ${maxActive})`);
 assert.deepEqual(events.flatMap(e => e.type === 'rows' ? e.rows.map(r => r.Name) : []), people.slice(0, 6).map(p => p.name));
 assert.equal(events.at(-1)?.type, 'error');
});
