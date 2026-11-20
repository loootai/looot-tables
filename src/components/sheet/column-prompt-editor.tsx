'use client';

import { useEffect, useRef } from 'react';
import { findColumn, parsePromptReference, referenceTokens } from '@/lib/references';
import { loadCodeMirror } from './codemirror';
import { ColumnPill } from './column-pill';
import type { ColumnPromptProps } from './column-prompt';

const {
	autocomplete: { acceptCompletion, autocompletion, completionKeymap, closeCompletion },
	commands: { defaultKeymap, history, historyKeymap },
	state: { Compartment, EditorState, StateField },
	view: { Decoration, EditorView, keymap, placeholder: editorPlaceholder },
} = await loadCodeMirror();
type Compartment = import('@codemirror/state').Compartment;
type EditorState = import('@codemirror/state').EditorState;
type DecorationSet = import('@codemirror/view').DecorationSet;
type EditorView = import('@codemirror/view').EditorView;

/** CodeMirror implementation of ColumnPrompt; loaded on demand by column-prompt.tsx. */
export function ColumnPromptEditor(props: ColumnPromptProps) {
	const host = useRef<HTMLDivElement>(null);
	const editor = useRef<EditorView | null>(null);
	const latest = useRef(props);
	const editable = useRef<Compartment | null>(null);
	useEffect(() => { latest.current = props; });

	useEffect(() => {
		if (!host.current) return;
		const first = latest.current;
		const compartment = new Compartment();
		editable.current = compartment;
		const pills = StateField.define<DecorationSet>({
			create: (state) => decorate(state),
			update: (value, transaction) => transaction.docChanged ? decorate(transaction.state) : value,
			provide: (field) => [EditorView.decorations.from(field), EditorView.atomicRanges.of((view) => view.state.field(field))],
		});
		function decorate(state: EditorState) {
			const { columns } = latest.current;
			return Decoration.set(referenceTokens(state.doc.toString())
				.filter((token) => findColumn(columns, token.name) || parsePromptReference(token.name))
				.map((token) => Decoration.replace({ widget: new ColumnPill(token.name, !findColumn(columns, token.name)) }).range(token.from, token.to)));
		}
		const view = new EditorView({
			parent: host.current,
			state: EditorState.create({
				doc: first.value,
				selection: { anchor: first.value.length },
				extensions: [
					pills, history(), EditorView.lineWrapping, compartment.of([EditorView.editable.of(!first.disabled), EditorState.readOnly.of(Boolean(first.disabled))]),
					EditorView.contentAttributes.of({ id: first.id, role: 'textbox', 'aria-labelledby': `${first.id}-label`, 'aria-multiline': 'true' }),
					editorPlaceholder(first.placeholder ?? 'Type / to insert a column, cell, or range'),
					autocompletion({
						activateOnTypingDelay: 0, interactionDelay: 0, defaultKeymap: false,
						override: [(context) => {
							const match = context.matchBefore(/(?:^|\s)\/[^/\n{}]*/);
							if (!match) return null;
							const slash = match.from + match.text.indexOf('/');
							const query = match.text.slice(match.text.indexOf('/') + 1).trim();
							const reference = parsePromptReference(query);
							const absolute = query.toUpperCase().replace(/\$?([A-Z]+)\$?(\d+)/g, (_, column: string, row: string) => `$${column}$${row}`);
							const referenceOptions = reference ? [...new Set([query.toUpperCase(), absolute])]
								.filter((name) => !findColumn(latest.current.columns, name)) : [];
							const insertReference = (name: string) => (view: EditorView, _completion: unknown, from: number, to: number) => {
								const insert = `{{${name}}} `;
								view.dispatch({ changes: { from: from - 1, to, insert }, selection: { anchor: from - 1 + insert.length }, userEvent: 'input.complete' });
							};
							return {
								from: slash + 1,
								options: [...latest.current.columns.map((column) => ({
									label: column.name, detail: column.type === 'source' ? 'Source column' : 'AI column',
									section: { name: 'Columns', rank: 0 }, apply: insertReference(column.name),
								})), ...referenceOptions.map((name) => ({
									label: name, detail: `${name === absolute ? 'Absolute' : name.includes('$') ? 'Mixed' : 'Relative'} ${query.includes(':') ? 'range' : 'cell'}`,
									section: { name: 'Cells and ranges', rank: 1 },
									apply: insertReference(name),
								}))],
							};
						}],
					}),
					keymap.of([
						{ key: 'Escape', run: closeCompletion, stopPropagation: true },
						...completionKeymap.filter((binding) => binding.key !== 'Escape'),
						{ key: 'Tab', run: acceptCompletion },
						{ key: 'Enter', run: () => { if (!latest.current.onSubmit) return false; latest.current.onSubmit(); return true; } },
						...defaultKeymap, ...historyKeymap,
					]),
					EditorView.updateListener.of((update) => { if (update.docChanged) latest.current.onChange(update.state.doc.toString()); }),
				],
			}),
		});
		editor.current = view;
		if (first.insertRef) first.insertRef.current = (name) => {
			const selection = view.state.selection.main;
			const insert = `{{${name}}} `;
			view.dispatch({ changes: { from: selection.from, to: selection.to, insert }, selection: { anchor: selection.from + insert.length }, userEvent: 'input.complete' });
			view.focus();
		};
		// Run after the dialog's initial focus handling so it cannot steal the cursor.
		const focusFrame = first.autoFocus ? requestAnimationFrame(() => view.focus()) : undefined;
		return () => { if (focusFrame !== undefined) cancelAnimationFrame(focusFrame); if (first.insertRef) first.insertRef.current = null; editor.current = null; editable.current = null; view.destroy(); };
	}, []);

	useEffect(() => {
		const view = editor.current;
		if (view && props.value !== view.state.doc.toString()) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.value } });
	}, [props.value]);

	useEffect(() => {
		const compartment = editable.current;
		if (compartment) editor.current?.dispatch({ effects: compartment.reconfigure([EditorView.editable.of(!props.disabled), EditorState.readOnly.of(Boolean(props.disabled))]) });
	}, [props.disabled]);
	return <div ref={host} className={`column-prompt ${props.compose ? 'column-prompt-compose' : ''}`} style={{ '--prompt-lines': props.rows ?? 2 } as React.CSSProperties} />;
}
