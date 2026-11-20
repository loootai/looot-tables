import type { ReactNode } from 'react';
import { HelpTooltip } from '@/components/ui/help-tooltip';
import { NavigationButton } from './sidebar';

export function PageHeader({ title, description, help, actions }: { title: ReactNode; description?: ReactNode; help?: ReactNode; actions?: ReactNode }) {
	return (
		<div className="flex flex-wrap items-start justify-between gap-4">
			<div className="flex min-w-0 flex-col gap-1">
				<div className="flex min-w-0 items-center gap-1.5">
					<h1 className="min-w-0 break-words text-h4 text-fg">{title}</h1>
					{help && <HelpTooltip label={typeof title === 'string' ? `About ${title}` : 'More information'}>{help}</HelpTooltip>}
				</div>
				{description && <p className="break-words text-body-sm text-fg-muted">{description}</p>}
			</div>
			{actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
		</div>
	);
}

export function PageColumn({ children }: { children: ReactNode }) {
	return <div className="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-4 pt-[max(0.5rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-6 md:px-12 md:pt-10 md:pb-16"><div className="mx-auto flex w-full max-w-[880px] flex-col gap-7"><NavigationButton className="-mb-4 -ml-3" />{children}</div></div>;
}
