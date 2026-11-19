import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promptEntity, promptResultCount, populateLimitError, sheetNameFromPrompt } from '../src/lib/populate-limit';
import { PopulateRequestSchema } from '../src/lib/types';

test('explicit result counts override the default without interpreting company attributes', () => {
	assert.equal(promptResultCount('Find me 80 companies'), 80);
	assert.equal(promptResultCount('Find 100 people'), 100);
	assert.equal(promptResultCount('Find the top 101 websites'), 101);
	assert.equal(promptResultCount('Find companies with 80 employees founded in 2020'), undefined);
	assert.equal(promptResultCount('Find me 1,000 companies'), 1000);
	assert.equal(populateLimitError(100), null);
	assert.match(populateLimitError(101)!, /Only 100/);
	assert.ok(populateLimitError(0));
	assert.equal(PopulateRequestSchema.parse({ query: 'software', entity: 'companies' }).target, 20);
	assert.equal(PopulateRequestSchema.safeParse({ query: 'software', entity: 'companies', target: 101 }).success, false);
});

test('sheet names come from the prompt: short, sentence-cased, without the request verb or count', () => {
	assert.equal(sheetNameFromPrompt('Find 50 solar installers in Texas that offer financing'), 'Solar installers in Texas');
	assert.equal(sheetNameFromPrompt('find me the top 20 solar installers in Texas'), 'Solar installers in Texas');
	assert.equal(sheetNameFromPrompt('Every residential solar installer in the United States'), 'Residential solar installer in the United States');
	assert.equal(sheetNameFromPrompt('Series A to C fintech startups in Europe with 20–200 employees'), 'Series A to C fintech startups in Europe');
	assert.equal(sheetNameFromPrompt('Founders of YC companies who studied at Stanford'), 'Founders of YC companies');
	assert.equal(sheetNameFromPrompt('SaaS pricing pages, ideally with a free tier'), 'SaaS pricing pages');
	assert.equal(sheetNameFromPrompt('companies like stripe.com\nmore notes'), 'Companies like stripe.com');
	assert.ok(sheetNameFromPrompt('A very long description of exactly the kind of company that we would like to sell our product to').length <= 56);
	assert.equal(sheetNameFromPrompt('Find 50'), '', 'nothing to name: the caller falls back to the entity');
});

test('the prompt picks companies, people or websites by the first kind of noun it names', () => {
	assert.equal(promptEntity('Find 30 heads of growth at Series B fintechs in the US'), 'people');
	assert.equal(promptEntity('Founders of YC companies in climate'), 'people');
	assert.equal(promptEntity('Engineers at Stripe'), 'people');
	assert.equal(promptEntity('SaaS pricing pages that mention a free tier'), 'websites');
	assert.equal(promptEntity('Blogs about residential solar'), 'websites');
	assert.equal(promptEntity('Companies whose websites mention SOC 2'), 'companies');
	assert.equal(promptEntity('Solar installers in Texas with 20-200 employees'), null, 'no kind named: the caller keeps its default');
});
