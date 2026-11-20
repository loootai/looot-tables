/* The landing hero: a settled looot tables sheet, drawn with the app's own tokens. The rows are sample data (invented
   companies on .example domains) and the page says so; the shapes (receipts, costs, fill) are what a real run shows. */

type Verdict = 'Valid' | 'Catch-all' | null;
interface SampleRow { name: string; company: string; domain: string; /** The address's local part; the domain is the row's. */ email: string | null; verdict: Verdict; phone: string | null; industry: string }

const ROWS: SampleRow[] = [
	{ name: 'Ada Rivera', company: 'Brightledger', domain: 'brightledger.example', email: 'ada.rivera', verdict: 'Catch-all', phone: '+1 212 555 0458', industry: 'Payments' },
	{ name: 'Grace Okafor', company: 'Paystream', domain: 'paystream.example', email: 'grace.okafor', verdict: 'Valid', phone: null, industry: 'Lending' },
	{ name: 'Linus Nakamura', company: 'Northwind Capital', domain: 'northwindcapital.example', email: 'linus.nakamura', verdict: 'Valid', phone: '+1 212 555 0366', industry: 'Banking software' },
	{ name: 'Margaret Schmidt', company: 'Ledgerly', domain: 'ledgerly.example', email: 'margaret.schmidt', verdict: 'Valid', phone: '+1 212 555 0549', industry: 'Accounting' },
	{ name: 'Dennis Haddad', company: 'Fintrail', domain: 'fintrail.example', email: null, verdict: null, phone: null, industry: 'Payroll' },
	{ name: 'Barbara Larsen', company: 'Quillpay', domain: 'quillpay.example', email: 'barbara.larsen', verdict: 'Valid', phone: '+1 212 555 0506', industry: 'Treasury' },
	{ name: 'Ken Moreau', company: 'Harborpoint', domain: 'harborpoint.example', email: 'ken.moreau', verdict: 'Valid', phone: '+1 212 555 0573', industry: 'Payments' },
];

const edge = (state: 'hit' | 'weak' | 'miss') => ({ hit: 'var(--color-brand)', weak: 'var(--color-warning)', miss: 'var(--color-line-strong)' })[state];

function Cell({ children, state, className = '', width }: { children?: React.ReactNode; state?: 'hit' | 'weak' | 'miss'; className?: string; width: string }) {
	return <div className={`relative flex h-[33px] min-w-0 shrink-0 items-center border-r border-b border-line-subtle px-3 text-[13px] ${className}`} style={{ width }}>
		{state && <span aria-hidden className="absolute top-1 bottom-1 left-0 w-[2px] rounded-[1px]" style={{ background: edge(state) }} />}
		{children}
	</div>;
}

const W = { idx: '40px', name: '150px', company: '150px', email: '270px', phone: '175px', industry: '140px' };

export function HeroSheet() {
	return (
		<figure aria-label="A looot tables sheet after a finished run (sample data)" className="relative mx-auto w-full max-w-[1000px]">
			<div className="overflow-hidden rounded-[14px] border border-line bg-surface text-left shadow-[var(--shadow-card)]">
				<div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
					<span aria-hidden className="grid size-6 place-items-center rounded-md bg-brand text-[11px] font-bold text-brand-fg">lt</span>
					<span className="text-[14px] font-medium text-fg">VP of Sales · Series B fintech, New York</span>
					<span className="num text-[11px] text-fg-subtle">12 rows</span>
					<span className="ml-auto hidden rounded-full bg-blue-10 px-2.5 py-0.5 text-[11.5px] text-brand sm:inline">Sample data</span>
				</div>
				<div className="overflow-x-auto">
					<div className="min-w-[935px]">
						<div className="flex bg-neutral-5 text-[12px] text-fg-muted">
							<Cell width={W.idx} />
							<Cell width={W.name}><span className="font-semibold text-fg">Name</span></Cell>
							<Cell width={W.company}>Company</Cell>
							<HeaderCell width={W.email} name="Work email" sub="$0.0068/hit · 0.6s · 83% fill" pill="Cheapest" fill={0.83} />
							<HeaderCell width={W.phone} name="Phone" sub="$0.048/hit · 75% fill" pill="Reliable" fill={0.75} />
							<HeaderCell width={W.industry} name="Industry" sub="unpacked · $0" fill={1} />
						</div>
						{ROWS.map((row, index) => (
							<div key={row.name} className="flex">
								<Cell width={W.idx} className="justify-center text-[11px] text-fg-subtle"><span className="num">{index + 1}</span></Cell>
								<Cell width={W.name} className="font-medium text-fg"><span className="truncate">{row.name}</span></Cell>
								<Cell width={W.company} className="text-fg-muted"><span className="truncate">{row.company}</span></Cell>
								<Cell width={W.email} state={row.email ? row.verdict === 'Valid' ? 'hit' : 'weak' : 'miss'} className={index === 0 ? 'shadow-[inset_0_0_0_1.5px_var(--color-brand)]' : ''}>
									{row.email ? <span className="flex min-w-0 items-center gap-1.5">
										<span className={`shrink-0 rounded-full px-1.5 text-[10.5px] font-medium leading-[18px] ${row.verdict === 'Valid' ? 'bg-success-soft text-success' : 'bg-warning-soft text-warning-strong'}`}>{row.verdict}</span>
										<span className="num truncate text-fg">{`${row.email}@${row.domain}`}</span>
									</span> : <span className="num text-[11.5px] text-fg-subtle">Not found · $0.0027</span>}
								</Cell>
								<Cell width={W.phone} state={row.phone ? 'hit' : 'miss'}>{row.phone ? <span className="num truncate text-fg">{row.phone}</span> : <span className="num whitespace-nowrap text-[11.5px] text-fg-subtle">Not found · $0.007</span>}</Cell>
								<Cell width={W.industry} className="text-fg-muted"><span className="truncate">{row.industry}</span></Cell>
							</div>
						))}
						<div className="flex items-center gap-3 bg-surface px-4 py-2 text-[12px] text-fg-muted">
							<span className="relative h-[3px] w-24 overflow-hidden rounded-full bg-neutral-10"><span className="absolute inset-y-0 left-0 w-[78%] bg-brand" /></span>
							<span>Spent <span className="num">$0.334</span> of <span className="num">$0.75</span> quoted · <span className="num">78%</span> found · 6 providers answered</span>
							<span className="ml-auto hidden rounded-md border border-line px-2 py-0.5 sm:inline">Cap <span className="num">$5.00</span></span>
						</div>
					</div>
				</div>
			</div>
			<figcaption className="pointer-events-none absolute top-[118px] right-[-8px] hidden w-[300px] rounded-[12px] border border-line bg-surface p-3 text-left shadow-[var(--shadow-floating)] lg:block xl:right-[-60px]">
				<p className="text-[11px] text-fg-subtle">Receipt · Ada Rivera · Work email</p>
				<div className="mt-2 flex flex-col gap-1.5 text-[12px] text-fg-muted">
					<ReceiptLine n={1} provider="prospeo" outcome="miss" cost="$0" ms="754 ms" />
					<ReceiptLine n={2} provider="hunter" outcome="hit" cost="$0.0049" ms="671 ms" />
					<ReceiptLine n={3} provider="bounceban" outcome="weak" cost="$0.0019" ms="436 ms" note="verify" />
				</div>
				<p className="mt-2 border-t border-line-subtle pt-2 text-[11px] text-fg-subtle">Cell total <span className="num text-fg">$0.0068</span> · capped at <span className="num">$0.069</span> · Report bad result</p>
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
		<span className="grid size-5 place-items-center rounded bg-blue-20 text-[9px] font-semibold uppercase text-brand">{provider.slice(0, 2)}</span>
		<span className="min-w-0 flex-1 truncate">{provider}{note ? <span className="text-fg-subtle"> · {note}</span> : null}</span>
		<span className={`rounded-full px-1.5 text-[10px] leading-[16px] ${tone}`}>{outcome}</span>
		<span className="num w-12 text-right text-[11px] text-fg">{cost}</span>
		<span className="num w-12 text-right text-[10.5px] text-fg-subtle">{ms}</span>
	</span>;
}
