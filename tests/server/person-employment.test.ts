import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runOp } from '../../src/lib/server/enrich';
import { testAccess } from './access-fixture';

const access = (context: string) => testAccess({ keys: { context }, model: 'test' });
const fields = ['company', 'company_domain', 'title', 'years_at_company'] as const;
const former = { title: 'Former engineer', organization: { name: 'Former Employer', domain: 'former.example' }, is_current: false, start_date: { year: 2010 }, end_date: { year: 2015 } };

for (const status of ['none', 'unknown', 'present'] as const) {
 test(`person employment fields respect ${status} current role status`, async (t) => {
  const current = { title: 'Engineer', organization: { name: 'Current Employer', domain: 'current.example' }, start_date: { year: 2024 } };
  t.mock.method(globalThis, 'fetch', async () => Response.json({ request_id: status, match: { status: 'candidate', score: 1, person: { name: { full: 'Ada Lovelace' }, current_role_status: status, current_role: status === 'present' ? current : null, experience: [former], social_urls: [], website_urls: [], education: [], skills: [] } } }));
  const results = [];
  for (const field of fields) {
   const result = await runOp(access(`employment-${status}`), { kind: 'person', name: 'Ada Lovelace', company: 'example.com', field }, {});
   assert.equal(result.error, undefined);
   results.push(result.value);
  }
  assert.deepEqual(results, status === 'present' ? ['Current Employer', 'current.example', 'Engineer', new Date().getFullYear() - 2024] : [null, null, null, null]);
  const history = await runOp(access(`employment-${status}`), { kind: 'person', name: 'Ada Lovelace', company: 'example.com', field: 'experience' }, {});
  assert.deepEqual(history.value, ['Former engineer at Former Employer (2010–2015)']);
 });
}
