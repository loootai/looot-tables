import { ProviderMark } from '@/components/sheet/provider-mark';

/* The landing hero: a settled looot tables sheet, drawn with the app's own tokens. The companies are real (their logos
   ship in public/demo), the people are fictional and every value is sample data; the page says so. The shapes (receipts,
   costs, fill) are what a real run shows. */

type Verdict = 'A' | 'B' | 'Valid' | 'Catch-all' | null;
interface SampleRow { name: string; photo: string; company: string; logo: string; domain: string; /** The address's local part; the domain is the row's. */ email: string | null; verdict: Verdict; answeredBy?: string; phone: string | null; phoneBy?: string; industry: string }

const ROWS: SampleRow[] = [
	{ name: 'Maya Rios', photo: 'maya-rios', company: 'Stripe', logo: 'stripe', domain: 'stripe.com', email: 'maya.rios', verdict: 'A', answeredBy: 'MoltSets', phone: '+1 212 555 0598', phoneBy: 'contactout', industry: 'Payments' },
	{ name: 'Marcus Bell', photo: 'marcus-bell', company: 'Linear', logo: 'linear', domain: 'linear.app', email: 'marcus.bell', verdict: 'B', answeredBy: 'MoltSets', phone: null, industry: 'Developer tools' },
	{ name: 'Yuki Tanaka', photo: 'yuki-tanaka', company: 'Vercel', logo: 'vercel', domain: 'vercel.com', email: 'yuki.tanaka', verdict: 'Valid', answeredBy: 'prospeo', phone: '+1 212 555 0748', phoneBy: 'contactout', industry: 'Developer tools' },
	{ name: 'Arjun Mehta', photo: 'arjun-mehta', company: 'Notion', logo: 'notion', domain: 'notion.so', email: null, verdict: null, phone: null, industry: 'Productivity' },
	{ name: 'Ingrid Larsen', photo: 'ingrid-larsen', company: 'Figma', logo: 'figma', domain: 'figma.com', email: 'ingrid.larsen', verdict: 'Catch-all', answeredBy: 'apollo', phone: '+1 212 555 0543', phoneBy: 'quickenrich', industry: 'Design software' },
	{ name: 'Owen Fletcher', photo: 'owen-fletcher', company: 'Datadog', logo: 'datadog', domain: 'datadoghq.com', email: 'owen.fletcher', verdict: 'Valid', answeredBy: 'hunter', phone: '+1 212 555 0454', phoneBy: 'quickenrich', industry: 'Observability' },
	{ name: 'Amara Okafor', photo: 'amara-okafor', company: 'Retool', logo: 'retool', domain: 'retool.com', email: 'amara.okafor', verdict: 'Valid', answeredBy: 'prospeo', phone: '+1 212 555 0711', phoneBy: 'contactout', industry: 'Developer tools' },
];

const RECEIPT_ROW = 5;
const VERDICT_TONE: Record<NonNullable<Verdict>, string> = { A: 'bg-success-soft text-success', B: 'bg-success-soft text-success', Valid: 'bg-success-soft text-success', 'Catch-all': 'bg-warning-soft text-warning-strong' };

const edge = (state: 'hit' | 'weak' | 'miss') => ({ hit: 'var(--color-brand)', weak: 'var(--color-warning)', miss: 'var(--color-line-strong)' })[state];

function Cell({ children, state, className = '', width }: { children?: React.ReactNode; state?: 'hit' | 'weak' | 'miss'; className?: string; width: string }) {
	return <div className={`relative flex h-[33px] min-w-0 shrink-0 items-center border-r border-b border-line-subtle px-3 text-[13px] ${className}`} style={{ width }}>
		{state && <span aria-hidden className="absolute top-1 bottom-1 left-0 w-[2px] rounded-[1px]" style={{ background: edge(state) }} />}
		{children}
	</div>;
}

const W = { idx: '40px', name: '150px', company: '150px', email: '270px', phone: '230px', industry: '140px' };

export function HeroSheet() {
	return (
		<figure aria-label="A looot tables sheet after a finished run (sample data)" className="relative mx-auto w-full max-w-[1000px]">
			<div className="overflow-hidden rounded-[14px] border border-line bg-surface text-left shadow-[var(--shadow-card)]">
				<div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
										<span className="text-[14px] font-medium text-fg">Revenue leaders · developer tools and SaaS</span>
					<span className="num text-[11px] text-fg-subtle">7 rows</span>
					<span className="ml-auto hidden rounded-full bg-blue-10 px-2.5 py-0.5 text-[11.5px] text-brand sm:inline">Sample data</span>
				</div>
				<div className="overflow-x-auto">
					<div className="min-w-[990px]">
						<div className="flex bg-neutral-5 text-[12px] text-fg-muted">
							<Cell width={W.idx} />
							<Cell width={W.name}><span className="font-semibold text-fg">Name</span></Cell>
							<Cell width={W.company}>Company</Cell>
							<HeaderCell width={W.email} name="Work email" sub="$0.0068/hit" pill="MoltSets first" fill={0.86} />
							<HeaderCell width={W.phone} name="Phone" sub="$0.048/hit" pill="Reliable" fill={0.71} />
							<HeaderCell width={W.industry} name="Industry" sub="from company data · $0" fill={1} />
						</div>
						{ROWS.map((row, index) => (
							<div key={row.name} className="flex">
								<Cell width={W.idx} className="justify-center text-[11px] text-fg-subtle"><span className="num">{index + 1}</span></Cell>
								<Cell width={W.name} className="gap-2 font-medium text-fg">{/* eslint-disable-next-line @next/next/no-img-element -- a local 18px sample avatar */}
<img src={`/demo/people/${row.photo}.jpg`} alt="" width={18} height={18} className="size-[18px] shrink-0 rounded-full object-cover" /><span className="truncate">{row.name}</span></Cell>
								<Cell width={W.company} className="gap-2 text-fg-muted"><span className="grid size-[18px] shrink-0 place-items-center rounded-[4px] bg-white">{/* eslint-disable-next-line @next/next/no-img-element -- a local 14px sample logo */}
<img src={`/demo/companies/${row.logo}.svg`} alt="" width={14} height={14} className="size-[14px]" /></span><span className="truncate">{row.company}</span></Cell>
								<Cell width={W.email} state={row.email ? row.verdict === 'Catch-all' ? 'weak' : 'hit' : 'miss'} className={index === RECEIPT_ROW ? 'shadow-[inset_0_0_0_1.5px_var(--color-brand)]' : ''}>
									{row.email ? <span className="flex min-w-0 items-center gap-1.5">
										{row.verdict && <span className={`shrink-0 rounded-full px-1.5 text-[10.5px] font-medium leading-[18px] ${VERDICT_TONE[row.verdict]}`}>{row.verdict}</span>}
										<span className="num min-w-0 flex-1 truncate text-fg">{`${row.email}@${row.domain}`}</span>
										{row.answeredBy && <ProviderMark name={row.answeredBy} size="xs" />}
									</span> : <span className="num text-[11.5px] text-fg-subtle">Not found · $0</span>}
								</Cell>
								<Cell width={W.phone} state={row.phone ? 'hit' : 'miss'}>{row.phone ? <span className="flex min-w-0 flex-1 items-center gap-1.5"><span className="num min-w-0 flex-1 truncate text-fg">{row.phone}</span>{row.phoneBy && <ProviderMark name={row.phoneBy} size="xs" />}</span> : <span className="num whitespace-nowrap text-[11.5px] text-fg-subtle">Not found · $0</span>}</Cell>
								<Cell width={W.industry} className="text-fg-muted"><span className="truncate">{row.industry}</span></Cell>
							</div>
						))}
						<div className="flex items-center gap-3 bg-surface px-4 py-2 text-[12px] text-fg-muted">
							<span className="relative h-[3px] w-24 overflow-hidden rounded-full bg-neutral-10"><span className="absolute inset-y-0 left-0 w-[78%] bg-brand" /></span>
							<span>Spent <span className="num">$0.162</span> of <span className="num">$0.49</span> quoted · <span className="num">79%</span> found · 6 providers answered</span>
							<span className="ml-auto hidden rounded-md border border-line px-2 py-0.5 sm:inline">Cap <span className="num">$5.00</span></span>
						</div>
					</div>
				</div>
			</div>
			<figcaption className="pointer-events-none absolute top-[118px] right-4 hidden w-[336px] rounded-[12px] border border-line bg-surface p-3 text-left shadow-[var(--shadow-floating)] lg:block">
				<p className="text-[11px] text-fg-subtle">Receipt · Owen Fletcher · Work email</p>
				<div className="mt-2 flex flex-col gap-1.5 text-[12px] text-fg-muted">
					<ReceiptLine n={1} provider="MoltSets" outcome="miss" cost="$0" ms="12 ms" note="plan" />
					<ReceiptLine n={2} provider="prospeo" outcome="miss" cost="$0" ms="754 ms" />
					<ReceiptLine n={3} provider="hunter" outcome="hit" cost="$0.0049" ms="671 ms" />
					<ReceiptLine n={4} provider="bounceban" outcome="hit" cost="$0.0019" ms="436 ms" note="verify" />
				</div>
				<p className="mt-2 border-t border-line-subtle pt-2 text-[11px] text-fg-subtle">Cell total <span className="num text-fg">$0.0068</span> · capped at <span className="num">$0.069</span></p>
			</figcaption>
		</figure>
	);
}

function HeaderCell({ width, name, sub, pill, fill }: { width: string; name: string; sub: string; pill?: string; fill: number }) {
	return <div className="relative flex h-10 shrink-0 items-center gap-1.5 border-r border-b border-line px-3" style={{ width }}>
		<span className="flex min-w-0 flex-1 flex-col">
			<span className="truncate text-[12.5px] font-medium text-fg">{name}</span>
			<span className="num truncate text-[10.5px] text-fg-subtle">{sub}</span>
		</span>
		{pill && <span className="shrink-0 rounded-full border border-line bg-surface px-1.5 text-[10.5px] font-medium text-fg-muted">{pill}</span>}
		<span aria-hidden className="absolute bottom-0 left-0 h-[2px] bg-brand" style={{ width: `${Math.round(fill * 100)}%` }} />
	</div>;
}

function ReceiptLine({ n, provider, outcome, cost, ms, note }: { n: number; provider: string; outcome: 'hit' | 'miss' | 'weak'; cost: string; ms: string; note?: string }) {
	const tone = outcome === 'hit' ? 'bg-success-soft text-success' : outcome === 'weak' ? 'bg-warning-soft text-warning-strong' : 'bg-neutral-5 text-fg-subtle';
	return <span className="flex items-center gap-2">
		<span className="num w-3 text-[10.5px] text-fg-subtle">{n}</span>
		<ProviderMark name={provider} size="sm" />
		<span className="min-w-0 flex-1 truncate">{provider}{note ? <span className="text-fg-subtle"> · {note}</span> : null}</span>
		<span className={`rounded-full px-1.5 text-[10px] leading-[16px] ${tone}`}>{outcome}</span>
		<span className="num w-12 text-right text-[11px] text-fg">{cost}</span>
		<span className="num w-12 text-right text-[10.5px] text-fg-subtle">{ms}</span>
	</span>;
}
