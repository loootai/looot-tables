import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { z } from 'zod';
import { ColumnOpInputSchema, columnNameFromQuestion, definitionIssue, instructionText, missingProviders, OP_KINDS, operation } from '../src/lib/operations';
import { PROVIDERS } from '../src/lib/organization-settings';
import { opDependencies, readsRowContext, renameOpReferences } from '../src/lib/references';
import { ColumnOpSchema, type ColumnOp, type OpKind } from '../src/lib/types';

/** One valid definition per kind; Record<OpKind, …> fails to compile when a kind is added without one. */
const SAMPLES: Record<OpKind, ColumnOp> = {
	'email-enrichment': { kind: 'email-enrichment', name: '{{Name}}', company: '', domain: '{{Domain}}', profileUrl: '', providers: ['hunter'] },
	'email-draft': { kind: 'email-draft', mode: 'ai', prompt: 'Intro', to: '{{Email}}', cc: '', bcc: '', subject: '', body: '' },
	ai: { kind: 'ai', prompt: 'CEO?', output: 'text', research: 'web', page: { type: 'homepage', column: 'Domain' } },
	check: { kind: 'check', question: 'B2B?', decider: 'jev', threshold: 0.5, page: { type: 'find', column: 'Domain', page: 'pricing' } },
	classify: { kind: 'classify', question: 'Segment?', options: [{ label: 'SMB' }, { label: 'Enterprise' }], decider: 'jev' },
	score: { kind: 'score', question: 'Fit?', levels: ['Low', 'High'], decider: 'openai' },
	scrape: { kind: 'scrape', page: { type: 'template', template: 'https://{{Domain}}/about' }, mode: 'highlights', query: 'Mission', maxChars: 2000 },
	search: { kind: 'search', query: '{{Company}} CEO', pick: 'url', numResults: 3 },
	company: { kind: 'company', domain: '{{Domain}}', field: 'industry' },
	person: { kind: 'person', name: '{{Name}}', field: 'title' },
	hunter: { kind: 'hunter', action: 'verify', email: '{{Email}}' },
	prospeo: { kind: 'prospeo', email: '{{Email}}', field: 'mobile', onlyVerifiedEmail: true },
	answer: { kind: 'answer', task: 'Latest funding', output: 'text', mode: 'fast' },
	template: { kind: 'template', template: 'Hi {{Name}}' },
};

const shapes = new Map(ColumnOpSchema.options.map((option) => [option.shape.kind.value as OpKind, option.shape as Record<string, z.ZodType>]));
/** Free-text fields, as opposed to enums, numbers, lists and objects. */
function isText(schema: z.ZodType): boolean {
	const def = schema._zod.def as { type: string; innerType?: z.ZodType };
	return def.innerType ? isText(def.innerType) : def.type === 'string';
}

test('the catalog has exactly one record for every operation kind in the schema', () => {
	assert.deepEqual([...OP_KINDS].sort(), [...shapes.keys()].sort());
});

for (const kind of OP_KINDS) test(`${kind}: the catalog record is complete and consistent`, () => {
	const record = operation(kind);
	const sample = SAMPLES[kind];
	const shape = shapes.get(kind)!;
	assert.ok(ColumnOpInputSchema.safeParse(sample).success, 'the sample is a valid definition');
	for (const text of [record.label, record.short, record.description, record.columnName]) assert.ok(text.trim(), 'every label is written');
	assert.ok(record.references.length, 'every operation reads something');

	// Every reference field is a field of this kind, and is both counted as a dependency and renamed.
	for (const field of record.references) {
		assert.ok(field in shape, `${field} is a field of ${kind}`);
		const probe = { ...sample, [field]: isText(shape[field]) ? `{{Probe}} and {{ probe }}` : { type: 'column', column: 'Probe' } } as ColumnOp;
		assert.ok(opDependencies(probe).includes('Probe'), `${field} is a dependency`);
		const renamed = renameOpReferences(probe, 'probe', 'Renamed');
		assert.ok(opDependencies(renamed).includes('Renamed') && !opDependencies(renamed).some((name) => name.toLowerCase() === 'probe'), `${field} is renamed`);
	}
	// Other free text (questions' literals, labels) never reads columns.
	for (const [field, schema] of Object.entries(shape)) {
		if (field === 'kind' || record.references.includes(field as never) || !isText(schema)) continue;
		const probe = { ...sample, [field]: '{{Probe}}' } as ColumnOp;
		assert.ok(!opDependencies(probe).includes('Probe'), `${field} is not a reference`);
		assert.deepEqual(renameOpReferences(probe, 'Probe', 'Renamed'), probe, `${field} is not renamed`);
	}
	if (record.instruction) {
		assert.ok(record.references.includes(record.instruction), 'the instruction may reference columns');
		assert.equal(instructionText({ ...sample, [record.instruction]: 'Do it' } as ColumnOp), 'Do it');
	} else assert.equal(instructionText(sample), '');

	const needs = record.requires(sample as never);
	for (const need of needs) assert.ok(need.length && need.every((provider) => PROVIDERS.includes(provider)), 'needs name real providers');
	assert.deepEqual(missingProviders(sample, () => true), []);
	assert.deepEqual(missingProviders(sample, () => false), needs.map((need) => need[0]));
	if (record.local(sample as never)) assert.deepEqual([needs, record.credits(sample as never)], [[], 0], 'local operations call no provider');
	if (record.bills && record.bills !== 'email') assert.ok(needs.some((need) => need.includes(record.bills as never)), 'it bills a provider it requires');
	const credits = record.credits(sample as never), worst = record.worstCaseMs(sample as never);
	assert.ok(Number.isFinite(credits) && credits >= 0);
	assert.ok(worst > 0 && worst < 280_000, 'one run fits inside the MCP row deadline');
	assert.ok(['row', 'references', 'row-unless-referenced'].includes(record.rowContext(sample as never)));
});

test('modes change what an operation needs, reads and costs', () => {
	const draft = SAMPLES['email-draft'] as Extract<ColumnOp, { kind: 'email-draft' }>;
	const cases: Array<{ name: string; op: ColumnOp; requires: string[][]; local: boolean; readsRow: boolean; credits: number }> = [
		{ name: 'AI email draft', op: draft, requires: [['openai']], local: false, readsRow: true, credits: 0 },
		{ name: 'template email draft', op: { ...draft, mode: 'template' }, requires: [], local: true, readsRow: false, credits: 0 },
		{ name: 'Ask AI reading a page found on the site', op: { kind: 'ai', prompt: 'CEO?', output: 'text', research: 'web', page: { type: 'find', column: 'Domain', page: 'team' } }, requires: [['openai'], ['context']], local: false, readsRow: true, credits: 6 },
		{ name: 'Ask AI from the row alone', op: { kind: 'ai', prompt: 'CEO?', output: 'text', research: 'none' }, requires: [['openai']], local: false, readsRow: true, credits: 0 },
		{ name: 'check decided by a model', op: { kind: 'check', question: 'B2B?', decider: 'jev', threshold: 0.5 }, requires: [['typesafe', 'openai']], local: false, readsRow: true, credits: 0 },
		{ name: 'exact-text check on a page', op: { kind: 'check', question: 'Free plan?', literal: 'free', decider: 'jev', threshold: 0.5, page: { type: 'column', column: 'URL' } }, requires: [['context']], local: false, readsRow: true, credits: 1 },
		{ name: 'research that references its subject', op: { kind: 'answer', task: 'Funding of {{Company}}', output: 'text', mode: 'ultra' }, requires: [['context']], local: false, readsRow: false, credits: 100 },
		{ name: 'research about the whole row', op: SAMPLES.answer, requires: [['context']], local: false, readsRow: true, credits: 10 },
		{ name: 'page read', op: SAMPLES.scrape, requires: [['context']], local: false, readsRow: false, credits: 1 },
		{ name: 'text template', op: SAMPLES.template, requires: [], local: true, readsRow: false, credits: 0 },
	];
	for (const { name, op, requires, local, readsRow, credits } of cases) {
		const record = operation(op.kind);
		assert.deepEqual(record.requires(op as never), requires, name);
		assert.equal(record.local(op as never), local, name);
		assert.equal(readsRowContext(op), readsRow, name);
		assert.equal(record.credits(op as never), credits, name);
	}
});

test('an extract needs fields or instructions before it is saved, while stored definitions stay loadable', () => {
	const extract = { kind: 'scrape', page: { type: 'homepage', column: 'Domain' }, mode: 'extract', maxChars: 2000 } as const;
	const cases = [
		{ op: extract, issue: 'Add a field or instructions to extract.' },
		{ op: { ...extract, query: '   ' }, issue: 'Add a field or instructions to extract.' },
		{ op: { ...extract, query: 'Founders' }, issue: null },
		{ op: { ...extract, fields: [{ name: 'CEO' }] }, issue: null },
		{ op: { ...extract, mode: 'highlights' }, issue: null },
	] as const;
	for (const { op, issue } of cases) {
		const parsed = ColumnOpSchema.parse(op);
		assert.equal(definitionIssue(parsed)?.message ?? null, issue);
		const input = ColumnOpInputSchema.safeParse(op);
		assert.equal(input.success, !issue);
		if (!input.success) assert.deepEqual(input.error.issues[0].path, ['fields']);
	}
});

test('AI columns are named from their question in short title case', () => {
	assert.equal(columnNameFromQuestion('Who is the CEO of {{Company}}?'), 'CEO');
	assert.equal(columnNameFromQuestion('Who is the head of sales at {{Company}}?'), 'Head of Sales');
	assert.equal(columnNameFromQuestion('What is {{Company}}’s annual revenue?'), 'Annual Revenue');
	assert.equal(columnNameFromQuestion('How many employees does {{Company}} have?'), 'Employees');
	assert.equal(columnNameFromQuestion('Which segment does {{Company}} serve?'), 'Segment');
	assert.equal(columnNameFromQuestion('Does {{Domain}} offer a free tier on its pricing page?'), 'Free Tier?');
	assert.equal(columnNameFromQuestion('Is {{Company}} a B2B company?'), 'B2B Company?');
	assert.equal(columnNameFromQuestion('Find the LinkedIn URL for {{Name}}'), 'LinkedIn URL');
	assert.equal(columnNameFromQuestion('Draft a summary of {{Company}}'), 'Summary');
	assert.equal(columnNameFromQuestion('What does {{Company}} sell?'), '', 'only a verb is left: keep the default name');
	assert.equal(columnNameFromQuestion('How mature is {{Company}}?'), '');
	assert.equal(columnNameFromQuestion('Research each company and write a two-paragraph summary of its market position'), '');
	assert.equal(columnNameFromQuestion(''), '');
});
