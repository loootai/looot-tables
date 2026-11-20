'use client';

import { useSettings } from '@/components/app/settings-context';
import { PROVIDER_INFO, REQUIRED_PROVIDERS } from '@/components/app/providers';
import { announce } from '@/components/ui/announcer';
import { useToast } from '@/components/ui/toast';
import { trackEvent } from '@/lib/analytics';
import type { CompanySuggestion } from '@/lib/company-search';
import { downloadBlob } from '@/lib/csv';
import { newColumn } from '@/lib/db';
import { applySort } from '@/lib/filters';
import { cellFromInput } from '@/lib/formula-input';
import { uniqueName } from '@/lib/references';
import { asksFirst, quoteAsksFirst, quoteLabel, type RunEstimate } from '@/lib/run-cost';
import { quotePlan } from '@/lib/run-quote';
import { formatUsd } from '@/lib/endpoint-map';
import type { RunMode, RunPlan, SheetCommands } from '@/lib/sheet-commands';
import { exportFile, type ExportFormat } from '@/lib/sheet-export';
import type { Column, Row, Sheet } from '@/lib/types';
import { useRouter } from 'next/navigation';
import type { ActiveCell } from './grid';
import { messageOf, plural } from './sheet-page-utils';
import type { SheetRows } from './use-sheet-data';
import type { SheetOverlayState } from './use-sheet-overlays';
import type { SheetSelection } from './use-sheet-selection';
import type { SheetViewState } from './use-sheet-view';

const NOTHING_TO_RUN = {
	pending: 'These cells are already queued or running.',
	complete: 'Nothing to run: every cell is complete and up to date.',
	outdated: 'Nothing unfinished to run. Outdated cells keep their values until you re-run them.',
	blocked: 'These cells can’t run until the columns they read are fixed.',
	none: 'There are no AI cells to run here.',
};

/** What the toolbar, grid and menus do to the sheet. Failures surface as toasts. */
export function useSheetActions({ sheet, commands, content, selection, overlays, view }: { sheet: Sheet; commands: SheetCommands; content: SheetRows; selection: SheetSelection; overlays: SheetOverlayState; view: SheetViewState }) {
	const router = useRouter();
	const { toast } = useToast();
	const { hasKeys, providerReady, openKeys } = useSettings();
	const { rows, rowById, saveCell } = content;
	const { setConfirm } = overlays;
	const columnNames = sheet.columns.map((column) => column.name);

	const report = (fallback: string) => (error: unknown) => toast(messageOf(error, fallback), 'error');
	const requireKeys = () => {
		if (!hasKeys) openKeys();
		return hasKeys;
	};
	/** Every bulk run goes through here: missing keys open Connections, and big or costly runs ask first unless they are
	    no bigger than an estimate the user already saw (`seen`). */
	const request = (plan: RunPlan | null, seen?: RunEstimate) => {
		if (!plan) return;
		if (plan.kind === 'needs-keys') {
			// Setup only asks for the two required keys; optional providers are connected in Configuration.
			if (plan.providers.every((provider) => (REQUIRED_PROVIDERS as readonly string[]).includes(provider))) { openKeys(); return; }
			const names = plan.providers.map((provider) => PROVIDER_INFO[provider].name).join(' and ');
			setConfirm({ title: `Connect ${names}`, description: `This column runs on ${names}. Add ${plan.providers.length === 1 ? 'its key' : 'their keys'} in Configuration → Connections, then run it again.`, label: 'Open Connections', action: async () => { router.push('/app/settings'); } });
			return;
		}
		if (plan.kind === 'nothing') { toast(NOTHING_TO_RUN[plan.reason], 'info'); return; }
		const { estimate } = plan;
		const run = () => void plan.execute().catch(report('Could not queue these cells. Please try again.'));
		const priced = plan.groups.some((group) => group.op.kind === 'looot');
		// A run no bigger than one the user already accepted starts at once.
		if (seen && !asksFirst(estimate, seen)) { run(); return; }
		// The price comes from the server's quote; without it, the catalog estimate asks first like before.
		void quotePlan(plan, sheet.id).then((quote) => {
			if (!quoteAsksFirst(quote) && !priced) { run(); return; }
			const cap = quote.sheet ? ` This sheet has spent ${formatUsd(quote.sheet.spentUsd)} of its ${formatUsd(quote.sheet.capUsd)} cap; the server stops any cell that would pass it.` : '';
			setConfirm({ title: `${quoteLabel(quote, 'cell')}?`, description: quote.maxUsd ? `At most ${formatUsd(quote.maxUsd)} from your own looot balance, usually about ${formatUsd(quote.typicalUsd)}. Each cell is capped at ${formatUsd(quote.perCellMaxUsd)}, and a miss on a fallback route costs only the attempts that ran.${cap}` : 'Each cell is a separate request to your AI and data providers.', label: quoteLabel(quote, 'cell'), action: plan.execute });
		}, () => {
			if (!asksFirst(estimate, seen)) { run(); return; }
			setConfirm({ title: `Run ${plural(estimate.cells, 'cell')}?`, description: estimate.usd ? `${estimate.message}. looot bills your own balance, and only for the runs that happen.` : 'Each cell is a separate request to your AI and data providers.', label: 'Run', action: plan.execute });
		});
	};
	const runCells = (targets: Row[], columns: Column[], mode: RunMode, options: { limitToRows?: boolean; optimistic?: boolean } = {}) => request(commands.plan(targets, columns, mode, { ready: providerReady, grid: content.grid, sheetColumns: sheet.columns, ...options }));
	const confirmDeleteRows = (targets: Row[]) => setConfirm({
		title: `Delete ${plural(targets.length, 'row')}?`,
		description: targets.length === 1 ? 'The row and its values are removed.' : 'The selected rows and their values are removed.',
		label: 'Delete',
		danger: true,
		action: async () => { await commands.deleteRows(targets.map((row) => row.id)); selection.setSelected(new Set()); },
	});
	const editCell = (rowId: string, columnId: string, value: string, company?: CompanySuggestion) => {
		const column = sheet.columns.find((entry) => entry.id === columnId);
		const previous = rowById.get(rowId)?.cells[columnId]?.m?.organization;
		const selectedCompany = company ?? (previous?.name === value ? previous : undefined);
		try { if (column) void saveCell(rowId, columnId, selectedCompany ? { v: selectedCompany.name, s: 'done', t: Date.now(), m: { organization: selectedCompany, reasoning: 'Selected company' } } : cellFromInput(value, column)).catch(report('Could not save cell')); }
		catch (error) { report('Could not save cell')(error); }
	};
	// Exports follow this viewer's view; the export menu states its scope.
	const exportSheet = (format: ExportFormat, options: { allRows: boolean; includeMeta: boolean }) => {
		const target = options.allRows ? applySort(content.displayRows ?? [], view.sort) : selection.selectedRows.length ? selection.selectedRows : rows;
		try {
			const { blob, filename } = exportFile(sheet, target, format, options.includeMeta);
			downloadBlob(blob, filename);
			trackEvent('sheet_exported', { format });
			announce(`Exported ${plural(target.length, 'row')}`);
		} catch (error) { report('Could not export this sheet')(error); }
	};
	const addBlankColumn = (insertAt?: number) => {
		const column = newColumn({ name: uniqueName('New column', columnNames), type: 'source' });
		void commands.addColumns([column], { kind: 'blank', position: insertAt }).then(() => overlays.setRenamingColumnId(column.id), report('Could not add column'));
	};
	const openCellFormulaBuilder = (cell: ActiveCell, draft = '') => {
		if (cell.columnId) overlays.setFormulaBuilder({ cell, draft });
		else {
			const column = newColumn({ name: uniqueName('New column', columnNames), type: 'source' });
			overlays.setFormulaBuilder({ column, cell: { rowId: cell.rowId, columnId: column.id }, draft });
		}
	};
	return { toast, providerReady, columnNames, report, requireKeys, request, runCells, confirmDeleteRows, editCell, exportSheet, addBlankColumn, openCellFormulaBuilder };
}

export type SheetActions = ReturnType<typeof useSheetActions>;
