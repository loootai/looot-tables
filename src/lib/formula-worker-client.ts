import type { FormulaAnalysis, FormulaAnalysisRequest } from './formula-analysis';
import type { FormulaRequest, FormulaResult } from './formulas';

let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<number, { resolve: (result: FormulaResult[] | FormulaAnalysis) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

function fail(error: Error) {
	worker?.terminate();
	worker = undefined;
	for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
	pending.clear();
}

function requestWorker(request: FormulaRequest | (FormulaAnalysisRequest & { kind: 'analyze' })): Promise<FormulaResult[] | FormulaAnalysis> {
	if (!worker) {
		worker = new Worker(new URL('./formulas.worker.ts', import.meta.url), { type: 'module' });
		worker.onmessage = (event: MessageEvent<{ id: number; results: FormulaResult[]; analysis?: FormulaAnalysis; error?: string }>) => {
			const entry = pending.get(event.data.id);
			if (!entry) return;
			clearTimeout(entry.timer);
			pending.delete(event.data.id);
			if (event.data.error) entry.reject(new Error(event.data.error));
			else entry.resolve(event.data.analysis ?? event.data.results);
		};
		worker.onerror = () => fail(new Error('The formula engine could not load. Reload the page to try again.'));
		worker.onmessageerror = () => fail(new Error('The formula engine returned an unreadable result.'));
	}
	const id = ++sequence;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => fail(new Error('Formula calculation took too long. Simplify the formula and try again.')), 30_000);
		pending.set(id, { resolve, reject, timer });
		worker!.postMessage({ ...request, id });
	});
}

export async function calculateInWorker(request: FormulaRequest): Promise<FormulaResult[]> {
	return await requestWorker(request) as FormulaResult[];
}
export async function analyzeInWorker(request: FormulaAnalysisRequest): Promise<FormulaAnalysis> {
	return await requestWorker({ ...request, kind: 'analyze' }) as FormulaAnalysis;
}
