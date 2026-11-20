import { columnRole } from './column-roles';
import { isLegacyFingerprint } from './enrichment-freshness';
import { renameColumn, upgradeLegacyResults } from './enrichment-plan';
import { nameTaken } from './references';
import type { Column, Row, Sheet } from './types';
import { SHEET_DATA_VERSION } from './workspace';

/* A sheet saved by an older version is upgraded where it is next read: by the browser when it loads, and by MCP when an
   agent reads it, so both see the same columns. Each persists the upgrade with its own compare-and-set write. */

// The grid's header used to show these legacy names as their layout names; the columns now carry them.
const LEGACY_NAMES = new Map([['Domain', 'Website'], ['Company domain', 'Company website']]);
const legacyRenames = (columns: readonly Column[]) => columns.flatMap((column) => {
	const name = LEGACY_NAMES.get(column.name);
	return name && column.type === 'source' && columnRole(column) === 'website' && !nameTaken(name, columns, column.id) ? [{ columnId: column.id, name }] : [];
});

/** `grid` brought to `SHEET_DATA_VERSION`, or undefined when it is already there. Before version 1 a legacy-named
    website source column takes its layout name through the ordinary rename; before version 2 results current under a
    `v1:` fingerprint are restamped. The result is stamped even when nothing else changes, as sheets created since are,
    so a column someone names "Domain" later keeps that name. Rows must be in sheet order. */
export function upgradeGrid(grid: { sheet: Sheet; rows: Row[] }): { sheet: Sheet; rows: Row[] } | undefined {
	const version = grid.sheet.dataVersion ?? 0;
	if (version >= SHEET_DATA_VERSION) return undefined;
	const renames = version < 1 ? legacyRenames(grid.sheet.columns) : [];
	const legacy = grid.rows.some((row) => Object.values(row.cells).some((cell) => isLegacyFingerprint(cell.m?.inputFingerprint)));
	if (!renames.length && !legacy) return { sheet: { ...grid.sheet, dataVersion: SHEET_DATA_VERSION }, rows: grid.rows };
	const upgraded = renames.reduce((current, { columnId, name }) => renameColumn(current, columnId, name), legacy ? { sheet: grid.sheet, rows: upgradeLegacyResults(grid) } : grid);
	return { sheet: { ...upgraded.sheet, dataVersion: SHEET_DATA_VERSION }, rows: upgraded.rows };
}
