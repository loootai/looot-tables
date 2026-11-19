'use client';

import './formula-editor.css';

import { lazy, Suspense } from 'react';
import type { Column } from '@/lib/types';
import { loadCodeMirror } from './codemirror';

export interface FormulaEditorProps {
	value: string;
	onChange?: (value: string) => void;
	onCommit: (value: string, key?: 'Enter' | 'Tab') => void;
	onCancel: () => void;
	onFocus?: () => void;
	onBlur?: (value: string) => void;
	autoFocus?: boolean;
	selectInitial?: boolean;
	disabled?: boolean;
	label: string;
	id?: string;
	placeholder?: string;
	className?: string;
	multiline?: boolean;
	wrap?: boolean;
	columns?: Column[];
}

const loadEditor = () => Promise.all([import('./formula-editor-view'), loadCodeMirror()]).then(([module]) => module);
const FormulaEditorView = lazy(() => loadEditor().then((module) => ({ default: module.FormulaEditorView })));
// The formula bar needs the editor as soon as a sheet opens; start fetching it in parallel with the page.
if (typeof window !== 'undefined') void loadEditor().catch(() => {});

/** Shared formula editor. CodeMirror lives in its own chunk; a static rendering of the value holds its place. */
export function FormulaEditor(props: FormulaEditorProps) {
	return <Suspense fallback={<FormulaEditorPlaceholder {...props} />}><FormulaEditorView {...props} /></Suspense>;
}

function FormulaEditorPlaceholder({ value, placeholder, className }: FormulaEditorProps) {
	return <div data-formula-editor aria-busy="true" className={`formula-editor min-w-0 ${className ?? ''}`}>
		<div className="cm-editor"><div className="cm-scroller" style={{ display: 'flex', height: '100%' }}><div className="cm-content">
			{value ? <div className="cm-line">{value}</div> : <span className="cm-placeholder">{placeholder}</span>}
		</div></div></div>
	</div>;
}
