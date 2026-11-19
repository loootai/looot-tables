'use client';

import { cellEditToken } from '@/lib/cell-content';
import { cellInput } from '@/lib/formula-input';
import type { Cell } from '@/lib/types';
import { useRef, useState } from 'react';
import { FormulaEditor } from './formula-editor';
import { ConfirmDialog } from '@/components/ui/dialog';

export function FormulaBar({ address, cell, disabled, onSave, onEnter, height, onHeightChange }: { address: string; cell?: Cell; disabled: boolean; onSave: (input: string) => void; onEnter?: () => void; height: number; onHeightChange: (height: number) => void }) {
	const isNull = !cell?.f && cell?.s === 'done' && cell.v === null;
	const initial = isNull ? 'null' : cellInput(cell);
	const [draft, setDraft] = useState(initial);
	const [editing, setEditing] = useState(false);
	const [conflict, setConflict] = useState<string | null>(null);
	const version = useRef<string | undefined>(undefined);
	const finished = useRef(false);
	const commit = (value: string, key?: 'Enter' | 'Tab') => {
		if (finished.current) return;
		finished.current = true;
		if (value !== initial) {
			if (version.current !== cellEditToken(cell)) { setConflict(value); setEditing(false); return; }
			else onSave(value);
		}
		setEditing(false);
		if (key === 'Enter') onEnter?.();
	};
	const drag = useRef<{ pointerId: number; y: number; height: number; max: number } | null>(null);
	const resize = (value: number, max = 320) => onHeightChange(Math.max(36, Math.min(max, value)));
	return (
		<div style={{ height, maxHeight: '40vh', minHeight: 36 }} className="group/formula relative flex shrink-0 items-center border-y border-line bg-surface transition-colors focus-within:shadow-[inset_0_-2px_0_var(--color-brand)]" data-formula-bar>
			{conflict !== null && <ConfirmDialog title="This cell changed while you were editing" description={<span className="flex flex-col gap-2"><span>Cancel keeps the saved value. You can copy your draft below.</span><span>Current: <span className="select-all">{initial || '(empty)'}</span></span><span>Your edit: <span className="select-all whitespace-pre-wrap">{conflict || '(empty)'}</span></span></span>} confirmLabel="Keep my edit" onClose={() => setConflict(null)} onConfirm={() => { onSave(conflict); setConflict(null); }} />}
			<span className="flex h-full w-12 shrink-0 items-center justify-center border-r border-line-subtle bg-neutral-5 px-2 font-mono text-caption font-medium text-fg-muted group-focus-within/formula:text-brand" aria-label="Cell address" title={address}>
				<span className="truncate">{address || '—'}</span>
			</span>
			<span aria-hidden className="px-3 font-serif text-base italic text-fg-subtle group-focus-within/formula:text-brand">fx</span>
			<FormulaEditor
				multiline
				id="cell-formula"
				label="Cell value or formula"
				disabled={disabled}
				value={editing ? draft : initial}
				onFocus={() => { finished.current = false; version.current = cellEditToken(cell); setDraft(initial); setEditing(true); }}
				onChange={(value) => { if (!editing) version.current = cellEditToken(cell); finished.current = false; setDraft(value); setEditing(true); }}
				onCommit={commit}
				onBlur={commit}
				onCancel={() => { finished.current = true; setDraft(initial); setEditing(false); }}
				placeholder={!address ? 'Select a cell to view or edit its value' : disabled ? 'Waiting for this cell to finish…' : 'Enter a value or formula, e.g. =SUM(A1:A10)'}
				className={`formula-bar-editor flex-1 pr-3${height <= 36 ? ' formula-bar-collapsed' : ''}${isNull && (!editing || draft === initial) ? ' formula-null' : ''}`}
			/>
			<div
				role="separator"
				aria-label="Resize formula bar"
				aria-orientation="horizontal"
				aria-controls="cell-formula"
				aria-valuemin={36}
				aria-valuemax={320}
				aria-valuenow={height}
				tabIndex={0}
				title="Drag to resize formula bar. Double-click to collapse."
				className="absolute inset-x-0 -bottom-1 z-10 h-2 cursor-row-resize touch-none select-none hover:bg-brand/20 focus-visible:bg-brand/20 focus-visible:outline-none"
				onPointerDown={(event) => {
					if (event.button !== 0) return;
					event.preventDefault();
					event.stopPropagation();
					event.currentTarget.setPointerCapture(event.pointerId);
					drag.current = { pointerId: event.pointerId, y: event.clientY, height: event.currentTarget.parentElement!.getBoundingClientRect().height, max: Math.max(36, Math.min(320, window.innerHeight * 0.4)) };
				}}
				onPointerMove={(event) => {
					const start = drag.current;
					if (start?.pointerId === event.pointerId) resize(start.height + event.clientY - start.y, start.max);
				}}
				onPointerUp={(event) => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
				onPointerCancel={() => { drag.current = null; }}
				onLostPointerCapture={() => { drag.current = null; }}
				onDoubleClick={() => onHeightChange(36)}
				onKeyDown={(event) => {
					if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
					event.preventDefault();
					event.stopPropagation();
					const max = Math.max(36, Math.min(320, window.innerHeight * 0.4));
					resize(event.key === 'Home' ? 36 : event.key === 'End' ? max : height + (event.key === 'ArrowDown' ? 20 : -20), max);
				}}
			/>
		</div>
	);
}
