'use client';

import { ArrowRight, ChevronDown, LoaderCircle, Sparkles, Wand2, X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { buildFormula, composeColumn } from '@/lib/api';
import { EMAIL_COLUMN_WIDTH, newColumn } from '@/lib/db';
import { columnAddress } from '@/lib/formula-input';
import type { RunEstimate } from '@/lib/run-cost';
import { formatValue } from '@/lib/template';
import { ColumnOpInputSchema, columnNameFromQuestion } from '@/lib/operations';
import { danglingReferences, nameTaken, uniqueName } from '@/lib/references';
import type { RunPlan, SheetCommands } from '@/lib/sheet-commands';
import type { Column, ColumnOp, Row, Sheet } from '@/lib/types';
import { useSettings } from '@/components/app/settings-context';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { ChoiceChips, Field, Input, Segmented } from '@/components/ui/field';
import { HelpTooltip } from '@/components/ui/help-tooltip';
import { InlineWarning } from '@/components/ui/inline-warning';
import { ColumnPrompt } from './column-prompt';
import { OpFields } from './column-op-fields';
import { defaultOp, type EditorKind, type EditorOp, guessDomainColumn, guessEntity, OPERATION_GROUPS, operationChoice, opSeed } from './column-operations';
import { FormulaBuilder } from './formula-builder';
import { RunScopeButton, type RunScope } from './run-scope-button';
import { plural } from './sheet-page-utils';
import './populate-dialog.css';
import './column-editor.css';

/**
 * Where the editor is. `ask`: only the prompt is shown. `composing`: AI is choosing an operation, from the
 * prompt screen or from setup. `setup`: an operation exists and its fields are editable.
 */
type Step = { step: 'ask' } | { step: 'composing'; from: 'ask' | 'setup' } | { step: 'setup'; rationale: string | null };
/** The footer's run flow: a big run states the estimate of its plan and asks once before starting. */
type Submit = { state: 'idle' } | { state: 'confirm'; scope: RunScope; estimate: RunEstimate } | { state: 'saving' };
/** A run to start once the column is saved, with the estimate the editor showed for it. */
interface SavedRun { scope: RunScope; seen?: RunEstimate }
/** Each composition replaces the op wholesale; `version` remounts fields so their local drafts start fresh. */
interface Composed { version: number; formula: string; formulaAsk: string; autoFormula: boolean }

const NAMED_BY_QUESTION = new Set<EditorKind>(['ai', 'answer', 'check', 'classify', 'score']);
const FIELD_HINTS: Record<string, string> = { prompt: 'Add a question', question: 'Add a question', task: 'Add a research task', query: 'Add a search query', template: 'Add a template', name: 'Add the person’s name', domain: 'Add a company domain', email: 'Add an email', options: 'Add at least 2 options', levels: 'Add at least 2 levels', providers: 'Choose at least one provider', page: 'Choose a page', fields: 'Add a field or instructions to extract' };

function ColumnPromptHelp() {
	return <HelpTooltip label="About AI columns">
		<span>Describe what you want to know about each row. looot tables picks the operation and fills every cell. For simple changes to existing data it writes a formula and checks it on up to 10 rows first.</span>
		<span>Type / to insert a column, a cell or a range (A1, $A$1, A1:B3). References move with each row; $ locks a coordinate.</span>
	</HelpTooltip>;
}

interface ComposerInput { sheet: Sheet; column?: Column; initialOp?: ColumnOp; initialName?: string; sampleRow?: Row; jevAvailable: boolean; columnOptions: Column[]; formulaColumns: Column[]; formulaColumn: Column; onReplace: () => void; setError: (error: string | null) => void }

/** The op and name being edited, and the AI composition that can replace them. Only the newest composition may apply. */
function useColumnComposer({ sheet, column, initialOp, initialName, sampleRow, jevAvailable, columnOptions, formulaColumns, formulaColumn, onReplace, setError }: ComposerInput) {
	const [step, setStep] = useState<Step>(column || initialOp ? { step: 'setup', rationale: null } : { step: 'ask' });
	const [ask, setAsk] = useState('');
	const [op, setOp] = useState<EditorOp>(column?.op ?? initialOp ?? defaultOp('ai', sheet.columns, jevAvailable));
	const [name, setName] = useState(column?.name ?? initialName ?? '');
	const nameEdited = useRef(Boolean(column || initialName));
	const [composed, setComposed] = useState<Composed>({ version: 0, formula: '=', formulaAsk: '', autoFormula: false });
	const composeSequence = useRef(0);
	useEffect(() => () => { composeSequence.current += 1; }, []);

	/** Until the user names the column, its question names it ("Who is the CEO of …?" → "CEO"); `fallback` uses the operation's name. */
	const rename = (next: EditorOp, fallback = false) => {
		if (nameEdited.current) return;
		const named = (NAMED_BY_QUESTION.has(next.kind) ? columnNameFromQuestion(opSeed(next)) : '') || (fallback ? operationChoice(next.kind).name : '');
		if (named) setName(uniqueName(named, columnOptions.map((entry) => entry.name)));
	};
	const replaceOp = (next: EditorOp) => { setOp(next); onReplace(); rename(next); };
	const editName = (next: string) => { setName(next); nameEdited.current = true; };

	async function compose(excludeFormula: boolean, requestAsk: string, from: 'ask' | 'setup') {
		if (!requestAsk) return;
		const sequence = ++composeSequence.current;
		const current = () => sequence === composeSequence.current;
		setStep({ step: 'composing', from });
		setError(null);
		try {
			const result = await requestComposition({ ask: requestAsk, excludeFormula, sheet, columns: columnOptions, sampleRow, jevAvailable, formulaColumns, formulaColumn });
			if (!current()) return;
			if (result === 'formula-failed') { await compose(true, requestAsk, from); return; }
			setComposed((previous) => ({ version: previous.version + 1, formula: result.formula ?? '=', formulaAsk: requestAsk, autoFormula: result.formula !== undefined }));
			replaceOp(result.op);
			setName(result.name);
			setStep({ step: 'setup', rationale: result.rationale });
		} catch (reason) {
			if (!current()) return;
			setError(reason instanceof Error ? reason.message : 'Could not create the column');
			setStep(from === 'ask' ? { step: 'ask' } : { step: 'setup', rationale: null });
		}
	}

	const switchKind = (kind: EditorKind) => {
		if (op.kind === kind) return;
		composeSequence.current += 1;
		setComposed((previous) => ({ ...previous, formula: '=', autoFormula: false }));
		const next = defaultOp(kind, sheet.columns, jevAvailable, opSeed(op) || ask.trim());
		setOp(next); onReplace(); rename(next, true);
		setStep({ step: 'setup', rationale: null });
	};
	const openSetup = () => {
		const next = op.kind === 'ai' && !op.prompt && ask.trim() ? { ...op, prompt: ask.trim() } : op;
		if (next !== op) { setOp(next); onReplace(); }
		rename(next, true);
		setStep({ step: 'setup', rationale: null });
	};
	/** Back to the prompt alone; the operation set up so far stays for Configure manually. */
	const describe = () => setStep({ step: 'ask' });
	return { step, ask, setAsk, op, replaceOp, name, editName, composed, compose, switchKind, openSetup, describe };
}

/** Whether the op parses, its {{references}} resolve, and the name is set and unique. */
function checkColumn(op: EditorOp, name: string, columns: Column[], others: Column[]) {
	const validation = ColumnOpInputSchema.safeParse(op);
	// References are written against the sheet as it is now, before a new column is inserted.
	const dangling = validation.success ? danglingReferences(validation.data, columns) : [];
	const duplicateName = nameTaken(name, others);
	return { validation, dangling, duplicateName, valid: validation.success && !dangling.length && name.trim().length > 0 && !duplicateName };
}

/** Only the prompt shows for a new column until AI picks an operation or the user opens setup. */
function isComposerOnly(column: Column | undefined, dedicatedEmail: boolean, step: Step) {
	if (column || dedicatedEmail) return false;
	return step.step === 'ask' || (step.step === 'composing' && step.from === 'ask');
}

function editorTitle(column: Column | undefined, dedicatedEmail: boolean) {
	if (column) return 'Edit AI column';
	return dedicatedEmail ? 'Find email' : 'Add AI column';
}

function editorSize(dedicatedEmail: boolean, kind: EditorKind) {
	if (dedicatedEmail) return 'sm';
	return kind === 'formula' ? 'xl' : 'lg';
}

/** What the editor writes through: adding a column, or editing one (which stops its work under the old operation). */
type ColumnWrites = Pick<SheetCommands, 'addColumns' | 'editColumn'>;

/** The column as it is saved: the edited column with its new name and operation, or a new AI column. */
function savedColumn(column: Column | undefined, name: string, op: ColumnOp): Column {
	if (column) return { ...column, name, op };
	return newColumn({ name, type: 'enriched', op, ...(op.kind === 'email-enrichment' ? { format: 'email' as const } : {}), width: op.kind === 'scrape' && op.mode === 'markdown' ? 320 : op.kind === 'email-enrichment' ? EMAIL_COLUMN_WIDTH : 220 });
}

/** Add or edit an AI column: describe it in plain English (AI picks the operation) or set it up by hand. */
export function ColumnEditorDialog({ sheet, column, sampleRow, rows, insertAt, initialOp, initialName, remainingRows = 1, totalRows = remainingRows, commands, planRun, onClose, onSaved }: { sheet: Sheet; column?: Column; sampleRow?: Row; rows: Row[]; insertAt?: number; initialOp?: ColumnOp; initialName?: string; onClose: () => void; remainingRows?: number; totalRows?: number; commands: ColumnWrites; planRun: (column: Column, scope: RunScope) => RunPlan; onSaved: (column: Column, run: SavedRun | null) => void }) {
	const { hasJev, settings } = useSettings();
	const jevAvailable = hasJev && settings.preferJev;
	const dedicatedEmail = initialOp?.kind === 'email-enrichment' || column?.op?.kind === 'email-enrichment';
	const columnOptions = useMemo(() => sheet.columns.filter((entry) => entry.id !== column?.id), [sheet.columns, column?.id]);
	const formulaColumn = useMemo(() => newColumn({ name: 'Formula', type: 'source' }), []);
	const formulaColumns = useMemo(() => [...sheet.columns.slice(0, insertAt ?? sheet.columns.length), formulaColumn, ...sheet.columns.slice(insertAt ?? sheet.columns.length)], [sheet.columns, insertAt, formulaColumn]);
	const [submit, setSubmit] = useState<Submit>({ state: 'idle' });
	const [error, setError] = useState<string | null>(null);
	const draft = useColumnComposer({ sheet, column, initialOp, initialName, sampleRow, jevAvailable, columnOptions, formulaColumns, formulaColumn, onReplace: () => setSubmit({ state: 'idle' }), setError });
	const { op, name } = draft;
	const composing = draft.step.step === 'composing';
	const composerOnly = isComposerOnly(column, dedicatedEmail, draft.step);
	const { validation, dangling, duplicateName, valid } = checkColumn(op, name, sheet.columns, columnOptions);

	async function save(run: SavedRun | null) {
		if (!validation.success || !valid) return;
		setSubmit({ state: 'saving' });
		setError(null);
		try {
			const parsedOp = validation.data;
			const saved = savedColumn(column, name.trim(), parsedOp);
			if (column) await commands.editColumn(column.id, { name: saved.name, op: parsedOp });
			else await commands.addColumns([saved], { kind: parsedOp.kind, position: insertAt });
			onSaved(saved, run);
			onClose();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : 'Could not save the column');
		} finally {
			setSubmit((current) => current.state === 'saving' ? { state: 'idle' } : current);
		}
	}
	/** Previews the run on the draft column, including the never-run AI columns it reads, before anything is saved. */
	const run = (scope: RunScope) => {
		if (!validation.success || !valid) return;
		const preview = planRun(savedColumn(column, name.trim(), validation.data), scope);
		const seen = preview.kind === 'run' ? preview.estimate : undefined;
		if (seen?.confirm) setSubmit({ state: 'confirm', scope, estimate: seen });
		else void save({ scope, seen });
	};
	const composeAsk = () => { if (!composing && submit.state !== 'saving') void draft.compose(false, draft.ask.trim(), 'ask'); };
	const saving = submit.state === 'saving';

	const { footer, footerNote } = composerOnly || op.kind === 'formula' ? {} : editorFooter({
		submit, valid, editing: Boolean(column), hint: setupHint(validation, dangling, name),
		run: <RunScopeButton tryFirst={!column} remainingRows={remainingRows} totalRows={totalRows} startRow={sampleRowNumber(rows, sampleRow)} disabled={!valid || saving} loading={saving} onRun={run} />,
		onBack: () => setSubmit({ state: 'idle' }), onSave: (next) => void save(next),
	});

	return (
		<Dialog
			unframed={composerOnly}
			title={editorTitle(column, dedicatedEmail)}
			description={column ? 'Change how this column fills, then save or re-run it.' : undefined}
			onClose={onClose}
			size={editorSize(dedicatedEmail, op.kind)}
			footer={footer}
			footerNote={footerNote}
		>
			<div className="flex flex-col gap-5">
				<InlineWarning message={error} />
				{composerOnly && <Composer ask={draft.ask} onAsk={draft.setAsk} columns={columnOptions} composing={composing} disabled={composing || saving} onCompose={composeAsk} onSetup={draft.openSetup} onClose={onClose} />}
				{!composerOnly && <>
					{!dedicatedEmail && <SetupHeader step={draft.step} ask={draft.ask} editing={Boolean(column)} busy={composing || saving} kind={op.kind} onKind={draft.switchKind} onDescribe={draft.describe} canTemplate={column?.op?.kind === 'template'} />}
					{op.kind === 'formula'
						? <FormulaStep key={draft.composed.version} sheet={sheet} columns={formulaColumns} rows={rows} formulaColumn={formulaColumn} taken={columnOptions} insertAt={insertAt} composing={composing} composed={draft.composed} request={op.request} name={name} commands={commands} onClose={onClose} onSaved={onSaved} onFallback={() => void draft.compose(true, draft.composed.formulaAsk, 'setup')} />
						: <OpSetup version={draft.composed.version} op={op} onChange={draft.replaceOp} columns={columnOptions} sheetColumns={sheet.columns} jevAvailable={jevAvailable} name={name} onName={draft.editName} duplicateName={duplicateName} />}
				</>}
			</div>
		</Dialog>
	);
}

/** The editable fields of a chosen operation, then the column name. A new kind or composition remounts the fields' local drafts. */
function OpSetup({ version, op, onChange, columns, sheetColumns, jevAvailable, name, onName, duplicateName }: { version: number; op: ColumnOp; onChange: (op: ColumnOp) => void; columns: Column[]; sheetColumns: Column[]; jevAvailable: boolean; name: string; onName: (name: string) => void; duplicateName: boolean }) {
	return <>
		<OpFields key={`${op.kind}:${version}`} op={op} onChange={onChange} columns={columns} domainColumn={guessDomainColumn(sheetColumns)} jevAvailable={jevAvailable} />
		<Field label="Column name" error={duplicateName ? 'Another column already has this name' : undefined}>
			{(id) => <Input id={id} value={name} onChange={(event) => onName(event.target.value)} placeholder="e.g. Free tier on pricing page?" />}
		</Field>
	</>;
}

/** The sample row's 1-based position, where a run started from it begins. */
function sampleRowNumber(rows: Row[], sampleRow: Row | undefined) {
	if (!sampleRow) return undefined;
	return rows.findIndex((row) => row.id === sampleRow.id) + 1 || undefined;
}

interface Composition { op: EditorOp; name: string; rationale: string | null; formula?: string }

/** Ask AI for an operation. A formula is written and returned with its draft; if writing fails, the caller retries without formulas. */
async function requestComposition({ ask, excludeFormula, sheet, columns, sampleRow, jevAvailable, formulaColumns, formulaColumn }: { ask: string; excludeFormula: boolean; sheet: Sheet; columns: Column[]; sampleRow?: Row; jevAvailable: boolean; formulaColumns: Column[]; formulaColumn: Column }): Promise<Composition | 'formula-failed'> {
	const result = await composeColumn({
		ask,
		entity: guessEntity(sheet),
		hasJev: jevAvailable,
		excludeFormula,
		columns: columns.map((entry) => ({ name: entry.name, type: entry.type, sample: sampleRow ? formatValue(sampleRow.cells[entry.id]?.v).slice(0, 80) || undefined : undefined })),
	});
	if (result.op.kind === 'formula' && !excludeFormula) {
		try {
			const built = await buildFormula({ ask: result.op.request, formula: '=', target: `${columnAddress(formulaColumns.indexOf(formulaColumn))}1`, columns: formulaColumns.map((entry, index) => ({ name: entry.name, address: columnAddress(index) })) });
			return { op: result.op, name: result.name, rationale: result.rationale ?? null, formula: built.formula };
		} catch {
			return 'formula-failed';
		}
	}
	const parsed = ColumnOpInputSchema.safeParse(result.op);
	if (!parsed.success) throw new Error('The suggested column was invalid; try rephrasing.');
	const op = !jevAvailable && 'decider' in parsed.data ? { ...parsed.data, decider: 'openai' as const } : parsed.data;
	return { op, name: result.name, rationale: excludeFormula ? `The formula could not be generated or failed its preview. ${result.rationale ?? 'Try this operation instead.'}` : result.rationale ?? null };
}

/** A composed or chosen formula: preview it on real rows, then save it as a formula column. */
function FormulaStep({ sheet, columns, rows, formulaColumn, taken, insertAt, composing, composed, request, name, commands, onClose, onSaved, onFallback }: { sheet: Sheet; columns: Column[]; rows: Row[]; formulaColumn: Column; taken: Column[]; insertAt?: number; composing: boolean; composed: Composed; request: string; name: string; commands: ColumnWrites; onClose: () => void; onSaved: (column: Column, run: SavedRun | null) => void; onFallback: () => void }) {
	const apply = async (formula: string, formulaName: string) => {
		if (composing) throw new Error('Wait for the operation to finish composing.');
		if (nameTaken(formulaName, taken)) throw new Error('Another column already has this name');
		const created = { ...formulaColumn, name: formulaName };
		await commands.addColumns([created], { kind: 'formula', position: insertAt, formula });
		onSaved(created, null);
	};
	return <>
		{composing && <p role="status" className="text-body-sm text-fg-muted">Choosing another operation…</p>}
		<FormulaBuilder embedded originalColumns={sheet.columns} columns={columns} rows={rows} columnId={formulaColumn.id} initial={composed.formula} initialAsk={request} initialName={name || 'Formula'} newColumn onClose={onClose} onPreviewFailure={composed.autoFormula ? onFallback : undefined} onApply={apply} />
	</>;
}

function setupHint(validation: ReturnType<typeof ColumnOpInputSchema.safeParse>, dangling: string[], name: string): string | null {
	if (!validation.success) {
		const issue = validation.error.issues[0];
		return FIELD_HINTS[String(issue?.path[0] ?? '')] ?? issue?.message ?? null;
	}
	if (dangling.length) return `No column matches {{${dangling[0]}}}`;
	return name.trim() ? null : 'Name the column';
}

/** Save and run, or (for a big run) its planned cost and one confirmation. The note says why buttons are disabled. */
function editorFooter({ submit, valid, editing, hint, run, onBack, onSave }: { submit: Submit; valid: boolean; editing: boolean; hint: string | null; run: ReactNode; onBack: () => void; onSave: (run: SavedRun | null) => void }): { footer: ReactNode; footerNote: ReactNode } {
	if (submit.state !== 'confirm') return {
		footer: <><Button size="sm" onClick={() => onSave(null)} disabled={!valid || submit.state === 'saving'}>{editing ? 'Save' : 'Add without running'}</Button>{run}</>,
		footerNote: hint,
	};
	const { scope, estimate } = submit;
	const cells = plural(estimate.cells, 'cell');
	return {
		footer: <><Button size="sm" onClick={onBack}>Back</Button><Button size="sm" variant="primary" className="bg-brand text-brand-fg" autoFocus onClick={() => onSave({ scope, seen: estimate })}>Run {cells}</Button></>,
		footerNote: <span role="status" className="flex flex-col gap-0.5"><span className="text-body-sm text-fg">Run {cells}?</span><span>{estimate.message}</span></span>,
	};
}

/** A new column starts here: describe it and AI sets it up, or configure it by hand. */
function Composer({ ask, onAsk, columns, composing, disabled, onCompose, onSetup, onClose }: { ask: string; onAsk: (ask: string) => void; columns: Column[]; composing: boolean; disabled: boolean; onCompose: () => void; onSetup: () => void; onClose: () => void }) {
	const promptId = useId();
	const empty = !ask.trim();
	return <div className="populate-composer column-composer">
		<div className="populate-front-wrap">
			<button type="button" aria-label="Close" onClick={onClose} className="populate-close"><X aria-hidden size={16} /></button>
			<div className="populate-front">
				<div className="populate-picker column-composer-heading"><Sparkles aria-hidden size={16} /><span>AI column</span></div>
				<div className="populate-entry">
					<label id={`${promptId}-label`} htmlFor={promptId} className="sr-only">Describe the column</label>
					<ColumnPrompt id={promptId} rows={2} autoFocus disabled={disabled} value={ask} onChange={onAsk} columns={columns} onSubmit={onCompose} placeholder="e.g. Research each company, write a proposal, or draft an email" />
				</div>
				<div className="populate-bottom">
					<div className="column-composer-hint"><span className="populate-summary">Type / to reference a column</span><ColumnPromptHelp /></div>
					<button type="button" aria-busy={composing} disabled={empty || disabled} onClick={onCompose} className="column-composer-create">Create column{composing ? <LoaderCircle aria-hidden size={16} className="animate-spin" /> : <ArrowRight aria-hidden size={16} />}</button>
				</div>
			</div>
		</div>
		<div className="column-composer-shelf"><button type="button" onClick={onSetup} disabled={composing} className="column-composer-options">Configure manually<ChevronDown aria-hidden size={14} /></button></div>
	</div>;
}

/** Above the fields: why AI chose this operation, the operation picker, and (for a new column) the way back to describing it. */
function SetupHeader({ step, ask, editing, busy, kind, onKind, onDescribe, canTemplate }: { step: Step; ask: string; editing: boolean; busy: boolean; kind: EditorKind; onKind: (kind: EditorKind) => void; onDescribe: () => void; canTemplate: boolean }) {
	const rationale = step.step === 'setup' ? step.rationale : null;
	const describe = !editing && <button type="button" disabled={busy} onClick={onDescribe} className="inline-flex items-center gap-1.5 rounded-md text-body-sm text-brand hover:underline disabled:opacity-50"><Sparkles aria-hidden className="size-3.5" strokeWidth={1.75} />{ask.trim() ? 'Edit description' : 'Describe it instead'}</button>;
	return <>
		{rationale && <p role="status" className="flex items-start gap-2 text-caption text-fg-muted"><Wand2 aria-hidden className="mt-px size-3.5 shrink-0" strokeWidth={1.75} />{rationale}</p>}
		<OperationPicker kind={kind} onChange={onKind} canFormula={!editing} canTemplate={canTemplate} action={describe} />
	</>;
}

function OperationPicker({ kind, onChange, canFormula, canTemplate, action }: { kind: EditorKind; onChange: (kind: EditorKind) => void; canFormula: boolean; canTemplate: boolean; action?: ReactNode }) {
	const groups = OPERATION_GROUPS
		.map((group) => ({ ...group, choices: group.choices.filter((choice) => (choice.kind !== 'formula' || canFormula) && (choice.kind !== 'template' || canTemplate)) }))
		.filter((group) => group.choices.length);
	const group = groups.find((entry) => entry.choices.some((choice) => choice.kind === kind)) ?? groups[0];
	const choice = group.choices.find((entry) => entry.kind === kind) ?? group.choices[0];
	return <div className="column-operation flex flex-col gap-2.5">
		<div className="flex items-center justify-between gap-3"><span aria-hidden className="text-body-sm text-fg">Operation</span>{action}</div>
		<ChoiceChips label="Operation" value={group.id} onChange={(id) => { const next = groups.find((entry) => entry.id === id)?.choices[0]; if (next) onChange(next.kind); }} options={groups.map((entry) => ({ value: entry.id, label: entry.label }))} />
		{group.choices.length > 1 && <Segmented size="sm" label={group.label} value={choice.kind} onChange={onChange} options={group.choices.map((entry) => ({ value: entry.kind, label: entry.label }))} />}
		<p className="text-caption text-fg-subtle">{choice.description}</p>
	</div>;
}
