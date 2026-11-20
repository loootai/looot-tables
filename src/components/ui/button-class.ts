import clsx from 'clsx';

export type ButtonVariant = 'primary' | 'brand' | 'outline' | 'ghost' | 'danger' | 'link';
export type ButtonSize = 'xs' | 'sm' | 'md';

const VARIANT: Record<ButtonVariant, string> = {
	primary: 'bg-fg text-surface hover:bg-neutral-90',
	brand: 'bg-brand text-brand-fg shadow-[inset_0_1px_0_oklch(1_0_0/0.12),0_1px_2px_oklch(0.2_0.025_165/0.18)] hover:bg-brand-hover hover:shadow-[inset_0_1px_0_oklch(1_0_0/0.12),0_4px_12px_-4px_oklch(0.37_0.09_163/0.55)] hover:-translate-y-px motion-reduce:hover:translate-y-0',
	outline: 'border border-line-strong bg-surface text-fg hover:border-fg',
	ghost: 'text-fg-muted hover:bg-tint/[0.05] hover:text-fg',
	danger: 'bg-danger text-white hover:bg-danger-strong',
	link: 'text-brand hover:underline underline-offset-4 px-0 h-auto',
};
const SIZE: Record<ButtonSize, string> = {
	xs: 'h-7 px-2.5 text-caption gap-1.5 rounded-md',
	sm: 'h-8 px-3 text-body-sm gap-1.5',
	md: 'h-10 px-4 text-body-sm gap-2',
};

/** Button styling for links and plain form buttons that render without the Button component. */
export function buttonClassName(variant: ButtonVariant = 'outline', size: ButtonSize = 'md', className?: string) {
	return clsx(
		'inline-flex shrink-0 items-center justify-center rounded-lg whitespace-nowrap transition-[color,background-color,border-color,box-shadow,scale,translate,opacity] duration-150 active:scale-[0.98] motion-reduce:active:scale-100 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
		VARIANT[variant],
		variant === 'link' ? '' : [SIZE[size], 'max-md:min-h-11'],
		className
	);
}
