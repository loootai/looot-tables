import assert from 'node:assert/strict';
import { test } from 'node:test';
import { columnRole, columnsEntity, inferredFormat, roleColumn, type ColumnRole } from '../src/lib/column-roles';
import { companyPreview } from '../src/lib/company-preview';
import { documentClientDomain } from '../src/lib/document-branding';
import { defaultEmailWaterfall } from '../src/lib/email-waterfall';
import { entityFieldOp, entityKind } from '../src/lib/entity-fields';
import { guessDomainColumn } from '../src/components/sheet/column-operations';
import type { Column, ColumnOp, Row } from '../src/lib/types';

let next = 0;
const column = (name: string, extra: Partial<Column> = {}): Column => ({ id: `c${next++}`, name, type: extra.op ? 'enriched' : 'source', width: 180, createdAt: 1, ...extra });
const person = (field: Extract<ColumnOp, { kind: 'person' }>['field']): ColumnOp => ({ kind: 'person', field, name: '{{Name}}' });

const roles: Array<[string, Column, ColumnRole | null]> = [
	// Headers, trimmed and case-insensitive, including every alias the old patterns disagreed on.
	['Domain', column('Domain'), 'website'],
	[' company website ', column(' company website '), 'website'],
	['Site', column('Site'), 'website'],
	['URL', column('URL'), 'webpage'],
	['School website', column('School website'), 'school-website'],
	['Employer', column('Employer'), 'company'],
	['Universities', column('Universities'), 'school'],
	['Supplied company', column('Supplied company'), 'employer-hint'],
	['Contact name', column('Contact name'), 'person'],
	['First name', column('First name'), 'first-name'],
	['E-mail', column('E-mail'), 'email'],
	['Profile hint', column('Profile hint'), 'profile'],
	['avatar_url', column('avatar_url'), 'photo'],
	['Notes', column('Notes'), null],
	// A format decides first: a "Homepage" formatted as a website is a website everywhere.
	['Homepage (website format)', column('Homepage', { format: 'website' }), 'website'],
	['Domain (text format)', column('Domain', { format: 'text' }), null],
	['Domain (URL format)', column('Domain', { format: 'url' }), 'website'],
	['LinkedIn (URL format)', column('LinkedIn', { format: 'url' }), 'profile'],
	['Contact (email format)', column('Contact', { format: 'email' }), 'email'],
	['Brief (document format)', column('Brief', { format: 'document' }), 'document'],
	// Then what an operation declares it returns, whatever its header.
	['person employer', column('Employer name', { op: person('company') }), 'company'],
	['person employer domain', column('Where they work', { op: person('company_domain') }), 'website'],
	['person LinkedIn', column('LinkedIn URL', { op: person('linkedin') }), 'profile'],
	['person title called Company', column('Company', { op: person('title') }), null],
	['company name', column('Company name', { op: { kind: 'company', domain: '{{Domain}}', field: 'title' } }), 'company'],
	['company description called Company', column('Company', { op: { kind: 'company', domain: '{{Domain}}', field: 'description' } }), null],
	['found email', column('Work email', { op: { kind: 'email-enrichment', name: '{{Name}}', company: '', domain: '{{Domain}}', profileUrl: '', providers: ['hunter'] } }), 'email'],
	['found page', column('Pricing', { op: { kind: 'scrape', page: { type: 'find', column: 'Domain', page: 'pricing' }, mode: 'url', maxChars: 2000 } }), 'webpage'],
	['found page kept as text', column('Pricing', { format: 'text', op: { kind: 'scrape', page: { type: 'find', column: 'Domain', page: 'pricing' }, mode: 'url', maxChars: 2000 } }), null],
	['document answer', column('Report', { op: { kind: 'ai', prompt: 'Write', output: 'document', research: 'none' } }), 'document'],
	['email draft', column('Outreach', { op: { kind: 'email-draft', mode: 'ai', prompt: 'Hi', to: '', cc: '', bcc: '', subject: '', body: '' } }), 'email-draft'],
	// An operation that declares nothing leaves the header to decide.
	['AI column called Website', column('Website', { op: { kind: 'ai', prompt: 'Find it', output: 'text', research: 'web' } }), 'website'],
];

for (const [name, target, role] of roles) test(`role: ${name}`, () => assert.equal(columnRole(target), role));

test('lookups take the first column in sheet order playing a role, and can skip one', () => {
	const name = column('Name'), company = column('Company'), site = column('Company website'), other = column('Website');
	const columns = [name, company, site, other];
	assert.equal(roleColumn(columns, 'website'), site);
	assert.equal(roleColumn(columns, 'website', site.id), other);
	assert.equal(roleColumn(columns, ['company', 'website']), company);
	assert.equal(roleColumn(columns, 'email'), undefined);
	assert.equal(columnsEntity(columns), 'companies');
	assert.equal(columnsEntity([...columns, column('LinkedIn')]), 'people');
	assert.equal(columnsEntity([column('Webpage')]), 'websites');
});

test('new columns: headers suggest a format only for source columns; enrichments take their operation’s', () => {
	const ai: ColumnOp = { kind: 'ai', prompt: 'Find the website', output: 'text', research: 'web' };
	assert.equal(inferredFormat({ name: 'Company website', type: 'source' }), 'website');
	assert.equal(inferredFormat({ name: 'Website', type: 'enriched', op: ai }), undefined);
	assert.equal(inferredFormat({ name: 'Anything', type: 'enriched', op: person('company_domain') }), 'website');
	assert.equal(inferredFormat({ name: 'Pricing', type: 'enriched', op: { kind: 'scrape', page: { type: 'homepage', column: 'Domain' }, mode: 'url', maxChars: 2000 } }), 'webpage');
});

test('every caller finds the same website column', () => {
	const company = column('Company'), homepage = column('Homepage', { format: 'website' }), name = column('Full name');
	const columns = [name, company, homepage];
	const row: Row = { id: 'r', sheetId: 's', order: 0, createdAt: 1, cells: { [company.id]: { v: 'Acme', s: 'done', t: 1 }, [homepage.id]: { v: 'acme.com', s: 'done', t: 1 } } };
	assert.equal(entityKind(homepage), 'website');
	assert.equal(defaultEmailWaterfall(columns).domain, '{{Homepage}}');
	assert.equal(defaultEmailWaterfall(columns).name, '{{Full name}}');
	assert.equal(guessDomainColumn(columns), 'Homepage');
	assert.equal(companyPreview(row, company, columns).domain, 'acme.com');
	assert.equal(documentClientDomain({ columns }, row), 'acme.com');
	const op = entityFieldOp(company, columns, { kind: 'company', field: 'industry', label: 'Industry' });
	assert.equal(op.kind === 'company' && op.domain, '{{Homepage}}');
});
