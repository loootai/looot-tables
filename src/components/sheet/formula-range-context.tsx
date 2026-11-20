'use client';

import { createContext, useContext, useRef, type ReactNode, type RefObject } from 'react';

export interface FormulaRangePick {
	update(reference: string): void;
	finish(): void;
	cancel(): void;
}
export interface FormulaRangeEditor { beginReferencePick(): FormulaRangePick | null; prepareReferencePick(): void }
const FormulaRangeContext = createContext<RefObject<FormulaRangeEditor | null> | null>(null);

export function FormulaRangeProvider({ children }: { children: ReactNode }) {
	const editor = useRef<FormulaRangeEditor | null>(null);
	return <FormulaRangeContext.Provider value={editor}>{children}</FormulaRangeContext.Provider>;
}
export function useFormulaRangeEditor() {
	const editor = useContext(FormulaRangeContext);
	if (!editor) throw new Error('Formula range picking requires a sheet context.');
	return editor;
}
