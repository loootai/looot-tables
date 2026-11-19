/**
 * CodeMirror ships in its own chunks. The editor modules await this at their top level, and the lazy boundaries in
 * formula-editor.tsx and column-prompt.tsx start it alongside the editor chunk so the two download in parallel.
 */
export async function loadCodeMirror() {
	const [state, view, commands, autocomplete] = await Promise.all([import('@codemirror/state'), import('@codemirror/view'), import('@codemirror/commands'), import('@codemirror/autocomplete')]);
	return { state, view, commands, autocomplete };
}
