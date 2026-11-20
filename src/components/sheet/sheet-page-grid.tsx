'use client';

import { Button } from '@/components/ui/button';
import { cellRangeReference } from '@/lib/cell-range';
import { addEmptyRow, db, moveColumn, newColumn, updateColumn } from '@/lib/db';
import { cellFromInput, columnAddress } from '@/lib/formula-input';
import { collaborationStore } from '@/lib/realtime-client';
import { uniqueName } from '@/lib/references';
import type { SheetCommands, SheetRunStatus } from '@/lib/sheet-commands';
import type { Row, Sheet } from '@/lib/types';
import { Sparkles, Upload } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { CellPanel } from './cell-panel';
import { RunPausedContext } from './run-paused';
import { FormulaBar } from './formula-bar';
import { Grid } from './grid';
import { HEADER_HEIGHT, ROW_HEIGHT } from './grid-interactions';
import { ConnectionFix } from './halted-banner';
import type { SheetActions } from './use-sheet-actions';
import type { SheetRows } from './use-sheet-data';
import type { SheetOverlayState } from './use-sheet-overlays';
import type { SheetSelection } from './use-sheet-selection';
import type { SheetViewState } from './use-sheet-view';

/** The formula bar for the active cell or range. Enter saves and moves down a row, like a spreadsheet. */
export function SheetFormulaBar({ sheet, content, selection, commands, onSave }: { sheet: Sheet; content: SheetRows; selection: SheetSelection; commands: SheetCommands; onSave: (rowId: string, columnId: string, value: string) => void }) {
	const [height, setHeight] = useState(36);
	const { rows, rowNumbers } = content;
	const { active, activeColumn, activeCell } = selection;
	const onEnter = () => {
		if (!active) return;
		const index = rows.findIndex((row) => row.id === active.rowId);
		if (index < 0) return;
		selection.setActive({ rowId: rows[Math.min(rows.length - 1, index + 1)].id, columnId: active.columnId });
		selection.setCellRange(null);
		document.querySelector<HTMLElement>('[role="grid"][aria-label="Sheet grid"]')?.focus({ preventScroll: true });
	};
	const address = cellRangeReference(selection.cellRange, rows, sheet.columns.filter((column) => !column.hidden), rowNumbers, sheet.columns) || (active && activeColumn ? `${columnAddress(sheet.columns.indexOf(activeColumn))}${rowNumbers.get(active.rowId) ?? ''}` : '');
	return <FormulaBar onEnter={onEnter} height={height} onHeightChange={setHeight} key={active ? `${active.rowId}:${active.columnId}` : 'none'} address={address} cell={activeCell} disabled={!active || activeCell?.s === 'running' || activeCell?.s === 'queued' || commands.isPending(active.rowId, active.columnId)} onSave={(value) => { if (active) onSave(active.rowId, active.columnId, value); }} />;
}

type GridAreaProps = { sheetId: string; sheet: Sheet; allRows: Row[]; commands: SheetCommands; content: SheetRows; selection: SheetSelection; overlays: SheetOverlayState; actions: SheetActions; view: SheetViewState; halt?: SheetRunStatus['halt']; onFind: () => void; onLeave: () => void };

const blankRow = (row: Row) => Object.values(row.cells).every((cell) => !cell.f && (cell.v === null || cell.v === undefined || cell.v === ''));

/** The grid and the details panel for the open cell. A sheet with nothing typed yet also offers to fill it. */
export function SheetGridArea({ sheetId, sheet, allRows, commands, content, selection, overlays, actions, view, halt, onFind, onLeave }: GridAreaProps) {
	const collaboration = useSyncExternalStore(collaborationStore.subscribe, collaborationStore.getSnapshot, collaborationStore.getServerSnapshot);
	const { rows, populate } = content;
	const { providerReady, report, request } = actions;
	const blank = !content.findingRows && allRows.length <= 1 && allRows.every(blankRow);
	return (
		<div className="relative flex min-h-0 flex-1 overflow-hidden">
			<RunPausedContext value={Boolean(halt)}>
				<Grid
					allRows={allRows}
					collaborators={collaboration.sheetId === sheetId ? collaboration.peers : []}
					cellDetailsOpen={selection.panelOpen && Boolean(selection.activeRow && selection.activeColumn)}
					onRunCell={(row, column) => actions.runCells([row], [column], 'all', { optimistic: true })}
					loadingRows={content.findingRows}
					arrivalTimes={populate.revealAt}
					sheet={sheet}
					sort={view.sort}
					onFormulaBuilder={actions.openCellFormulaBuilder}
					rows={rows}
					rowNumbers={content.rowNumbers}
					selected={selection.selected}
					onToggleRow={selection.toggleRow}
					onToggleAll={selection.toggleAll}
					active={selection.active}
					range={selection.cellRange}
					onSelectRange={selection.setCellRange}
					onActivate={selection.activate}
					onOpenCell={selection.openCell}
					onEditCell={actions.editCell}
					onFillCells={(copies) => void commands.fill(copies, { ready: providerReady }).then((plan) => request(plan), report('Could not fill cells'))}
					onClearCells={(cells) => void commands.clearCells(cells).catch(report('Could not clear cells'))}
					renamingColumnId={overlays.renamingColumnId}
					onSortColumn={(columnId) => view.sortBy(columnId)}
					onCancelRenameColumn={() => overlays.setRenamingColumnId(null)}
					onRenameColumn={(columnId, value) => {
						const name = value.trim();
						if (name) void commands.editColumn(columnId, { name: uniqueName(name, sheet.columns.filter((column) => column.id !== columnId).map((column) => column.name)) }).catch(report('Could not rename column'));
						overlays.setRenamingColumnId(null);
					}}
					onColumnMenu={(column, anchor) => overlays.setColumnMenu({ column, anchor })}
					onRowMenu={(row, anchor) => overlays.setRowMenu({ row, anchor })}
					onCellMenu={(cell, anchor) => overlays.setCellMenu({ cell, anchor })}
					onAddEntityColumn={(source, fields) => void commands.addEntityColumns(source, fields, { ready: providerReady, visibleRows: rows }).then(({ extract, run }) => {
						request(run);
						if (extract) overlays.setEditor({ insertAt: extract.insertAt, initialOp: extract.op, initialName: 'Extracted data' });
					}, report('Could not add columns'))}
					onAddColumn={(anchor) => overlays.setAddColumnMenu(anchor)}
					onAddColumnValue={async (rowId, value) => {
						try {
							const current = await db.sheets.get(sheetId);
							if (!current) throw new Error('Sheet is no longer available.');
							const column = newColumn({ name: uniqueName('New column', current.columns.map((item) => item.name)), type: 'source' });
							await commands.addColumns([column], { kind: 'blank', initialCell: { rowId, columnId: column.id, cell: cellFromInput(value, column) } });
							selection.setActive({ rowId, columnId: column.id });
						} catch (error) {
							report('Could not add column')(error);
							throw error;
						}
					}}
					onMoveColumn={(columnId, toIndex) => void moveColumn(sheetId, columnId, toIndex).catch(report('Could not move column'))}
					onResizeColumn={(columnId, width) => void updateColumn(sheetId, columnId, { width }).catch(report('Could not resize column'))}
					onAddRow={() => void addEmptyRow(sheetId).catch(report('Could not add row.'))}
					onRoutingMenu={(column, anchor) => overlays.setRouting({ column, anchor })}
					onAddNextStep={(ghost) => void commands.addNextStep(ghost).then((column) => { if (column) actions.toast(`Added “${column.name}”. It runs when you click Run.`); }, report('Could not add this column'))}
				/>
			</RunPausedContext>
			{blank && <BlankSheetHint top={HEADER_HEIGHT + (allRows.length + 1) * ROW_HEIGHT + 40} onFind={onFind} onImport={() => overlays.setImportOpen(true)} />}
			<SheetCellPanel sheet={sheet} content={content} selection={selection} overlays={overlays} actions={actions} halt={halt} onLeave={onLeave} />
		</div>
	);
}

/** Details for the open cell. A cell that failed on a lost connection offers the fix in place. */
function SheetCellPanel({ sheet, content, selection, overlays, actions, halt, onLeave }: { sheet: Sheet; content: SheetRows; selection: SheetSelection; overlays: SheetOverlayState; actions: SheetActions; halt?: SheetRunStatus['halt']; onLeave: () => void }) {
	const { activeRow, activeColumn, activeCell } = selection;
	if (!selection.panelOpen || !activeRow || !activeColumn) return null;
	const credentialHalt = halt && (halt.reason === 'credential_missing' || halt.reason === 'credential_invalid') ? halt : undefined;
	return (
		<CellPanel
			sheet={sheet}
			row={activeRow}
			column={activeColumn}
			onSave={content.saveCell}
			onClose={() => selection.setPanelOpen(false)}
			onRerun={() => actions.runCells([activeRow], [activeColumn], 'all')}
			onEditColumn={() => overlays.setEditor({ column: activeColumn })}
			errorAction={credentialHalt && activeCell?.s === 'error' && activeCell.e === credentialHalt.message ? <ConnectionFix halt={credentialHalt} size="xs" onLeave={onLeave} /> : undefined}
		/>
	);
}

/** Below the first row of a blank sheet: type into it, or fill the sheet another way. Clicks elsewhere reach the grid. */
function BlankSheetHint({ top, onFind, onImport }: { top: number; onFind: () => void; onImport: () => void }) {
	return (
		<div className="pointer-events-none absolute inset-x-0 flex justify-center px-4" style={{ top }}>
			<div className="pointer-events-auto flex max-w-sm flex-col items-center gap-3 text-center">
				<p className="text-body-sm text-fg-muted">Type your own rows, or fill the sheet from the web.</p>
				<div className="flex flex-wrap justify-center gap-2">
					<Button size="sm" variant="brand" onClick={onFind}><Sparkles strokeWidth={1.75} /> Find rows</Button>
					<Button size="sm" onClick={onImport}><Upload strokeWidth={1.5} /> Import CSV</Button>
				</div>
			</div>
		</div>
	);
}
