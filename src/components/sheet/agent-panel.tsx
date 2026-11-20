'use client';

import clsx from 'clsx';
import { AlertCircle, ArrowUp, Check, Play, RotateCcw, Sparkles, Square, X } from 'lucide-react';
import { getToolName, isToolUIPart, type UIMessage } from 'ai';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, IconButton } from '@/components/ui/button';
import { AGENT_PROMPTS } from '@/lib/agent-prompts';
import { stepText } from './agent-steps';
import { ProviderMark } from './provider-mark';
import { useAgent, type CardRun, type QuoteCard } from './use-agent';

/* The agent panel beside the sheet: a chat whose tool calls show as short steps, and whose quotes show as cards the user
   runs. The agent itself never runs anything that costs money. */

type Data = Record<string, unknown>;
/** The message the panel sends after the user runs a card (see useAgent); shown as a note, not as something they typed. */
const RUN_REPORT = /^Done: /;
const textOf = (message: UIMessage) => message.parts.map((part) => part.type === 'text' ? part.text : '').join('');
const usd = (value: number) => `$${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;

function cardOf(tool: string, output: Data): QuoteCard | null {
	if (typeof output.quoteId !== 'string') return null;
	if (tool === 'quote_find_rows') return { quoteId: output.quoteId, kind: 'find', label: String(output.label), maxUsd: Number(output.maxUsd), cells: Number(output.rowsUpTo) };
	return { quoteId: output.quoteId, kind: 'column', label: String(output.label), maxUsd: Number(output.maxUsd), cells: Number(output.cells), column: String(output.column), columnId: String(output.columnId), tryFirst: output.tryFirst as QuoteCard['tryFirst'] };
}

function Providers({ counts }: { counts: unknown }) {
	const entries = Object.entries((counts ?? {}) as Record<string, number>).sort((a, b) => b[1] - a[1]).slice(0, 4);
	if (!entries.length) return null;
	return <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">{entries.map(([provider, hits]) => <span key={provider} className="inline-flex items-center gap-1"><ProviderMark name={provider} size="xs" /><span className="tabular">{provider} {hits}</span></span>)}</span>;
}

function RunLine({ card, run }: { card: QuoteCard; run: CardRun }) {
	if (run.state === 'running') return (
		<div role="status" className="flex flex-col gap-1.5">
			<span className="flex items-center gap-2 text-caption text-fg-muted tabular"><span className="spinner" />{card.kind === 'find' ? 'Finding rows' : `Running ${run.done} of ${run.total}`} · {usd(run.spentUsd)}</span>
			{card.kind === 'column' && <span className="h-1 overflow-hidden rounded-full bg-neutral-10"><span className="block h-full rounded-full bg-brand transition-[width]" style={{ width: `${Math.round((run.done / Math.max(1, run.total)) * 100)}%` }} /></span>}
		</div>
	);
	if (run.state === 'failed') return <p role="alert" className="text-caption text-danger">{run.error}</p>;
	if (run.state === 'cancelled') return <p className="text-caption text-fg-subtle">Cancelled. Nothing was spent.</p>;
	const result = run.result ?? {};
	return (
		<div className="flex flex-col gap-1.5 text-caption text-fg-muted tabular">
			<span className="flex items-center gap-1.5 text-fg"><Check aria-hidden className="size-3.5 text-success" />
				{card.kind === 'find' ? `Added ${Number(result.added ?? 0)} rows` : `Ran ${Number(result.done ?? run.done)} rows · ${Number(result.filled ?? 0)} filled${Number(result.empty) ? ` · ${Number(result.empty)} empty` : ''}${Number(result.errors) ? ` · ${Number(result.errors)} errors` : ''}`} · {usd(Number(result.spentUsd ?? 0))}
			</span>
			<Providers counts={result.byProvider} />
		</div>
	);
}

/** A quote: what a click will run and the most it can cost. New columns offer the 5-row trial first. */
function QuoteCardView({ card, output, runs, onRun, onCancel }: { card: QuoteCard; output: Data; runs: Record<string, CardRun>; onRun: (rows?: number) => void; onCancel: () => void }) {
	const mine = Object.entries(runs).filter(([key]) => key.startsWith(`${card.quoteId}:`)).map(([, run]) => run);
	const sheet = output.sheetCap as { capUsd: number; remainingUsd: number } | null | undefined;
	const missing = (output.missingKeys as string[] | undefined) ?? [];
	const trial = card.tryFirst && card.tryFirst.rows < card.cells ? card.tryFirst : null;
	const fresh = card.kind === 'column' && Number(output.alreadyFinished ?? 0) === 0;
	const empty = card.cells === 0;
	return (
		<div className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface p-3 shadow-[0_1px_2px_rgb(0_0_0/0.04)]" data-quote-card>
			<div className="flex flex-col gap-0.5">
				<span className="text-body-sm font-medium text-fg tabular">{card.label}</span>
				<span className="text-caption text-fg-subtle">{card.kind === 'find' ? `${String(output.entity ?? 'rows')} · ${Number(output.searches ?? 0)} searches` : `${card.column} · ${String(output.job ?? output.operation ?? '')}`}{sheet ? ` · cap ${usd(sheet.remainingUsd)} left of ${usd(sheet.capUsd)}` : ''}</span>
			</div>
			{mine.map((run, index) => <RunLine key={index} card={card} run={run} />)}
			{!mine.length && (empty ? <p className="text-caption text-fg-subtle">{String(output.next ?? 'Nothing to run.')}</p>
				: missing.length ? <p role="alert" className="text-caption text-warning-strong">Add your {missing.join(' and ')} key to run this.</p>
				: <div className="flex flex-wrap items-center gap-1.5">
					<Button size="xs" variant={trial && fresh ? 'outline' : 'brand'} onClick={() => onRun()}>Run{card.kind === 'column' ? ` ${card.cells} ${card.cells === 1 ? 'row' : 'rows'}` : ''}</Button>
					{trial && <Button size="xs" variant={fresh ? 'brand' : 'outline'} onClick={() => onRun(trial.rows)}>Try {trial.rows} rows</Button>}
					<Button size="xs" variant="ghost" onClick={onCancel}>Cancel</Button>
					{trial && <span className="basis-full text-caption text-fg-subtle tabular">{trial.label.replace(/^Run /, 'Trial: ')}</span>}
				</div>)}
		</div>
	);
}

function Step({ state, children }: { state: 'running' | 'done' | 'error'; children: ReactNode }) {
	return (
		<div className={clsx('flex items-start gap-2 text-caption', state === 'error' ? 'text-danger' : 'text-fg-muted')}>
			<span aria-hidden className="mt-px grid size-4 shrink-0 place-items-center">{state === 'running' ? <span className="spinner !size-3" /> : state === 'error' ? <AlertCircle className="size-3.5" /> : <Check className="size-3.5 text-success" />}</span>
			<span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{children}</span>
		</div>
	);
}

function AssistantParts({ message, runs, onRun, onCancel }: { message: UIMessage; runs: Record<string, CardRun>; onRun: (card: QuoteCard, rows?: number) => void; onCancel: (card: QuoteCard) => void }) {
	return <>{message.parts.map((part, index) => {
		if (part.type === 'text') return part.text.trim() ? <p key={index} className="text-body-sm whitespace-pre-wrap text-fg">{part.text}</p> : null;
		if (!isToolUIPart(part)) return null;
		const tool = String(getToolName(part));
		const input = (part.input ?? {}) as Data;
		if (part.state === 'output-error') return <Step key={index} state="error">{stepText(tool, input)}: {part.errorText}</Step>;
		if (part.state !== 'output-available') return <Step key={index} state="running">{stepText(tool, input)}</Step>;
		const output = (part.output ?? {}) as Data;
		if (typeof output.error === 'string') return <Step key={index} state="error">{stepText(tool, input)}: {output.error}</Step>;
		const card = (tool === 'quote_run' || tool === 'quote_find_rows') ? cardOf(tool, output) : null;
		if (card) return <QuoteCardView key={index} card={card} output={output} runs={runs} onRun={(rows) => onRun(card, rows)} onCancel={() => onCancel(card)} />;
		return <Step key={index} state="done">{stepText(tool, input, output)}</Step>;
	})}</>;
}

export function AgentPanel({ sheetId, onClose, keyReady, onOpenKeys }: { sheetId: string; onClose: () => void; keyReady: boolean; onOpenKeys: () => void }) {
	const agent = useAgent(sheetId);
	const [draft, setDraft] = useState('');
	const scroller = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLTextAreaElement>(null);
	const busy = agent.status === 'streaming';
	useEffect(() => { input.current?.focus(); }, []);
	useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' }); }, [agent.messages, agent.runs]);
	const submit = () => { if (!draft.trim() || busy) return; void agent.send(draft); setDraft(''); };

	return (
		<aside aria-label="Agent" className="glass-frame sheet-pane flex min-h-0 w-[380px] shrink-0 flex-col overflow-hidden max-lg:w-[340px] max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-40 max-md:h-[80dvh] max-md:w-full max-md:rounded-b-none max-md:border-t max-md:border-line">
			<header className="flex h-12 shrink-0 items-center gap-2 border-b border-line-subtle px-3">
				<span aria-hidden className="grid size-6 place-items-center rounded-md bg-blue-10 text-brand"><Sparkles className="size-3.5" strokeWidth={1.75} /></span>
				<h2 className="text-body-sm font-medium text-fg">Agent</h2>
				<span className="truncate text-caption text-fg-subtle">Paid steps wait for your click</span>
				<div className="ml-auto flex items-center">
					{agent.messages.length > 0 && <IconButton size="sm" label="New conversation" disabled={busy} onClick={agent.reset}><RotateCcw /></IconButton>}
					<IconButton size="sm" label="Close agent (⌘K)" onClick={onClose}><X /></IconButton>
				</div>
			</header>

			<div ref={scroller} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4">
				{agent.messages.length === 0 && (
					<div className="flex flex-1 flex-col justify-end gap-3">
						<p className="text-body-sm text-fg-muted">Tell the agent who or what you are looking for. It builds the columns and prices every paid step; you click to run it.</p>
						<div className="flex flex-col gap-2">
							{AGENT_PROMPTS.map((prompt) => (
								<button key={prompt.name} type="button" disabled={!keyReady || busy} onClick={() => void agent.send(prompt.starter)} className="rounded-xl border border-line-subtle bg-neutral-5 px-3 py-2.5 text-left transition-colors hover:border-line hover:bg-blue-10 disabled:opacity-50">
									<span className="block text-body-sm font-medium text-fg">{prompt.title}</span>
									<span className="block text-caption text-fg-subtle">{prompt.starter}</span>
								</button>
							))}
						</div>
					</div>
				)}
				{agent.messages.map((message) => message.role === 'user' && RUN_REPORT.test(textOf(message))
					? <p key={message.id} className="flex items-start gap-2 self-end text-caption text-fg-subtle"><Play aria-hidden className="mt-0.5 size-3 shrink-0 fill-current" />{textOf(message).replace(RUN_REPORT, 'You ran it: ').replace(/ \(column [^)]+\)/, '')}</p>
					: message.role === 'user'
					? <div key={message.id} className="ml-8 self-end rounded-2xl rounded-br-md bg-blue-10 px-3 py-2 text-body-sm whitespace-pre-wrap text-fg">{message.parts.map((part) => part.type === 'text' ? part.text : '').join('')}</div>
					: <div key={message.id} className="flex flex-col gap-2"><AssistantParts message={message} runs={agent.runs} onRun={(card, rows) => void agent.runCard(card, rows)} onCancel={agent.cancelCard} /></div>)}
				{busy && agent.messages.at(-1)?.role === 'user' && <span role="status" className="flex items-center gap-2 text-caption text-fg-subtle"><span className="spinner" />Thinking</span>}
				{agent.error && <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-caption text-danger-strong">{agent.error}</p>}
			</div>

			<div className="shrink-0 border-t border-line-subtle p-2.5">
				{!keyReady ? (
					<div className="flex items-center justify-between gap-2 rounded-lg bg-warning-soft px-3 py-2 text-caption text-fg">
						<span>Add an Anthropic or OpenAI key to talk to the agent.</span>
						<Button size="xs" variant="outline" onClick={onOpenKeys}>Add a key</Button>
					</div>
				) : (
					<form className="flex items-end gap-2 rounded-xl border border-line bg-surface px-2.5 py-1.5 focus-within:border-brand" onSubmit={(event) => { event.preventDefault(); submit(); }}>
						<textarea ref={input} aria-label="Message the agent" rows={1} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} placeholder="Find heads of RevOps at 50-500 person SaaS companies…" className="max-h-40 min-h-9 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-body-sm text-fg outline-none [field-sizing:content] placeholder:text-fg-subtle" />
						{busy ? <IconButton size="sm" label="Stop" onClick={agent.stop}><Square className="fill-current" /></IconButton>
							: <button type="submit" aria-label="Send" disabled={!draft.trim()} className="mb-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-brand text-brand-fg transition-opacity disabled:opacity-40 max-md:size-11"><ArrowUp className="size-4" /></button>}
					</form>
				)}
			</div>
		</aside>
	);
}
