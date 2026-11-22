import clsx from 'clsx';
import { LOOOT_URL, MOLTSETS_URL } from '@/lib/constants';

/** "Powered by looot + MoltSets", each with its logo and a link to its site. */
export function PoweredBy({ className, size = 14 }: { className?: string; size?: number }) {
	const mark = (href: string, logo: string, name: string) => (
		<a href={href} target="_blank" rel="noopener" className="inline-flex min-h-6 items-center gap-1 font-medium text-fg-muted underline decoration-transparent underline-offset-4 transition-[color,text-decoration-color] hover:text-fg hover:decoration-line-strong">
			{/* eslint-disable-next-line @next/next/no-img-element -- a local logo of a few pixels */}
			<img src={logo} alt="" width={size} height={size} className="rounded-[3px]" />{name}
		</a>
	);
	return <span data-powered-by className={clsx('inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5', className)}>
		Powered by {mark(LOOOT_URL, '/providers/looot.svg', 'looot')} + {mark(MOLTSETS_URL, '/providers/moltsets.svg', 'MoltSets')}
	</span>;
}
