import 'server-only';

import type { LanguageModelV4 } from '@ai-sdk/provider';
import { TypeSafeClient, choice, noul, score, type Questions, type SystemOneRequest, type SystemOneResult } from '@typesafe-ai/sdk';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import type { Decider } from '../types';
import { CredentialError } from './credentials';
import { retryUnbilled, trackedFetch, type Spend } from './enrich-failure';
import type { ProviderAccess } from './provider-access';

/** What decisions need from a TypeSafe client. */
export interface Jev {
	systemOne<const Q extends Questions>(request: SystemOneRequest<Q>): Promise<SystemOneResult<Q>>;
}

/* Decisions: true/false, pick-one, and rubric scores. TypeSafe Jev is the first choice because it returns calibrated
   probabilities rather than generated text; when no TypeSafe key is configured, OpenAI
   produces the same shape of answer through structured output, with a self-reported confidence instead of a
   calibrated one. */

export interface NoulResult {
	probability: number;
	engine: 'jev' | 'openai';
	model: string;
	reasoning?: string;
}
export interface ChoiceResult {
	choice: string;
	probabilities: Record<string, number>;
	confidence?: number;
	engine: 'jev' | 'openai';
	model: string;
	reasoning?: string;
}
export interface ScoreResult {
	score: number;
	level: string;
	probabilities: Record<string, number>;
	confidence?: number;
	engine: 'jev' | 'openai';
	model: string;
	reasoning?: string;
}

const JEV_MODEL = 'jev-latest';
/** Jev reads 32k tokens per question by default; keep state comfortably inside that. */
const JEV_STATE_MAX_CHARS = 60_000;

/** A decision is billed once processed, and the SDK's own retries would repeat a timeout, a server error or a dropped
    connection: they are off, and only a request refused before processing is sent again (see `enrich-failure`). Every
    OpenAI decision below is sent once for the same reason. With a `spend`, every request it may have billed is recorded
    there. */
export function typesafeClient(apiKey: string, spend?: Spend) {
	const transport = retryUnbilled((input, init) => fetch(input, init));
	return new TypeSafeClient({ apiKey, timeout: 60_000, retry: { maxRetries: 0 }, fetch: spend ? trackedFetch(transport, spend) : transport });
}

interface OpenAIEngine { model: LanguageModelV4; id: string }

/** Jev unless OpenAI is preferred and available, or only OpenAI is configured. */
async function decide<T>(access: ProviderAccess, requested: Decider, viaJev: (jev: Jev) => Promise<T>, viaOpenAI: (engine: OpenAIEngine) => Promise<T>): Promise<T> {
	const typesafe = access.key('typesafe'), openai = access.key('openai');
	if (!typesafe && !openai) throw new CredentialError('Add a TypeSafe or OpenAI key in Configuration to run decision columns.');
	const withOpenAI = () => {
		const id = access.classifierModel ?? access.model;
		return viaOpenAI({ model: access.openai(id), id });
	};
	if (!typesafe || (openai && access.decider(requested) === 'openai')) return withOpenAI();
	return viaJev(access.typesafe());
}

const keyFor = (label: string, index: number) => `option_${index}_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30)}`;

export function decideNoul(access: ProviderAccess, requested: Decider, state: string, question: string): Promise<NoulResult> {
	return decide<NoulResult>(access, requested, async (jev) => {
		const response = await jev.systemOne({ model: JEV_MODEL, state: state.slice(0, JEV_STATE_MAX_CHARS), questions: { answer: noul(question) } });
		return { probability: response.answers.answer.noul, engine: 'jev', model: response.model };
	}, (engine) => noulWithOpenAI(engine, state, question));
}

async function noulWithOpenAI(engine: OpenAIEngine, state: string, question: string): Promise<NoulResult> {
	const { output } = await generateText({
		model: engine.model,
		output: Output.object({ schema: z.object({ reasoning: z.string().describe('One or two sentences of evidence.'), probability: z.number().min(0).max(1).describe('Probability that the answer to the question is yes.') }) }),
		system: 'You judge a single true/false question against the provided state. Use only the state; if the state lacks evidence, give a probability near 0.5 and say so.',
		prompt: `STATE:\n${state.slice(0, 80_000)}\n\nQUESTION: ${question}`,
		maxRetries: 0,
	});
	return { probability: output.probability, engine: 'openai', model: engine.id, reasoning: output.reasoning };
}

export function decideChoice(access: ProviderAccess, requested: Decider, state: string, question: string, options: Array<{ label: string; description?: string }>): Promise<ChoiceResult> {
	return decide<ChoiceResult>(access, requested, async (jev) => {
		const criteria: Record<string, string | null> = {};
		const labels = new Map<string, string>();
		options.forEach((option, index) => {
			const key = keyFor(option.label, index);
			criteria[key] = option.description ? `${option.label}: ${option.description}` : option.label;
			labels.set(key, option.label);
		});
		const response = await jev.systemOne({ model: JEV_MODEL, state: state.slice(0, JEV_STATE_MAX_CHARS), questions: { answer: choice(question, criteria) } });
		const answer = response.answers.answer as { choice: string; probabilities: Record<string, number>; confidence?: number | null };
		const probabilities: Record<string, number> = {};
		for (const [key, p] of Object.entries(answer.probabilities)) probabilities[labels.get(key) ?? key] = p;
		return { choice: labels.get(answer.choice) ?? answer.choice, probabilities, confidence: answer.confidence ?? undefined, engine: 'jev', model: response.model };
	}, (engine) => choiceWithOpenAI(engine, state, question, options));
}

async function choiceWithOpenAI(engine: OpenAIEngine, state: string, question: string, options: Array<{ label: string; description?: string }>): Promise<ChoiceResult> {
	const labels = options.map((option) => option.label);
	const { output } = await generateText({
		model: engine.model,
		output: Output.object({
			schema: z.object({
				reasoning: z.string(),
				choice: z.enum(labels as [string, ...string[]]),
				confidence: z.number().min(0).max(1),
			}),
		}),
		system: 'Pick exactly one option that best answers the question about the state. Use only the state.',
		prompt: `STATE:\n${state.slice(0, 80_000)}\n\nQUESTION: ${question}\n\nOPTIONS:\n${options.map((o) => `- ${o.label}${o.description ? `: ${o.description}` : ''}`).join('\n')}`,
		maxRetries: 0,
	});
	const probabilities: Record<string, number> = {};
	for (const label of labels) probabilities[label] = label === output.choice ? output.confidence : (1 - output.confidence) / Math.max(1, labels.length - 1);
	return { choice: output.choice, probabilities, confidence: output.confidence, engine: 'openai', model: engine.id, reasoning: output.reasoning };
}

export function decideScore(access: ProviderAccess, requested: Decider, state: string, question: string, levels: string[]): Promise<ScoreResult> {
	return decide<ScoreResult>(access, requested, async (jev) => {
		const response = await jev.systemOne({ model: JEV_MODEL, state: state.slice(0, JEV_STATE_MAX_CHARS), questions: { answer: score(question, levels) } });
		const answer = response.answers.answer as { score: number; probabilities: Record<string, number>; confidence?: number | null; legend?: Record<string, string> };
		const probabilities: Record<string, number> = {};
		for (const [index, p] of Object.entries(answer.probabilities)) probabilities[levels[Number(index)] ?? index] = p;
		const nearest = Math.max(0, Math.min(levels.length - 1, Math.round(answer.score)));
		return { score: answer.score, level: levels[nearest], probabilities, confidence: answer.confidence ?? undefined, engine: 'jev', model: response.model };
	}, (engine) => scoreWithOpenAI(engine, state, question, levels));
}

async function scoreWithOpenAI(engine: OpenAIEngine, state: string, question: string, levels: string[]): Promise<ScoreResult> {
	const { output } = await generateText({
		model: engine.model,
		output: Output.object({ schema: z.object({ reasoning: z.string(), level: z.number().int().min(0).max(levels.length - 1), confidence: z.number().min(0).max(1) }) }),
		system: 'Rate the state against the ordered levels (0 is the first level). Use only the state.',
		prompt: `STATE:\n${state.slice(0, 80_000)}\n\nQUESTION: ${question}\n\nLEVELS:\n${levels.map((level, index) => `${index}: ${level}`).join('\n')}`,
		maxRetries: 0,
	});
	const probabilities: Record<string, number> = {};
	levels.forEach((level, index) => {
		probabilities[level] = index === output.level ? output.confidence : (1 - output.confidence) / Math.max(1, levels.length - 1);
	});
	return { score: output.level, level: levels[output.level], probabilities, confidence: output.confidence, engine: 'openai', model: engine.id, reasoning: output.reasoning };
}

export async function verifyTypesafeKey(apiKey: string): Promise<{ ok: boolean; message?: string }> {
	try {
		const client = typesafeClient(apiKey);
		await client.models.list();
		return { ok: true };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : 'Could not verify the TypeSafe key' };
	}
}
