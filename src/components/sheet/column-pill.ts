import { loadCodeMirror } from './codemirror';

const { view: { WidgetType } } = await loadCodeMirror();

/** An atomic {{Column}} or {{A1}} reference shown as a pill in prompts and formulas. */
export class ColumnPill extends WidgetType {
	constructor(readonly name: string, readonly cellReference = false) { super(); }
	eq(other: ColumnPill) { return other.name === this.name && other.cellReference === this.cellReference; }
	toDOM() {
		const pill = document.createElement('span');
		pill.className = 'column-prompt-pill';
		pill.textContent = this.name;
		pill.title = this.cellReference ? `Uses ${this.name}; row numbers advance per row unless locked with $` : `Uses the ${this.name} value from each row`;
		pill.setAttribute('aria-label', `${this.cellReference ? 'Reference' : 'Column'}: ${this.name}`);
		return pill;
	}
}
