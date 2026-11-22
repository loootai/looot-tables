'use client';

import { parseJsonEventStream, readUIMessageStream, uiMessageChunkSchema, type UIMessage, type UIMessageChunk } from 'ai';
import { useCallback, useEffect, useRef, useState } from 'react';
import { refreshWorkspace } from '@/lib/db';
import { keyHeaders } from '@/lib/keys';

/* The agent panel's state: the conversation (AI SDK UI messages, streamed from /api/agent) and the quote cards the user
   ran. A card runs through /api/agent/run, never through the model, and its result goes back to the agent as a message. */

export interface QuoteCard {
	quoteId: string;
	kind: 'column' | 'find';
	label: string;
	maxUsd: number;
	cells: number;
	column?: string;
	columnId?: string;
	tryFirst?: { rows: number; maxUsd: number; label: string };
}
export interface CardRun {
	state: 'running' | 'done' | 'failed' | 'cancelled';
	rows?: number;
	done: number;
	total: number;
	spentUsd: number;
	result?: Record<string, unknown>;
	error?: string;
}

const STORAGE = (sheetId: string) => `looot-tables.agent.v1.${sheetId}`;
const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
const usd = (value: unknown) => Number(value ?? 0).toFixed(Number(value ?? 0) < 0.01 ? 4 : 2);

function load(sheetId: string): { messages: UIMessage[]; runs: Record<string, CardRun> } {
	try {
		const saved = JSON.parse(window.localStorage.getItem(STORAGE(sheetId)) ?? 'null');
		return saved && Array.isArray(saved.messages) ? { messages: saved.messages, runs: saved.runs ?? {} } : { messages: [], runs: {} };
	} catch { return { messages: [], runs: {} }; }
}

/** Calls `refresh` at most once a second while calls keep coming, and once more after the last. */
function throttle(refresh: () => void) {
	let timer: ReturnType<typeof setTimeout> | null = null, pending = false;
	return () => {
		if (timer) { pending = true; return; }
		refresh();
		timer = setTimeout(function again() { timer = null; if (pending) { pending = false; refresh(); timer = setTimeout(again, 1000); } }, 1000);
	};
}

/** The message sent to the agent after a card ran, so it can report and offer the next step. */
function runSummary(card: QuoteCard, run: CardRun): string {
	const result = run.result ?? {};
	if (card.kind === 'find') return `Done: found ${result.added ?? 0} people, $${usd(result.spentUsd)} spent.`;
	const ran = Number(result.done ?? run.done), left = Math.max(0, card.cells - ran);
	return `Done: ran ${ran} rows of ${card.column} (column ${card.columnId}): ${result.filled ?? 0} filled, ${result.empty ?? 0} empty, ${result.errors ?? 0} errors, $${usd(result.spentUsd)} spent. ${left} rows left.`;
}

export function useAgent(sheetId: string) {
	const [messages, setMessages] = useState<UIMessage[]>([]);
	const [runs, setRuns] = useState<Record<string, CardRun>>({});
	const [status, setStatus] = useState<'ready' | 'streaming'>('ready');
	const [error, setError] = useState<string | null>(null);
	const abort = useRef<AbortController | null>(null);
	const latest = useRef<UIMessage[]>([]);
	const refresh = useRef(throttle(() => { void refreshWorkspace().catch(() => undefined); }));

	useEffect(() => {
		const saved = load(sheetId);
		latest.current = saved.messages;
		// Restoring this viewer's conversation for the sheet, once, after mount (localStorage is not readable during SSR).
		// eslint-disable-next-line react-hooks/set-state-in-effect
		setMessages(saved.messages); setRuns(saved.runs);
	}, [sheetId]);
	useEffect(() => {
		try { window.localStorage.setItem(STORAGE(sheetId), JSON.stringify({ messages: messages.slice(-60), runs })); } catch { /* storage unavailable */ }
	}, [sheetId, messages, runs]);

	const send = useCallback(async (text: string) => {
		const trimmed = text.trim();
		if (!trimmed || abort.current) return;
		const history: UIMessage[] = [...latest.current, { id: newId(), role: 'user', parts: [{ type: 'text', text: trimmed }] }];
		latest.current = history;
		setMessages(history); setError(null); setStatus('streaming');
		const controller = new AbortController();
		abort.current = controller;
		try {
			const response = await fetch('/api/agent', { method: 'POST', headers: keyHeaders(), body: JSON.stringify({ messages: history, sheetId }), signal: controller.signal });
			if (!response.ok || !response.body) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? 'The agent could not answer. Try again.');
			const chunks = parseJsonEventStream({ stream: response.body, schema: uiMessageChunkSchema }).pipeThrough(new TransformStream<{ success: boolean; value?: UIMessageChunk }, UIMessageChunk>({ transform(part, out) { if (part.success && part.value) out.enqueue(part.value); } }));
			for await (const message of readUIMessageStream({ stream: chunks })) {
				latest.current = [...history, message];
				setMessages(latest.current);
				if (message.parts.some((part) => part.type.startsWith('tool-') && 'state' in part && part.state === 'output-available')) refresh.current();
			}
		} catch (caught) {
			if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'The agent could not answer. Try again.');
		} finally {
			abort.current = null;
			setStatus('ready');
			refresh.current();
		}
	}, [sheetId]);

	const stop = useCallback(() => abort.current?.abort(), []);

	/** The user's click on a card: run it (all rows, or `rows` first) inside the budget the card showed. */
	const runCard = useCallback(async (card: QuoteCard, rows?: number) => {
		const maxUsd = rows && card.tryFirst ? card.tryFirst.maxUsd : card.maxUsd;
		const total = rows ?? card.cells;
		const key = `${card.quoteId}:${rows ?? 'all'}`;
		const update = (patch: Partial<CardRun>) => setRuns((current) => ({ ...current, [key]: { ...(current[key] ?? { state: 'running', done: 0, total, spentUsd: 0 }), ...patch } }));
		update({ state: 'running', rows, done: 0, total, spentUsd: 0 });
		let final: CardRun = { state: 'failed', done: 0, total, spentUsd: 0, error: 'The run stopped before it finished.' };
		try {
			const response = await fetch('/api/agent/run', { method: 'POST', headers: keyHeaders(), body: JSON.stringify({ kind: card.kind, quoteId: card.quoteId, maxUsd, idempotencyKey: `ui-${newId()}`, ...(rows ? { rows } : {}) }) });
			if (!response.ok || !response.body) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? 'Could not start the run.');
			const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
			let buffer = '';
			for (let part = await reader.read(); !part.done; part = await reader.read()) {
				buffer += part.value;
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';
				for (const line of lines.filter(Boolean)) {
					const event = JSON.parse(line) as { type: string; done?: number; total?: number; spentUsd?: number; result?: Record<string, unknown>; error?: string };
					if (event.type === 'progress') { update({ done: event.done ?? 0, total: event.total ?? total, spentUsd: event.spentUsd ?? 0 }); refresh.current(); }
					if (event.type === 'done') final = { state: 'done', rows, done: Number(event.result?.done ?? event.result?.added ?? total), total, spentUsd: Number(event.result?.spentUsd ?? 0), result: event.result };
					if (event.type === 'error') final = { state: 'failed', rows, done: 0, total, spentUsd: 0, error: event.error };
				}
			}
		} catch (caught) { final = { ...final, error: caught instanceof Error ? caught.message : final.error }; }
		update(final);
		refresh.current();
		if (final.state === 'done') await send(runSummary(card, final));
	}, [send]);

	const cancelCard = useCallback((card: QuoteCard) => setRuns((current) => ({ ...current, [`${card.quoteId}:cancelled`]: { state: 'cancelled', done: 0, total: card.cells, spentUsd: 0 } })), []);

	const reset = useCallback(() => { latest.current = []; setMessages([]); setRuns({}); setError(null); }, []);

	return { messages, runs, status, error, send, stop, runCard, cancelCard, reset };
}
