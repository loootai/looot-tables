import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readUIMessageStream, type UIMessage } from 'ai';
import type { Account } from '../../src/lib/auth-identity';
import { AGENT_ANTHROPIC_MODEL, agentModel, agentTools, streamAgent } from '../../src/lib/server/agent';
import { McpStore } from '../../src/lib/server/mcp-store';
import { BROWSER_POLICY, providerAccess, resolveAccess, resolveGrant } from '../../src/lib/server/provider-access';
import { SheetTools } from '../../src/lib/server/sheet-tools';
import { WorkspaceStore } from '../../src/lib/server/workspace-store';
import { testDatabase } from '../support/database';
import { freePort, startStandIn } from '../support/stand-ins';

/* The in-app agent against the stand-ins: the scripted model in scripts/mock-looot.mjs --openai plays the user's
   request end to end. The agent never holds a paid tool; the user's clicks (here: tools.call, as /api/agent/run does)
   run each quote inside the budget the card showed. Nothing reaches a real provider. */

const actor: Account = { issuer: 'https://agent-tests.invalid', organization: { id: 'org', name: 'org' }, user: { id: 'alice', email: 'alice@example.com', email_verified: true }, partition: 'alice' };
let looot: Awaited<ReturnType<typeof startStandIn>>, openaiPort: number;
before(async () => {
	openaiPort = await freePort();
	process.env.MOCK_OPENAI_PORT = String(openaiPort);
	looot = await startStandIn('mock-looot.mjs', ['--openai']);
	process.env.LOOOT_API_URL = looot.url;
	// The model stand-in listens a moment after the looot one.
	for (let tries = 0; tries < 50; tries++) { if (await fetch(`http://127.0.0.1:${openaiPort}/v1/models`).then(() => true, () => false)) break; await new Promise((resolve) => setTimeout(resolve, 50)); }
});
after(() => looot?.stop());

const headers = () => new Headers({ 'x-looot-key': 'lt_test_token', 'x-openai-key': 'sk-test', 'x-openai-base-url': `http://127.0.0.1:${openaiPort}/v1`, 'x-openai-model': 'mock-model' });

test('the agent runs on the caller’s own key: Claude when they have an Anthropic key, else OpenAI, else nothing', () => {
	const models: string[] = [];
	const fake = (name: string) => ({ specificationVersion: 'v4', provider: name, modelId: name, supportedUrls: {}, doGenerate: async () => { throw new Error('unused'); }, doStream: async () => { throw new Error('unused'); } }) as never;
	const access = (keys: Record<string, string>) => providerAccess(resolveGrant(BROWSER_POLICY, { account: actor, headers: new Headers(Object.fromEntries(Object.entries(keys).map(([provider, key]) => [`x-${provider}-key`, key]))) }), { anthropic: (_key, model) => { models.push(`anthropic:${model}`); return fake(model); }, openai: (_key, model) => { models.push(`openai:${model}`); return fake(model); } });
	assert.equal(agentModel(access({ anthropic: 'sk-ant-test', openai: 'sk-test' })).id, `anthropic/${AGENT_ANTHROPIC_MODEL}`);
	assert.equal(agentModel(access({ openai: 'sk-test' })).id.startsWith('openai/'), true);
	assert.equal(agentModel(access({ anthropic: 'sk-ant-test', openai: 'sk-test' }), 'openai/gpt-5.4-mini').id, 'openai/gpt-5.4-mini');
	assert.throws(() => agentModel(access({ looot: 'lt_x' })), /Add an Anthropic or OpenAI API key/);
	assert.throws(() => agentModel(access({ openai: 'sk-test' }), 'anthropic/claude-sonnet-5-5'), /Anthropic API key/, 'a named model still needs its own key');
	assert.deepEqual(models, [`anthropic:${AGENT_ANTHROPIC_MODEL}`, 'openai:gpt-6-luna', 'openai:gpt-5.4-mini']);
});

test('eval: “find heads of RevOps, then get and verify their emails” takes three clicks and never spends on its own', async (t) => {
	const { database } = await testDatabase(t);
	const access = resolveAccess(BROWSER_POLICY, { account: actor, headers: headers() });
	const tools = new SheetTools({ database, sheets: new WorkspaceStore(database), keys: new McpStore(database, () => 'test-encryption-root-that-is-shared-across-environments') }, actor, access);
	await tools.call('create_sheet', { sheetId: 'revops', name: 'RevOps leads', template: 'people' });
	const offered = Object.keys(agentTools(tools));
	for (const paid of ['run_column', 'find_rows', 'enrich_cells', 'delete_sheet', 'update_spend_guard']) assert.ok(!offered.includes(paid), `${paid} is never offered to the model`);

	const history: UIMessage[] = [];
	const paidRuns = async () => ((await looot.log()).runs as Array<{ endpointId?: string; quoteOnly?: boolean }>).filter((run) => run.endpointId && !run.quoteOnly).length;
	/** One user message and the agent's whole turn; returns the quote card the turn ended with, if any. */
	const say = async (text: string) => {
		history.push({ id: `u${history.length}`, role: 'user', parts: [{ type: 'text', text }] });
		const result = await streamAgent({ model: agentModel(access).model, tools, messages: history, sheet: { id: 'revops', name: 'RevOps leads' } });
		let reply: UIMessage | undefined;
		for await (const message of readUIMessageStream({ stream: result.toUIMessageStream() })) reply = message;
		history.push(reply!);
		const card = reply!.parts.flatMap((part) => 'output' in part && part.output && typeof (part.output as { quoteId?: unknown }).quoteId === 'string' ? [part.output as Record<string, unknown>] : []).at(-1);
		const words = reply!.parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join(' ');
		return { card, words };
	};

	const spentBefore = await paidRuns();
	const first = await say('Find heads of RevOps at 50-500 person SaaS companies, then get their work emails and verify them');
	assert.ok(first.card, 'the agent prices the search');
	assert.match(String(first.card.label), /^Find up to 10 people · up to \$/);
	assert.match(first.words, /nothing is spent until you do/);
	assert.equal(await paidRuns(), spentBefore, 'asking spends nothing');

	// Click 1: run the search card, as /api/agent/run does.
	const found = await tools.call('find_rows', { quoteId: first.card.quoteId, maxUsd: first.card.maxUsd, idempotencyKey: 'click-find-0001' });
	assert.equal(found.added, 10);
	const second = await say(`Done: found ${found.added} people, $${found.spentUsd} spent.`);
	assert.ok(second.card, 'the agent adds a verified email column and prices it');
	assert.equal(second.card.column, 'Work email');
	assert.equal((second.card.tryFirst as { rows: number }).rows, 5);

	// Click 2: Try 5 rows.
	const trial = await tools.call('run_column', { quoteId: second.card.quoteId, maxUsd: (second.card.tryFirst as { maxUsd: number }).maxUsd, idempotencyKey: 'click-try-0001', rows: 5 });
	assert.equal(trial.done, 5);
	const third = await say(`Done: ran 5 rows of Work email (column ${second.card.columnId}): ${trial.filled} filled, ${trial.empty} empty, ${trial.errors} errors, $${trial.spentUsd} spent. 5 rows left.`);
	assert.ok(third.card, 'the rest is a new quote');
	assert.equal(third.card.cells, 5);
	assert.match(third.words, /5 of 5 rows ran/);

	// Click 3: run the rest.
	const rest = await tools.call('run_column', { quoteId: third.card.quoteId, maxUsd: third.card.maxUsd, idempotencyKey: 'click-rest-0001' });
	assert.equal(rest.done, 5);
	const last = await say(`Done: ran 5 rows of Work email (column ${second.card.columnId}): ${rest.filled} filled, ${rest.empty} empty, ${rest.errors} errors, $${rest.spentUsd} spent. 0 rows left.`);
	assert.equal(last.card, undefined);
	assert.match(last.words, /^Done\. Work email ran on every row/);
	const rows = await tools.call('query_rows', { sheetId: 'revops', limit: 100 });
	const filled = (rows.rows as Array<{ values: Record<string, unknown> }>).filter((row) => typeof row.values['Work email'] === 'string').length;
	assert.equal(filled, Number(trial.filled) + Number(rest.filled), 'every email the runs reported is in the sheet');
	assert.ok(Number(trial.spentUsd) <= Number((second.card.tryFirst as { maxUsd: number }).maxUsd) && Number(rest.spentUsd) <= Number(third.card.maxUsd), 'each click stayed inside the budget its card showed');
});
