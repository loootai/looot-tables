'use client';

import clsx from 'clsx';
import { AlertCircle } from 'lucide-react';
import { HelpTooltip } from './help-tooltip';
import { type AriaAttributes, createContext, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type TextareaHTMLAttributes, useContext, useEffect, useId, useMemo } from 'react';
import { announce } from './announcer';

import { INPUT_CLASS } from './input-styles';
export { INPUT_CLASS } from './input-styles';
export { Select } from './select';
export const TEXTAREA_CLASS = 'w-full resize-none rounded-lg border border-line bg-surface px-3.5 py-2.5 text-body-sm leading-[1.5] text-fg outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-fg-subtle hover:border-line-strong focus:border-brand focus:shadow-[0_0_0_3px_rgb(37_99_235/0.12)]';

type FieldAria = Pick<AriaAttributes, 'aria-invalid' | 'aria-describedby'>;

const FieldContext = createContext<{ id: string; errorId?: string } | null>(null);

/** Marks the control a <Field> labels as invalid, described by the error, only while the error is shown. */
export function useFieldAria<T extends FieldAria & { id?: string }>(props: T): T {
	const field = useContext(FieldContext);
	if (!field || props.id !== field.id) return props;
	return { ...props, 'aria-invalid': props['aria-invalid'] ?? Boolean(field.errorId), 'aria-describedby': [props['aria-describedby'], field.errorId].filter(Boolean).join(' ') || undefined };
}

export function Field({ label, labelAction, help, error, required, children, className }: { label: ReactNode; labelAction?: ReactNode; help?: ReactNode; error?: ReactNode; required?: boolean; children: (id: string, aria: FieldAria) => ReactNode; className?: string }) {
	const id = useId();
	const errorId = error ? `${id}-error` : undefined;
	const context = useMemo(() => ({ id, errorId }), [id, errorId]);
	const spokenLabel = typeof label === 'string' ? label : '';
	const spokenError = typeof error === 'string' ? error : '';
	// One page-level announcement per settled message; the delay lets the newly focused field be read first.
	useEffect(() => {
		if (spokenError) return announce(spokenLabel ? `${spokenLabel}: ${spokenError}` : spokenError, { delay: 500 });
	}, [spokenLabel, spokenError]);
	return (
		<div className={clsx('flex min-w-0 flex-col gap-1.5', className)}>
			<div className="flex flex-wrap items-center gap-1.5">
			<label id={`${id}-label`} htmlFor={id} className="text-body-sm text-fg">
				{label}
				{required && (
					<span aria-hidden className="ml-0.5 text-danger">
						*
					</span>
				)}
			</label>
			{help && <HelpTooltip label={typeof label === 'string' ? `About ${label}` : 'More information'}>{help}</HelpTooltip>}
			{labelAction}
			</div>
			<FieldContext value={context}>{children(id, { 'aria-invalid': Boolean(errorId), 'aria-describedby': errorId })}</FieldContext>
			{error && <p id={errorId} className="flex items-start gap-1 text-caption text-danger"><AlertCircle aria-hidden className="mt-px size-3.5 shrink-0" strokeWidth={1.75} /><span className="min-w-0">{error}</span></p>}
		</div>
	);
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
	return <input className={clsx(INPUT_CLASS, className)} {...useFieldAria(props)} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
	return <textarea className={clsx(TEXTAREA_CLASS, className)} {...useFieldAria(props)} />;
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
	return (
		<button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} className={clsx('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors', checked ? 'bg-brand' : 'bg-neutral-20')}>
			<span className={clsx('absolute size-4 rounded-full bg-white shadow-sm transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
		</button>
	);
}

function navigateChoices(event: KeyboardEvent<HTMLDivElement>) {
	if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
	const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not([disabled])')];
	const current = options.indexOf(event.target as HTMLButtonElement);
	if (current < 0 || options.length === 0) return;
	event.preventDefault();
	const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (current + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
	options[next].focus();
	options[next].click();
}

export function ChoiceChips<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string; hint?: string }>; onChange: (value: T) => void; label: string }) {
	return (
		<div role="radiogroup" aria-label={label} onKeyDown={navigateChoices} className="flex flex-wrap gap-1.5">
			{options.map((option) => {
				const selected = option.value === value;
				return (
					<button key={option.value} type="button" role="radio" aria-checked={selected} tabIndex={selected || !options.some((entry) => entry.value === value) && option === options[0] ? 0 : -1} title={option.hint} onClick={() => onChange(option.value)} className={clsx('h-9 shrink-0 rounded-lg border px-3.5 text-body-sm whitespace-nowrap transition-colors duration-150', selected ? 'border-brand bg-blue-10/60 text-brand' : 'border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg')}>
						{option.label}
					</button>
				);
			})}
		</div>
	);
}

export function Segmented<T extends string>({ value, options, onChange, label, size = 'md' }: { value: T; options: Array<{ value: T; label: ReactNode }>; onChange: (value: T) => void; label: string; size?: 'sm' | 'md' }) {
	return (
		<div role="radiogroup" aria-label={label} onKeyDown={navigateChoices} className="inline-flex max-w-full w-fit flex-wrap items-center gap-0.5 rounded-lg bg-neutral-5 p-0.5">
			{options.map((option) => {
				const selected = option.value === value;
				return (
					<button key={option.value} type="button" role="radio" aria-checked={selected} tabIndex={selected || !options.some((entry) => entry.value === value) && option === options[0] ? 0 : -1} onClick={() => onChange(option.value)} className={clsx('flex items-center gap-1.5 rounded-md whitespace-nowrap transition-colors', size === 'sm' ? 'h-7 px-2.5 text-caption' : 'h-8 px-3.5 text-body-sm', selected ? 'bg-surface text-fg shadow-[0_1px_3px_rgb(0_0_0/0.08),0_0_0_1px_rgb(0_0_0/0.03)]' : 'text-fg-muted hover:text-fg')}>
						{option.label}
					</button>
				);
			})}
		</div>
	);
}
