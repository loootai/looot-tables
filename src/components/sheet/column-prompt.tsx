'use client';

import { lazy, Suspense, useState, type CSSProperties, type RefObject } from 'react';
import type { Column } from '@/lib/types';
import { loadCodeMirror } from './codemirror';
import './column-prompt.css';

export interface ColumnPromptProps { id: string; value: string; onChange: (value: string) => void; columns: Column[]; placeholder?: string; rows?: number; autoFocus?: boolean; onSubmit?: () => void; compose?: boolean; disabled?: boolean; insertRef?: RefObject<((name: string) => void) | null> }

const loadEditor = () => Promise.all([import('./column-prompt-editor'), loadCodeMirror()]).then(([module]) => module);
const ColumnPromptEditor = lazy(() => loadEditor().then((module) => ({ default: module.ColumnPromptEditor })));
// Fetch CodeMirror alongside the sheet instead of inside its first paint, so dialogs open with the real editor.
if (typeof window !== 'undefined') void loadEditor().catch(() => {});

/** A {{Column}} template editor with / references. CodeMirror loads in its own chunk. */
export function ColumnPrompt(props: ColumnPromptProps) {
	const [focused, setFocused] = useState(false);
	return <Suspense fallback={<PlainPrompt {...props} onFocusChange={setFocused} />}>
		<ColumnPromptEditor {...props} autoFocus={props.autoFocus || focused} />
	</Suspense>;
}

// Typing works while CodeMirror loads, but the stand-in stays out of the accessibility tree (and unlabelled), so
// assistive tech and tests only ever meet the real editor; it takes the text and focus when it mounts.
function PlainPrompt({ value, onChange, placeholder, rows = 2, autoFocus, onSubmit, compose, disabled, onFocusChange }: ColumnPromptProps & { onFocusChange: (focused: boolean) => void }) {
	return <div className={`column-prompt ${compose ? 'column-prompt-compose' : ''}`} style={{ '--prompt-lines': rows } as CSSProperties}>
		<div className="cm-editor">
			<textarea
				aria-hidden="true"
				tabIndex={-1}
				className="cm-content column-prompt-plain"
				rows={rows}
				value={value}
				disabled={disabled}
				autoFocus={autoFocus}
				placeholder={placeholder ?? 'Type / to insert a column, cell, or range'}
				onChange={(event) => onChange(event.target.value)}
				onFocus={() => onFocusChange(true)}
				onBlur={() => onFocusChange(false)}
				onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && onSubmit) { event.preventDefault(); onSubmit(); } }}
			/>
		</div>
	</div>;
}
