import init, { Model } from '@ironcalc/wasm';
import { analyzeFormula, type FormulaAnalysisRequest } from './formula-analysis';
import { calculateFormulas, type FormulaRequest } from './formulas';

const ready = init();
let helper: Model | undefined;
self.onmessage = async (event: MessageEvent<(FormulaRequest | (FormulaAnalysisRequest & { kind: 'analyze' })) & { id: number }>) => {
	const { id, ...request } = event.data;
	try {
		await ready;
		if ('kind' in request && request.kind === 'analyze') {
			helper ??= new Model('Formula editor', 'en', 'UTC', 'en');
			self.postMessage({ id, analysis: analyzeFormula(helper, request) });
		} else {
			self.postMessage({ id, results: calculateFormulas(request as FormulaRequest) });
		}
	} catch (error) {
		self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
	}
};
