import { dependencyCells } from './enrichment-freshness';
import type { Column, Row } from './types';

/** Return cycle members, excluding downstream cells that merely depend on a cycle. */
export function cycleMembers(graph: Map<string, string[]>): Set<string> {
	const indices = new Map<string, number>(), low = new Map<string, number>();
	const active = new Set<string>(), stack: string[] = [], cycles = new Set<string>();
	function visit(key: string) {
		indices.set(key, indices.size); low.set(key, indices.get(key)!);
		active.add(key); stack.push(key);
		for (const dep of graph.get(key)!) {
			if (!graph.has(dep)) continue;
			if (!indices.has(dep)) {
				visit(dep);
				low.set(key, Math.min(low.get(key)!, low.get(dep)!));
			} else if (active.has(dep)) low.set(key, Math.min(low.get(key)!, indices.get(dep)!));
		}
		if (low.get(key) !== indices.get(key)) return;
		const component: string[] = [];
		let member: string;
		do { member = stack.pop()!; active.delete(member); component.push(member); } while (member !== key);
		if (component.length > 1 || graph.get(key)!.includes(key)) for (const member of component) cycles.add(member);
	}
	for (const key of graph.keys()) if (!indices.has(key)) visit(key);
	return cycles;
}

export function assertNoEnrichmentCycles(columns: Column[], rows: Row[]) {
	const ordered = rows.length ? [...rows].sort((a, b) => a.order - b.order) : [{ id: 'preview', sheetId: '', order: 0, cells: {}, createdAt: 0 }];
	const graph = new Map<string, string[]>();
	for (const [index, row] of ordered.entries()) for (const column of columns) {
		if (column.type !== 'enriched' || !column.op) continue;
		graph.set(`${row.id}:${column.id}`, dependencyCells(columns, ordered, index, column.op).map((dep) => `${dep.row.id}:${dep.column.id}`));
	}
	if (cycleMembers(graph).size) throw new Error('Circular enrichment dependency. Remove the references that depend on each other before saving.');
}
