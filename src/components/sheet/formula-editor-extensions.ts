import type { FormulaAnalysis } from '@/lib/formula-analysis';
import { activeArgument, argumentLabel, formulaFunction, formulaFunctionNames } from '@/lib/formula-catalog';
import type { Column } from '@/lib/types';
import { formulaColumnReferences } from '@/lib/formula-columns';
import { loadCodeMirror } from './codemirror';
import { ColumnPill } from './column-pill';
import { positionFormulaDocumentation } from '@/lib/formula-popup';
import { analyzeInWorker } from '@/lib/formula-worker-client';

const {
	autocomplete: { autocompletion },
	state: { StateEffect, StateField },
	view: { Decoration, EditorView, showTooltip, tooltips, ViewPlugin },
} = await loadCodeMirror();
type CompletionSource = import('@codemirror/autocomplete').CompletionSource;
type Extension = import('@codemirror/state').Extension;
type DecorationSet = import('@codemirror/view').DecorationSet;
type EditorView = import('@codemirror/view').EditorView;
type ViewUpdate = import('@codemirror/view').ViewUpdate;

export const formulaPickingEffect = StateEffect.define<boolean>();
export const formulaPickingField = StateField.define<boolean>({
	create: () => false,
	update(value, transaction) {
		for (const effect of transaction.effects) if (effect.is(formulaPickingEffect)) return effect.value;
		return value;
	},
});

export const formulaAnalysisEffect = StateEffect.define<FormulaAnalysis | null>();
export const formulaAnalysisField = StateField.define<FormulaAnalysis | null>({
	create: () => null,
	update(value, transaction) {
		for (const effect of transaction.effects) if (effect.is(formulaAnalysisEffect)) return effect.value;
		if (transaction.docChanged) return null;
		// Moving the caret invalidates argument help, but not syntax tokens.
		// Retain their decorations so font metrics and wrapping stay stable.
		return transaction.selection && value ? { ...value, call: null, completion: null } : value;
	},
	provide: (field) => [
		EditorView.decorations.from(field, (analysis): DecorationSet => Decoration.set((analysis?.tokens ?? []).map((token) => Decoration.mark({ class: token.kind === 'reference' ? `formula-token-reference formula-reference-${token.color ?? 0}` : `formula-token-${token.kind}` }).range(token.from, token.to)), true)),
		showTooltip.computeN([field, formulaPickingField], (state) => {
			if (state.field(formulaPickingField)) return [];
			const call = state.field(field)?.call;
			if (!call || !formulaFunction(call.name)) return [];
			return [{ pos: state.selection.main.head, above: false, create: () => ({ dom: functionHelp(call.name, call.argument) }) }];
		}),
	],
});

/** DOM is built with textContent so formula docs and user input are never interpreted as HTML. */
function functionHelp(name: string, argument?: number): HTMLElement {
	const info = formulaFunction(name)!;
	const card = document.createElement('div');
	card.className = 'formula-help';
	card.dataset.functionHelp = name;
	card.setAttribute('role', 'tooltip');
	card.addEventListener('pointerdown', (event) => { event.preventDefault(); event.stopPropagation(); });
	const signature = document.createElement('div');
	signature.className = 'formula-help-signature';
	const heading = document.createElement('strong');
	heading.textContent = name;
	signature.append(heading, '(');
	const selected = argument === undefined ? -1 : activeArgument(info, argument);
	info.args.forEach(([label], index) => {
		if (index) signature.append(', ');
		const span = document.createElement('span');
		span.textContent = argumentLabel(label);
		if (index === selected) { span.className = 'formula-help-active'; span.dataset.activeArgument = String(argument); }
		signature.append(span);
	});
	signature.append(')');
	card.append(signature);
	const description = document.createElement('p');
	description.textContent = info.description;
	card.append(description);
	if (selected >= 0) {
		const [label, type, detail] = info.args[selected];
		const line = document.createElement('p');
		line.className = 'formula-help-parameter';
		const title = document.createElement('strong');
		title.textContent = `${argumentLabel(label)} · ${type.replaceAll('_', ' ')}`;
		line.append(title, document.createElement('br'), detail);
		card.append(line);
	}
	if (info.examples[0]) {
		const example = document.createElement('div');
		example.className = 'formula-help-example';
		example.textContent = info.examples[0];
		card.append(example);
	}
	return card;
}

export const formulaCompletionSource: CompletionSource = async (context) => {
	if (context.state.field(formulaPickingField, false)) return null;
	const text = context.state.doc.toString();
	if (!text.startsWith('=')) return null;
	const analysis = await analyzeInWorker({ text, cursor: context.pos }).catch(() => null);
	if (context.aborted || !analysis) return null;
	let completion = analysis.completion;
	if (!completion && context.explicit && /(?:^=|[(,;+*/^&<>=-])\s*$/.test(text.slice(0, context.pos))) completion = { from: context.pos, prefix: '' };
	if (!completion) return null;
	const { from, prefix } = completion;
	const suffix = text.slice(context.pos).match(/^[A-Za-z0-9_.]*/)?.[0] ?? '';
	return {
		from, to: context.pos + suffix.length,
		options: formulaFunctionNames.filter((name) => name.startsWith(prefix)).map((name) => ({
			label: name, type: 'function', detail: formulaFunction(name)!.args.map(([label]) => argumentLabel(label)).join(', '),
			info: () => functionHelp(name),
			apply(view: EditorView, _completion: unknown, from: number, to: number) {
				const existing = view.state.doc.sliceString(to).match(/^\s*\(/)?.[0];
				const insert = existing ? name : `${name}()`;
				view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + name.length + (existing?.length ?? 1) }, userEvent: 'input.complete' });
			},
		})),
	};
};

const analysisPlugin = ViewPlugin.fromClass(class {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private version = 0;
	private destroyed = false;
	constructor(readonly view: EditorView) { this.schedule(); }
	update(update: ViewUpdate) {
		if (update.docChanged || update.selectionSet || update.focusChanged) this.schedule();
	}
	schedule() {
		clearTimeout(this.timer);
		const version = ++this.version;
		this.timer = setTimeout(async () => {
			const text = this.view.state.doc.toString(), cursor = this.view.state.selection.main.head;
			if (!text.startsWith('=')) return;
			try {
				const analysis = await analyzeInWorker({ text, cursor });
				if (this.destroyed || version !== this.version) return;
				if (!this.view.hasFocus) analysis.call = null;
				const selection = this.view.state.selection.main;
				this.view.dispatch({ effects: formulaAnalysisEffect.of(analysis) });
				// Highlight decorations replace text nodes. Restore the native selection
				// before selectionchange can feed that DOM reset back into editor state.
				if (this.view.hasFocus) {
					const anchor = this.view.domAtPos(selection.anchor);
					const head = this.view.domAtPos(selection.head);
					this.view.contentDOM.ownerDocument.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset);
				}
			} catch { /* Editing stays available if the worker cannot load; calculation reports its own error. */ }
		}, 35);
	}
	destroy() { this.destroyed = true; this.version++; clearTimeout(this.timer); }
});

export function formulaExtensions(columns: () => Column[] = () => []): Extension {
	const columnPills = StateField.define<DecorationSet>({
		create: (state) => decorateColumns(state.doc.toString()),
		update: (value, transaction) => transaction.docChanged ? decorateColumns(transaction.state.doc.toString()) : value,
		provide: (field) => [EditorView.decorations.from(field), EditorView.atomicRanges.of((view) => view.state.field(field))],
	});
	function decorateColumns(text: string) {
		return Decoration.set(formulaColumnReferences(text, columns()).map((ref) => Decoration.replace({ widget: new ColumnPill(ref.name) }).range(ref.from, ref.to)));
	}
	const columnCompletion: CompletionSource = (context) => {
		const text = context.state.doc.toString();
		if (!text.startsWith('=') || context.state.field(formulaPickingField, false)) return null;
		const before = text.slice(0, context.pos);
		if ((before.match(/"/g)?.length ?? 0) % 2) return null;
		const match = context.matchBefore(/\{\{[^{}]*|[\p{L}_][\p{L}\p{N}_.]*/u);
		if (!match && !context.explicit) return null;
		const from = match?.from ?? context.pos;
		const explicit = match?.text.startsWith('{{');
		return { from: explicit ? from + 2 : from, options: columns().map((column) => ({ label: column.name, type: 'variable', detail: 'Column · current row', section: { name: 'Columns', rank: 0 }, boost: 10,
			apply(view: EditorView, _completion: unknown, _from: number, to: number) {
				const end = text.slice(to).startsWith('}}') ? to + 2 : to;
				const insert = `{{${column.name}}}`;
				view.dispatch({ changes: { from, to: end, insert }, selection: { anchor: from + insert.length }, userEvent: 'input.complete' });
			},
		})) };
	};
	return [
		formulaPickingField, formulaAnalysisField, columnPills, analysisPlugin,
		tooltips({ parent: document.body, position: 'fixed' }),
		autocompletion({ override: [columnCompletion, formulaCompletionSource], defaultKeymap: false, icons: false, maxRenderedOptions: 12, interactionDelay: 0, tooltipClass: () => 'formula-completions',
			positionInfo: (_view, list, option, info, space) => {
				const position = positionFormulaDocumentation(list, option, info, space);
				return { style: `position: fixed; left: ${position.left}px; top: ${position.top}px; width: ${position.width}px; max-width: ${position.width}px; max-height: ${position.maxHeight}px; overflow: auto;` };
			} }),
	];
}
