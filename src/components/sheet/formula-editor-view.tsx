'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { formulaReferenceTarget } from '@/lib/formula-reference';
import { loadCodeMirror } from './codemirror';
import { useFormulaRangeEditor, type FormulaRangeEditor } from './formula-range-context';
import { formulaAnalysisEffect, formulaAnalysisField, formulaPickingEffect, formulaPickingField, formulaExtensions } from './formula-editor-extensions';
import type { FormulaEditorProps } from './formula-editor';

const {
	autocomplete: { acceptCompletion, closeCompletion, completionKeymap, completionStatus },
	commands: { defaultKeymap, history, historyKeymap, isolateHistory },
	state: { Annotation, Compartment, EditorState, Prec, Transaction },
	view: { EditorView, keymap, placeholder: editorPlaceholder },
} = await loadCodeMirror();
type Compartment = import('@codemirror/state').Compartment;
type EditorView = import('@codemirror/view').EditorView;

const externalChange = Annotation.define<boolean>();

/** CodeMirror implementation of FormulaEditor; loaded on demand by formula-editor.tsx. Analysis lives in IronCalc's worker. */
export function FormulaEditorView(props: FormulaEditorProps) {
	const rangeEditor = useFormulaRangeEditor();
	const host = useRef<HTMLDivElement>(null);
	const editor = useRef<EditorView | null>(null);
	const initial = useRef(props);
	const callbacks = useRef(props);
	const editable = useRef<Compartment | null>(null);
	useEffect(() => { callbacks.current = props; });
	useLayoutEffect(() => {
		if (!host.current) return;
		const first = initial.current;
		const compartment = new Compartment();
		editable.current = compartment;
		let finished = false;
		let disposed = false;
		const view = new EditorView({
			parent: host.current,
			state: EditorState.create({
				doc: first.value,
				selection: first.autoFocus && first.selectInitial ? { anchor: 0, head: first.value.length } : { anchor: first.value.length },
				extensions: [
					compartment.of([EditorView.editable.of(!first.disabled), EditorState.readOnly.of(Boolean(first.disabled))]),
					EditorView.contentAttributes.of({ role: 'textbox', 'aria-label': first.label, 'aria-multiline': first.multiline ? 'true' : 'false', spellcheck: 'false', ...(first.id ? { id: first.id } : {}) }),
					...(first.multiline || first.wrap ? [EditorView.lineWrapping] : []),
					editorPlaceholder(first.placeholder ?? ''),
					history(), formulaExtensions(() => callbacks.current.columns ?? []),
					Prec.highest(keymap.of([
						{ key: 'Enter', run: (view) => {
							if (completionStatus(view.state) === 'active' && acceptCompletion(view)) return true;
							finished = true;
							callbacks.current.onCommit(view.state.doc.toString(), 'Enter');
							view.contentDOM.blur();
							return true;
						} },
						{ key: 'Tab', run: (view) => {
							if (completionStatus(view.state) === 'active' && acceptCompletion(view)) return true;
							finished = true;
							callbacks.current.onCommit(view.state.doc.toString(), 'Tab');
							view.contentDOM.blur();
							return true;
						} },
						{ key: 'Escape', run: (view) => {
							if (closeCompletion(view)) return true;
							if (view.state.field(formulaAnalysisField)?.call) { view.dispatch({ effects: formulaAnalysisEffect.of(null) }); return true; }
							finished = true;
							callbacks.current.onCancel();
							view.contentDOM.blur();
							return true;
						} },
					])),
					keymap.of([...completionKeymap, ...historyKeymap, ...defaultKeymap]),
					EditorView.updateListener.of((update) => {
						if (update.docChanged && !update.transactions.every((transaction) => transaction.annotation(externalChange))) callbacks.current.onChange?.(update.state.doc.toString());
					}),
					EditorView.domEventHandlers({
						focus: (_event, view) => { finished = false; rangeEditor.current = handle; view.dispatch({ effects: formulaPickingEffect.of(false) }); callbacks.current.onFocus?.(); },
						keydown: (_event, view) => { if (view.state.field(formulaPickingField)) view.dispatch({ effects: formulaPickingEffect.of(false) }); },
						blur: (_event, view) => { if (rangeEditor.current === handle) rangeEditor.current = null; if (!finished) { finished = true; callbacks.current.onBlur?.(view.state.doc.toString()); } },
					}),
				],
			}),
		});
		const handle: FormulaRangeEditor = {
			prepareReferencePick() {
				if (disposed || !view.hasFocus || view.state.field(formulaPickingField)) return;
				const selection = view.state.selection.main;
				if (formulaReferenceTarget(view.state.doc.toString(), selection.from, selection.to)) {
					closeCompletion(view);
					view.dispatch({ effects: formulaPickingEffect.of(true) });
				}
			},
			beginReferencePick() {
				if (disposed || !view.hasFocus || view.state.readOnly) return null;
				const original = view.state.doc.toString();
				const selection = view.state.selection.main;
				const target = formulaReferenceTarget(original, selection.from, selection.to);
				if (!target) return null;
				closeCompletion(view);
				view.dispatch({ effects: formulaPickingEffect.of(true) });
				let current = original, end = target.to, picked = '', done = false;
				const valid = () => !disposed && !done && view.state.doc.toString() === current;
				const restore = () => {
					view.dispatch({ changes: { from: target.from, to: end, insert: original.slice(target.from, target.to) }, selection: { anchor: selection.anchor, head: selection.head }, annotations: Transaction.addToHistory.of(false) });
				};
				return {
					update(reference) {
						if (!valid() || reference === picked) return;
						view.dispatch({ changes: { from: target.from, to: end, insert: reference }, selection: { anchor: target.from + reference.length }, annotations: Transaction.addToHistory.of(false) });
						picked = reference;
						end = target.from + reference.length;
						current = view.state.doc.toString();
					},
					finish() {
						if (valid()) {
							restore();
							if (picked) view.dispatch({ changes: { from: target.from, to: target.to, insert: picked }, selection: { anchor: target.from + picked.length }, annotations: isolateHistory.of('full'), userEvent: 'input.range' });
						}
						done = true;
						if (!disposed) { view.dispatch({ effects: formulaPickingEffect.of(false) }); view.focus(); }
					},
					cancel() {
						if (valid()) restore();
						done = true;
						if (!disposed) { view.dispatch({ effects: formulaPickingEffect.of(false) }); view.focus(); }
					},
				};
			},
		};
		editor.current = view;
		if (first.autoFocus) view.focus();
		// Disposing a focused editor during Strict Mode's lifecycle check is not a user commit.
		return () => { disposed = true; finished = true; if (rangeEditor.current === handle) rangeEditor.current = null; editor.current = null; editable.current = null; view.destroy(); };
	}, [rangeEditor]);
	useEffect(() => {
		const view = editor.current;
		if (view && view.state.doc.toString() !== props.value) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.value }, annotations: externalChange.of(true) });
	}, [props.value]);
	useEffect(() => {
		const compartment = editable.current;
		if (compartment) editor.current?.dispatch({ effects: compartment.reconfigure([EditorView.editable.of(!props.disabled), EditorState.readOnly.of(Boolean(props.disabled))]) });
	}, [props.disabled]);
	return <div ref={host} data-formula-editor className={`formula-editor min-w-0 ${props.className ?? ''}`} onKeyDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} />;
}
