'use client';

import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { FunctionSquare, Sparkles, TriangleAlert } from 'lucide-react';
import { buildFormula } from '@/lib/api';
import { previewErrors } from '@/lib/formula-builder';
import { resolveColumnFormula } from '@/lib/formula-columns';
import { Field, Input } from '@/components/ui/field';
import { ColumnPrompt } from './column-prompt';
import { columnAddress } from '@/lib/formula-input';
import { calculateInWorker } from '@/lib/formula-worker-client';
import { formatValue } from '@/lib/template';
import type { Column, Row } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { FormulaEditor } from './formula-editor';

interface Preview { formula: string; results: Array<{ address: string; value: string; error: boolean }>; error?: string }
/** One request at a time: writing and repairing share the abort controller; saving blocks both. */
type Phase = 'idle' | 'writing' | 'repairing' | 'saving';
/** A composed formula gets one automatic repair, then hands back to the caller's fallback. */
type Repair = 'available' | 'used' | 'fell-back';

interface PreviewInput { formula: string; originalColumns: Column[]; columns: Column[]; rows: Row[]; columnId: string; columnLetter: string; targetRow: number; newColumn: boolean }

/** Calculates the formula locally (debounced) on the target row, or on the first 10 rows for a new column. */
function useFormulaPreview({ formula, originalColumns, columns, rows, columnId, columnLetter, targetRow, newColumn }: PreviewInput, onResult: (preview: Preview) => void) {
	const [preview, setPreview] = useState<Preview | null>(null);
	const report = useEffectEvent((next: Preview) => { setPreview(next); onResult(next); });
	useEffect(() => {
		if (!formula.trim().startsWith('=') || formula.trim() === '=' || !rows[targetRow]) return;
		let cancelled = false;
		const timer = setTimeout(() => {
			const row = rows[targetRow];
			void (async () => {
				const resolved = resolveColumnFormula(formula, columns, targetRow);
				const nextRows = rows.map((item) => item.id === row.id ? { ...item, cells: { ...item.cells, [columnId]: { s: 'done' as const, f: resolved, v: null, t: Date.now() } } } : item);
				let results = await calculateInWorker({ grid: { columns: originalColumns, rows }, next: { columns, rows: nextRows } });
				const previewRows = newColumn ? rows.slice(0, 10) : [row];
				if (newColumn && previewRows.length > 1) {
					// Reconcile column insertion before filling, so references use the same addresses as the saved column.
					const calculated = new Map<string, Record<string, typeof results[number]['cell']>>();
					for (const result of results) {
						const cells = calculated.get(result.rowId) ?? {};
						cells[result.columnId] = result.cell;
						calculated.set(result.rowId, cells);
					}
					const evaluatedRows = nextRows.map((item) => ({ ...item, cells: { ...item.cells, ...calculated.get(item.id) } }));
					results = await calculateInWorker({ grid: { columns, rows: evaluatedRows }, copies: previewRows.slice(1).map((item) => ({ source: { rowId: row.id, columnId }, target: { rowId: item.id, columnId } })) });
				}
				const cells = new Map(results.filter((result) => result.columnId === columnId).map((result) => [result.rowId, result.cell]));
				if (cancelled) return;
				report({ formula, results: previewRows.map((item, index) => {
					const cell = cells.get(item.id);
					return { address: `${columnLetter}${newColumn ? index + 1 : targetRow + 1}`, value: cell?.e ?? formatValue(cell?.v ?? null), error: cell?.s === 'error' };
				}) });
			})().catch((reason) => { if (!cancelled) report({ formula, results: [], error: reason instanceof Error ? reason.message : 'Preview failed' }); });
		}, 250);
		return () => { cancelled = true; clearTimeout(timer); };
	}, [formula, originalColumns, columns, columnLetter, rows, columnId, targetRow, newColumn]);
	return preview;
}

/** One request at a time: starting one aborts the last, and only the newest may clear the phase. */
function useFormulaRequest() {
	const [phase, setPhase] = useState<Phase>('idle');
	const controller = useRef<AbortController | null>(null);
	useEffect(() => () => { controller.current?.abort(); controller.current = null; }, []);
	const start = (next: 'writing' | 'repairing') => {
		controller.current?.abort();
		const request = new AbortController();
		controller.current = request;
		setPhase(next);
		return request;
	};
	// An aborted or unmounted request leaves the phase alone.
	const finish = (request: AbortController) => {
		if (controller.current !== request) return;
		controller.current = null;
		setPhase('idle');
	};
	return { phase, setPhase, start, finish };
}

/** A formula can be applied once it parses and its preview (when there are rows) has no blocking errors. */
function formulaReady(formula: string, hasRows: boolean, preview: Preview | null, blocking: boolean) {
	const trimmed = formula.trim();
	if (!trimmed.startsWith('=') || trimmed.length <= 1) return false;
	return !hasRows || Boolean(preview && !preview.error && !blocking);
}

function previewPlaceholder(hasRows: boolean, formula: string) {
	if (!hasRows) return 'Add rows to see a preview.';
	return formula.trim().length > 1 ? 'Calculating…' : 'Your formula result will appear here.';
}

export function FormulaBuilder({ originalColumns, columns, rows, columnId, rowId, initial = '=', initialAsk = '', initialName = 'Formula', embedded = false, onPreviewFailure, newColumn, onClose, onApply }: {
	originalColumns: Column[]; columns: Column[]; rows: Row[]; columnId: string; rowId?: string; initial?: string; newColumn: boolean;
	initialAsk?: string; initialName?: string; embedded?: boolean; onPreviewFailure?: () => void;
	onClose: () => void; onApply: (formula: string, name: string) => Promise<void>;
}) {
	const [ask, setAsk] = useState(initialAsk);
	const [formula, setFormula] = useState(initial);
	const [name, setName] = useState(initialName);
	const [explanation, setExplanation] = useState('');
	const [error, setError] = useState('');
	const { phase, setPhase, start, finish } = useFormulaRequest();
	const repair = useRef<Repair>('available');
	const repairCandidate = useRef(initial);
	const inputColumns = columns.filter((column) => column.id !== columnId);
	const targetRow = rowId ? rows.findIndex((row) => row.id === rowId) : 0;
	const columnLetter = columnAddress(columns.findIndex((column) => column.id === columnId));
	const address = `${columnLetter}${targetRow + 1}`;
	const busy = phase === 'writing' || phase === 'repairing';
	const columnAddresses = () => columns.map((column, index) => ({ name: column.name, address: columnAddress(index) }));
	const fallBack = () => {
		if (repair.current === 'fell-back') return;
		repair.current = 'fell-back';
		onPreviewFailure?.();
	};

	async function repairFormula(failed: Preview) {
		const request = start('repairing');
		const samples = failed.results.map((result, index) => ({ result, row: newColumn ? rows[index] : rows[targetRow] })).filter(({ result }) => result.error).slice(0, 3).map(({ result, row }) => ({
			address: result.address, error: result.value.slice(0, 2000),
			inputs: Object.fromEntries(inputColumns.slice(0, 50).map((column) => [column.name, formatValue(row?.cells[column.id]?.v).slice(0, 500)])),
		}));
		try {
			const result = await buildFormula({ ask, formula: failed.formula, target: address, columns: columnAddresses(), feedback: { error: failed.error?.slice(0, 2000), samples } }, request.signal);
			if (request.signal.aborted) return;
			if (result.formula === failed.formula) { fallBack(); return; }
			repairCandidate.current = result.formula;
			setFormula(result.formula);
			setExplanation(result.explanation);
		} catch {
			if (!request.signal.aborted) fallBack();
		} finally {
			finish(request);
		}
	}

	// Composed formulas that fail their preview get one repair, then the caller picks another operation.
	const preview = useFormulaPreview({ formula, originalColumns, columns, rows, columnId, columnLetter, targetRow, newColumn }, (next) => {
		if (!onPreviewFailure || phase === 'repairing' || repair.current === 'fell-back' || next.formula !== repairCandidate.current) return;
		if (!next.error && !next.results.some((result) => result.error)) return;
		if (repair.current === 'used') { fallBack(); return; }
		repair.current = 'used';
		void repairFormula(next);
	});

	async function write() {
		const request = start('writing');
		setError('');
		try {
			const result = await buildFormula({ ask, formula, target: address, columns: columnAddresses() }, request.signal);
			if (!request.signal.aborted) { setFormula(result.formula); setExplanation(result.explanation); }
		} catch (reason) {
			if (!request.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not write a formula');
		} finally {
			finish(request);
		}
	}

	async function save() {
		setPhase('saving');
		setError('');
		try {
			await onApply(resolveColumnFormula(formula.trim(), columns, targetRow), name.trim());
			onClose();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : 'Could not apply formula');
		} finally {
			setPhase((current) => current === 'saving' ? 'idle' : current);
		}
	}

	const current = preview?.formula === formula ? preview : null;
	const problems = previewErrors(current?.results ?? []);
	const ready = formulaReady(formula, rows.length > 0, current, problems.blocking);
	const footer = <>
		<Button onClick={onClose}>Cancel</Button>
		<Button variant="brand" disabled={!ready || busy || (newColumn && !name.trim())} loading={phase === 'saving'} onClick={() => void save()}>{newColumn ? 'Add formula column' : 'Apply formula'}</Button>
	</>;
	const content = <>
		<div className="grid items-start gap-6 md:grid-cols-2">
			<FormulaInputs newColumn={newColumn} name={name} onName={setName} ask={ask} onAsk={setAsk} columns={columns} inputColumns={inputColumns} phase={phase} onWrite={() => void write()} formula={formula} onFormula={(value) => { setFormula(value); setExplanation(''); }} onCommit={setFormula} />
			<FormulaPreview preview={current} problems={problems.message} explanation={explanation} label={newColumn ? `First ${Math.min(rows.length, 10)} rows` : address} table={newColumn} empty={previewPlaceholder(rows.length > 0, formula)} />
		</div>
		{error && <p role="alert" className="mt-4 text-body-sm text-danger">{error}</p>}
	</>;
	return embedded ? <div className="space-y-4">{content}<div className="flex justify-end gap-2">{footer}</div></div> : <Dialog title={<span className="flex items-center gap-2"><FunctionSquare className="size-5 text-fg-subtle" /> Formula</span>} description={newColumn ? 'Describe the result and let AI write the formula, or write it yourself.' : `Formula for ${address}.`} onClose={onClose} size="xl" footer={footer}>{content}</Dialog>;
}

const WRITE_LABELS: Record<Phase, string> = { idle: 'Write with AI', saving: 'Write with AI', writing: 'Writing formula…', repairing: 'Fixing formula…' };

/** Name (for a new column), the plain-English ask with column chips, and the formula itself. */
function FormulaInputs({ newColumn, name, onName, ask, onAsk, columns, inputColumns, phase, onWrite, formula, onFormula, onCommit }: { newColumn: boolean; name: string; onName: (name: string) => void; ask: string; onAsk: (ask: string) => void; columns: Column[]; inputColumns: Column[]; phase: Phase; onWrite: () => void; formula: string; onFormula: (formula: string) => void; onCommit: (formula: string) => void }) {
	const insertColumn = useRef<((name: string) => void) | null>(null);
	const busy = phase === 'writing' || phase === 'repairing';
	return <div className="flex min-w-0 flex-col gap-5">
		{newColumn && <Field label="Column name">{(id) => <Input id={id} value={name} onChange={(event) => onName(event.target.value)} />}</Field>}
		<div className="flex flex-col gap-3">
			<Field label="Describe the formula you want">{(id) => <div className="formula-builder-prompt rounded-lg border border-line">
				<ColumnPrompt id={id} value={ask} onChange={onAsk} columns={inputColumns} rows={3} disabled={busy} insertRef={insertColumn} placeholder="e.g. Get the first word from the Company name column" />
				<div className="flex flex-wrap gap-1.5 border-t border-line-subtle p-2">{inputColumns.map((column) => <button key={column.id} type="button" disabled={busy} className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-caption text-fg-muted hover:bg-neutral-5 disabled:opacity-50" onPointerDown={(event) => event.preventDefault()} onClick={() => insertColumn.current?.(column.name)}><span className="text-fg-subtle">{columnAddress(columns.indexOf(column))}</span>{column.name}</button>)}</div>
			</div>}</Field>
			<Button className="self-start" size="sm" loading={busy} disabled={!ask.trim() || phase === 'saving'} onClick={onWrite}><Sparkles />{WRITE_LABELS[phase]}</Button>
		</div>
		<Field label="Or write your own formula" help="Use cell references like A1, or type a column name and choose its suggestion. Column names use the value from the current row. Formulas calculate locally.">{(id) => <FormulaEditor id={id} value={formula} columns={inputColumns} disabled={busy} wrap onChange={onFormula} onCommit={onCommit} onCancel={() => {}} label="Formula to apply" className="formula-builder-input rounded-lg border border-line bg-surface px-3.5" />}</Field>
	</div>;
}

function FormulaPreview({ preview, problems, explanation, label, table, empty }: { preview: Preview | null; problems: string | null; explanation: string; label: string; table: boolean; empty: string }) {
	const single = preview?.results[0];
	return <section aria-label="Result preview" className="min-w-0 overflow-hidden rounded-xl border border-line-subtle bg-surface">
		<div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line-subtle bg-neutral-5 px-4 py-3"><h3 className="text-body-sm font-medium">Result preview</h3><span className="text-caption text-fg-subtle">{label}</span></div>
		{!preview ? <p className="p-4 text-body-sm text-fg-subtle">{empty}</p> : <>
			{preview.error ? <p role="status" className="break-words p-4 text-body-sm text-danger">{preview.error}</p> : table ? <table aria-label="Formula preview" className="w-full table-fixed text-left text-body-sm">
				<thead className="text-caption text-fg-muted"><tr><th scope="col" className="w-16 border-b border-line-subtle px-4 py-2 font-medium">Cell</th><th scope="col" className="border-b border-line-subtle px-4 py-2 font-medium">Result</th></tr></thead>
				<tbody>{preview.results.map((result) => <tr key={result.address} className="border-b border-line-subtle last:border-0"><th scope="row" className="px-4 py-2 align-top text-caption font-normal text-fg-subtle">{result.address}</th><td className={`break-words px-4 py-2 ${result.error ? 'text-danger' : 'text-fg'}`}>{result.value || '(empty)'}</td></tr>)}</tbody>
			</table> : <p role="status" className={`break-words p-4 ${single?.error ? 'text-body-sm text-danger' : 'text-lg text-fg'}`}>{single?.value || '(empty)'}</p>}
			{problems && <p data-preview-warning className="flex items-start gap-2 border-t border-warning-line bg-warning-soft px-4 py-2.5 text-caption text-warning-strong"><TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" strokeWidth={1.75} />{problems}</p>}
			{explanation && <p className="border-t border-line-subtle px-4 py-3 text-body-sm text-fg-muted">{explanation}</p>}
		</>}
	</section>;
}
