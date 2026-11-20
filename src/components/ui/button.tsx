import clsx from 'clsx';
import type { ButtonHTMLAttributes, ComponentPropsWithRef } from 'react';
import { buttonClassName, type ButtonSize, type ButtonVariant } from './button-class';

type ButtonProps = ComponentPropsWithRef<'button'> & { variant?: ButtonVariant; size?: ButtonSize; loading?: boolean };

export function Button({ variant = 'outline', size = 'md', className, type = 'button', loading, children, disabled, ...props }: ButtonProps) {
	return (
		<button type={type} className={buttonClassName(variant, size, className)} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
			{loading && <span className={clsx('spinner', variant === 'brand' || variant === 'primary' || variant === 'danger' ? '!border-current !border-t-transparent' : '')} />}
			{children}
		</button>
	);
}

export function IconButton({ className, label, size = 'md', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: 'sm' | 'md' }) {
	return <button type="button" aria-label={label} title={label} className={clsx('grid shrink-0 place-items-center rounded-lg text-fg-subtle transition-colors hover:bg-tint/[0.05] hover:text-fg disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4 max-md:min-h-11 max-md:min-w-11', size === 'sm' ? 'size-7' : 'size-8', className)} {...props} />;
}
