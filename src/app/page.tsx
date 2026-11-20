import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight, Bot, Braces, Download, FileText, Gauge, ListFilter, Mail, Search, Sparkles } from 'lucide-react';
import { GithubIcon, Logo } from '@/components/ui/logo';
import { DOCS_URL, GITHUB_URL, MOLTSETS_URL, SITE_DESCRIPTION, SITE_LEDE, SITE_TITLE } from '@/lib/constants';
import { siteUrl } from '@/lib/server/deployment';
import { HeroSheet } from '@/components/landing/hero-sheet';
import { PoweredBy } from '@/components/ui/powered-by';

export const metadata: Metadata = {
	title: { absolute: SITE_TITLE },
	description: SITE_DESCRIPTION,
	alternates: { canonical: '/' },
	// Page-level openGraph/twitter replace the layout's objects, so repeat the shared fields.
	openGraph: { type: 'website', siteName: 'looot tables', locale: 'en_US', title: SITE_TITLE, description: SITE_DESCRIPTION, url: '/' },
	twitter: { card: 'summary_large_image', title: SITE_TITLE, description: SITE_DESCRIPTION },
};

const LOOOT_ORG = 'https://looot.ai/#organization';

/** Spend guards the app enforces (README, "How costs and caps work"). */
const GUARDS = [
	{ value: '$5.00', label: 'default cap per sheet, held on the server' },
	{ value: '3×', label: 'a column’s usual price: the most one cell may spend' },
	{ value: '$0.50 / 50', label: 'dollars or cells before a run asks you first' },
	{ value: '20', label: 'misses in a row before a column pauses' },
];

const SELF_HOST = [
	{ cmd: 'git clone https://github.com/loootai/looot-tables', note: '' },
	{ cmd: 'cd looot-tables && npm ci', note: '' },
	{ cmd: 'cp .env.example .env.local', note: 'set DATABASE_URL' },
	{ cmd: 'npm run db:migrate', note: '' },
	{ cmd: 'npm run dev', note: '' },
];

const FEATURES = [
	{ title: 'Lists from one sentence', body: 'Type “Series A fintechs in Europe” or “VPs of Sales at US logistics firms”. Rows stream in, one per domain.', icon: Search },
	{ title: 'Answers that cite their pages', body: 'Ask “Who is the CEO?” or “Is there a free tier?” for every row. Each answer links what it read.', icon: Sparkles },
	{ title: 'Scores you can filter', body: 'Yes or no, a category or a level, each with a confidence, so you keep only the rows you trust.', icon: ListFilter },
	{ title: 'Emails and phones, graded', body: 'Each address comes back checked or graded, with the provider that answered named in the cell.', icon: Mail },
	{ title: 'Any looot endpoint as a column', body: 'Find it in plain words, map its inputs to your columns, and see the price before it runs.', icon: Gauge },
	{ title: 'An email or a PDF per row', body: 'Personal outreach or a branded one-pager, written from the research already in the sheet.', icon: FileText },
	{ title: 'Formulas that run locally', body: 'IF, VLOOKUP, SUM and the rest, computed in your browser. No API call, no cost.', icon: Braces },
	{ title: 'CSV, Excel or JSON out', body: 'Export the sheet with or without each cell’s confidence and sources.', icon: Download },
	{ title: 'Your agent can drive it', body: 'Claude Code, Cursor and other MCP clients read sheets, add columns and run them.', icon: Bot },
];

/** The four things that set the sheet apart, each shown with a real capture of the app (demo rows, stand-in providers). */
const SHOWCASE = [
	{ eyebrow: 'Receipts', title: 'Click any cell to see who answered.', body: 'Every value keeps the route looot walked: each provider it tried, in order, the one that answered, and what each try cost and took. If an answer is wrong, report it from the same card.', image: '/landing/receipt.webp', width: 710, height: 588, alt: 'A work email receipt: MoltSets missed at $0, then prospeo and hunter missed at $0 and apollo answered for $0.0061.' },
	{ eyebrow: 'Routing', title: 'Choose how each column spends.', body: 'Cheapest, most reliable, fastest or balanced. The editor lists every provider with its measured hit rate, typical time and price per call. Switch any of them off. looot only moves to the next one on a miss.', image: '/landing/routing.webp', width: 776, height: 713, alt: 'The routing editor for a work email column, listing prospeo, hunter and apollo with hit rate, p50 time and price per call.' },
	{ eyebrow: 'Quotes and caps', title: 'Know the most a run can cost before you click.', body: 'The Run button carries the server’s quote, here 10 cells for at most $0.12. Each sheet has a spend cap that the server checks before every cell, so no run can go past it.', image: '/landing/quote.webp', width: 843, height: 283, alt: 'The run bar: a cap of $5.00 with a fill meter, and a Run button reading Run 10 cells, up to $0.12.' },
	{ eyebrow: 'AI research', title: 'Ask a question per row. Check every answer.', body: 'Research columns search the web and read pages for each row, then keep the answer with its confidence, its sources and its cost, so you can trust the sheet before you send from it.', image: '/landing/research.webp', width: 720, height: 455, alt: 'A research answer, Yes: stripe.com/pricing, with confidence 0.94, cost $0.0030 and 2.8 seconds.' },
];


const FAQ = [
	{ q: 'What is looot tables?', a: 'An open-source sheet for enrichment. It builds a list of companies or people from a prompt or a CSV, then fills columns with work emails, phones, company data and AI research, each answer with its receipt and sources.' },
	{ q: 'How do I know what a column will cost?', a: 'Before: each column header shows its price per hit or per row, and the Run button shows the most the run can cost. During: the sheet’s spend cap is checked by the server before every cell. After: every cell’s receipt lists what each provider charged.' },
	{ q: 'Is looot tables free?', a: 'The code is, under the MIT license. You bring a looot token and an OpenAI key and pay those services for what you use. There is no shared token and no bundled credit.' },
	{ q: 'Is looot tables an open-source alternative to Clay?', a: 'For building and enriching lead lists, yes: prompts to rows, AI research columns, emails and phones through looot’s providers. The difference is that every answer shows who gave it and what it cost, and you can run your own copy.' },
	{ q: 'What is data enrichment?', a: 'Filling in what a list is missing: a website, headcount, funding, who runs the team, the tech stack, a work email. looot tables looks each row up live, through looot’s providers and the web, rather than from one static database.' },
	{ q: 'Where does the data come from?', a: 'Lookups (search, pages, company and people data, emails, phones) run through looot, which picks a provider per job and walks to the next one on a miss. OpenAI models write the answers. TypeSafe can make calibrated yes or no and category calls.' },
	{ q: 'Can I self-host looot tables?', a: 'Yes: on Vercel with any Postgres database, or locally on Node.js 22, with your looot token and OpenAI key. The README walks through it.' },
	{ q: 'Can AI agents use looot tables?', a: 'Yes. The built-in MCP server lets Claude Code, Cursor and other clients list sheets, read rows, add columns and run them in the same workspace you see in the browser.' },
	{ q: 'How big can a sheet be?', a: '1,000 rows per sheet and 10 sheets per workspace out of the box. A self-hosted copy can raise both.' },
];

function structuredData() {
	const url = siteUrl().toString();
	return {
		'@context': 'https://schema.org',
		'@graph': [
			{ '@type': 'Organization', '@id': LOOOT_ORG, name: 'looot', url: 'https://looot.ai' },
			{ '@type': 'WebSite', '@id': `${url}#website`, url, name: 'looot tables', description: SITE_DESCRIPTION, inLanguage: 'en', publisher: { '@id': LOOOT_ORG } },
			{
				'@type': 'SoftwareApplication', '@id': `${url}#app`, name: 'looot tables', url, description: SITE_DESCRIPTION, image: new URL('/opengraph-image.png', url).toString(),
				applicationCategory: 'BusinessApplication', applicationSubCategory: 'Data enrichment', operatingSystem: 'Web', browserRequirements: 'Requires JavaScript',
				isAccessibleForFree: true, license: 'https://opensource.org/licenses/MIT', offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
				featureList: FEATURES.map((feature) => feature.title), sameAs: [GITHUB_URL], publisher: { '@id': LOOOT_ORG },
			},
			{ '@type': 'SoftwareSourceCode', name: 'looot tables', codeRepository: GITHUB_URL, programmingLanguage: 'TypeScript', runtimePlatform: 'Node.js', license: 'https://opensource.org/licenses/MIT', targetProduct: { '@id': `${url}#app` } },
			{ '@type': 'FAQPage', '@id': `${url}#faq`, mainEntity: FAQ.map(({ q, a }) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
		],
	};
}

const primaryButton = 'inline-flex h-13 items-center justify-center gap-2 rounded-xl bg-brand px-6 text-[1rem] font-medium text-brand-fg shadow-[0_1px_2px_oklch(0.37_0.09_163/0.3),0_8px_24px_-8px_oklch(0.37_0.09_163/0.5)] transition-[background-color,box-shadow,scale,translate] duration-200 ease-[var(--ease-emphasized)] hover:-translate-y-0.5 hover:bg-brand-hover hover:shadow-[0_2px_4px_oklch(0.37_0.09_163/0.3),0_14px_32px_-10px_oklch(0.37_0.09_163/0.6)] [&_svg]:transition-transform hover:[&_svg]:translate-x-0.5 motion-reduce:hover:translate-y-0 active:scale-[0.98] motion-reduce:active:scale-100';
const secondaryButton = 'inline-flex h-13 items-center justify-center gap-2 rounded-xl bg-surface px-[22px] text-[1rem] font-medium shadow-[inset_0_0_0_1px_var(--color-line-strong)] transition-[box-shadow,scale,translate] duration-200 hover:-translate-y-0.5 hover:shadow-[inset_0_0_0_1px_var(--color-fg),0_10px_24px_-12px_oklch(0.2_0.025_165/0.35)] motion-reduce:hover:translate-y-0 active:scale-[0.98] motion-reduce:active:scale-100';
/** Footer links: 24px tall targets with an underline that fades in, not a colour change alone. */
const footerLink = 'inline-flex min-h-6 items-center underline decoration-transparent underline-offset-4 transition-[color,text-decoration-color] hover:text-fg hover:decoration-line-strong';
const inlineLink = 'font-medium text-fg underline decoration-line-strong underline-offset-[3px] transition-colors hover:decoration-fg';

export default function Landing() {
	return (
		<div className="bg-surface text-fg">
			<a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-4 focus:py-2 focus:text-body-sm focus:font-medium focus:shadow-[var(--shadow-floating)]">Skip to content</a>
			<script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData()).replace(/</g, '\\u003c') }} />

			<div className="relative isolate overflow-hidden border-b border-line bg-canvas">
				<header className="mx-auto flex w-full max-w-[1180px] items-center justify-between gap-4 px-5 pt-5 pb-3 md:px-12 md:pt-7">
					<Link href="/" className="flex items-center gap-2.5 rounded-md" aria-label="looot tables home">
						<Logo size={24} />
						<span className="text-[17px] font-semibold tracking-[-0.01em]">looot tables</span>
					</Link>
					<nav aria-label="Site" className="flex items-center gap-1 text-body text-fg-muted">
						<a href="#how-it-works" className="hidden rounded-md px-2.5 py-1.5 underline decoration-transparent underline-offset-[6px] transition-[color,text-decoration-color] hover:text-fg hover:decoration-brand sm:block">How it works</a>
						<a href="#faq" className="hidden rounded-md px-2.5 py-1.5 underline decoration-transparent underline-offset-[6px] transition-[color,text-decoration-color] hover:text-fg hover:decoration-brand sm:block">FAQ</a>
						<Link href="/app" className="hidden rounded-md px-2.5 py-1.5 underline decoration-transparent underline-offset-[6px] transition-[color,text-decoration-color] hover:text-fg hover:decoration-brand sm:block">Open the app</Link>
						<a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 transition-colors hover:text-fg">
							<GithubIcon className="size-4" /> GitHub
						</a>
					</nav>
				</header>

				<main id="main" className="mx-auto flex w-full max-w-[1180px] flex-col items-center px-5 pt-4 pb-14 text-center md:px-12 md:pt-5 md:pb-20">
					<p className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-caption text-fg-muted">
						<span className="num text-brand">0 API keys</span><span aria-hidden className="h-3 w-px bg-line-strong" />one looot token runs every lookup
					</p>
					<h1 className="mt-4 max-w-[920px] text-[clamp(2rem,1.1rem+2vw,2.75rem)] leading-[1.05] font-semibold tracking-[-0.035em] text-balance">
						The open-source enrichment sheet that shows <span className="text-brand">who answered and what it cost.</span>
					</h1>
					<p className="mt-4 max-w-[720px] text-[1.0625rem] leading-relaxed text-pretty text-fg-muted">{SITE_LEDE} Every cell keeps its receipt: the providers looot tried, in order, with the price and time of each.</p>
					<div className="mt-6 flex w-full max-w-[350px] flex-col gap-2.5 sm:w-auto sm:max-w-none sm:flex-row sm:gap-3">
						<a href={`${GITHUB_URL}#self-hosting`} target="_blank" rel="noopener noreferrer" data-track="landing_cta" data-cta="self-host" className={primaryButton}>
							Self-host it <ArrowRight aria-hidden className="size-4" strokeWidth={2} />
						</a>
						<a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" data-track="landing_cta" data-cta="github" className={secondaryButton}>
							<GithubIcon className="size-[17px]" /> GitHub
						</a>
					</div>
					<p className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-body-sm text-fg-subtle">
						<span>Open source, MIT</span><span aria-hidden>·</span><span>Spend capped on the server</span><span aria-hidden>·</span><PoweredBy />
					</p>
					<div className="mt-7 w-full"><HeroSheet /></div>
				</main>
			</div>

			<section id="how-it-works" aria-labelledby="how-it-works-title" className="scroll-mt-6">
				<div className="mx-auto w-full max-w-[1120px] px-5 pt-20 pb-6 md:px-12 md:pt-28">
					<p className="text-caption font-medium tracking-[0.08em] text-brand uppercase">How it works</p>
					<h2 id="how-it-works-title" className="mt-3 max-w-[760px] text-[clamp(1.75rem,1.2rem+1.6vw,2.5rem)] leading-[1.1] font-semibold tracking-[-0.03em] text-balance">A spreadsheet that shows its work, row by row and cent by cent.</h2>
					<p className="mt-4 max-w-[680px] text-[1.0625rem] leading-relaxed text-pretty text-fg-muted">Start from a prompt, a CSV or a blank sheet. Add columns that find emails and phones, pull company data or research a question. Every lookup runs through looot on your own balance.</p>
				</div>
				<ol className="mx-auto flex w-full max-w-[1120px] flex-col gap-16 px-5 pt-10 pb-20 md:gap-24 md:px-12 md:pb-28">
					{SHOWCASE.map((item, index) => (
						<li key={item.eyebrow} className={`grid items-center gap-8 md:gap-14 ${index % 2 ? 'md:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]' : 'md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]'}`}>
							<div className={index % 2 ? 'md:order-2' : undefined}>
								<p className="flex items-center gap-2 text-caption font-medium text-fg-subtle"><span className="num grid size-5 place-items-center rounded-full bg-success-soft text-[11px] text-brand">{index + 1}</span>{item.eyebrow}</p>
								<h3 className="mt-3 text-h4 leading-[1.25] font-semibold tracking-[-0.02em] text-balance md:text-[1.625rem]">{item.title}</h3>
								<p className="mt-3 leading-relaxed text-pretty text-fg-muted">{item.body}</p>
							</div>
							<figure className="showcase-frame relative overflow-hidden rounded-[18px] border border-line bg-canvas p-3 shadow-[var(--shadow-card)] md:p-4">
								<Image src={item.image} alt={item.alt} width={item.width} height={item.height} sizes="(min-width: 768px) 620px, 100vw" className="h-auto w-full rounded-[10px] border border-line-subtle bg-surface" />
							</figure>
						</li>
					))}
				</ol>
			</section>

			<section id="features" aria-labelledby="features-title" className="border-t border-line bg-canvas">
				<div className="mx-auto w-full max-w-[1120px] px-5 py-20 md:px-12 md:py-24">
					<h2 id="features-title" className="text-h3 font-semibold tracking-[-0.025em]">Everything else a list needs</h2>
					<ul className="mt-10 grid gap-px overflow-hidden rounded-[14px] border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
						{FEATURES.map(({ title, body, icon: Icon }) => (
							<li key={title} className="flex flex-col gap-2 bg-surface p-6">
								<Icon aria-hidden className="size-[18px] text-brand" strokeWidth={1.75} />
								<h3 className="mt-1 text-body-lg font-medium tracking-[-0.01em]">{title}</h3>
								<p className="text-body-sm leading-relaxed text-pretty text-fg-muted">{body}</p>
							</li>
						))}
					</ul>
				</div>
			</section>

			<section id="open-source" aria-labelledby="open-source-title" className="border-t border-line">
				<div className="mx-auto grid w-full max-w-[1120px] items-start gap-10 px-5 py-20 md:grid-cols-2 md:gap-14 md:px-12 md:py-24">
					<div>
						<p className="text-caption font-medium tracking-[0.08em] text-brand uppercase">Open source, MIT</p>
						<h2 id="open-source-title" className="mt-3 text-h3 font-semibold tracking-[-0.025em] text-balance">Your copy, your keys, your caps.</h2>
						<p className="mt-4 leading-relaxed text-pretty text-fg-muted">Every lookup runs as a <a href="https://looot.ai" target="_blank" rel="noopener" className={inlineLink}>looot</a> job on your own balance. With a <a href={MOLTSETS_URL} target="_blank" rel="noopener" className={inlineLink}>MoltSets</a> key, emails come from your flat-fee plan first and looot answers only the misses. Sheets live in your own Postgres.</p>
						<ul className="mt-6 grid gap-px overflow-hidden rounded-[12px] border border-line bg-line sm:grid-cols-2">
							{GUARDS.map((guard) => (
								<li key={guard.label} className="bg-surface px-4 py-3">
									<p className="num text-body-lg font-medium text-fg">{guard.value}</p>
									<p className="mt-0.5 text-caption text-fg-muted">{guard.label}</p>
								</li>
							))}
						</ul>
					</div>
					<figure className="overflow-hidden rounded-[14px] border border-neutral-80 bg-neutral-90 shadow-[var(--shadow-card)]">
						<figcaption className="flex items-center gap-1.5 border-b border-white/10 px-4 py-2.5 text-caption text-neutral-40"><span aria-hidden className="size-2 rounded-full bg-white/15" /><span aria-hidden className="size-2 rounded-full bg-white/15" /><span aria-hidden className="size-2 rounded-full bg-white/15" /><span className="ml-2">Run your own copy</span></figcaption>
						<pre className="overflow-x-auto px-4 py-4 text-[13px] leading-[1.75] text-neutral-10"><code>{SELF_HOST.map((line) => <span key={line.cmd} className="block"><span aria-hidden className="text-blue-60 select-none">$ </span>{line.cmd}{line.note && <span className="text-neutral-30">{`   # ${line.note}`}</span>}</span>)}</code></pre>
						<p className="border-t border-white/10 px-4 py-2.5 text-caption text-neutral-40">Then open <span className="num text-neutral-10">localhost:3000/app</span> and paste your looot token. <a href={`${GITHUB_URL}#self-hosting`} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-6 items-center text-neutral-10 underline decoration-white/30 underline-offset-4 hover:decoration-white">Full guide</a></p>
					</figure>
				</div>
			</section>

			<Section id="faq" title="Frequently asked questions">
				<dl className="grid gap-x-12 sm:grid-cols-2">
					{FAQ.map(({ q, a }) => (
						<div key={q} className="border-t border-line py-6">
							<dt><h3 className="text-h5 font-medium tracking-[-0.01em]">{q}</h3></dt>
							<dd className="mt-2 leading-relaxed text-pretty text-fg-muted">{a}</dd>
						</div>
					))}
				</dl>
			</Section>

			<section aria-labelledby="try-looot-tables" className="border-t border-line bg-canvas">
				<div className="mx-auto flex w-full max-w-[1080px] flex-col items-start gap-6 px-5 py-16 md:flex-row md:items-center md:justify-between md:px-12 md:py-20">
					<div>
						<h2 id="try-looot-tables" className="text-h3 font-medium tracking-[-0.02em]">Bring a list. Get every answer with its receipt.</h2>
						<p className="mt-2 text-fg-muted">MIT licensed. Runs on your own looot balance, capped per sheet.</p>
					</div>
					<div className="flex w-full flex-col gap-2.5 sm:w-auto sm:flex-row sm:gap-3">
						<Link href="/app" data-track="landing_cta" data-cta="footer_start" className={primaryButton}>
							Open looot tables <ArrowRight aria-hidden className="size-4" strokeWidth={2} />
						</Link>
						<a href={DOCS_URL} target="_blank" rel="noopener noreferrer" data-track="landing_cta" data-cta="docs" className={secondaryButton}>Read the docs</a>
					</div>
				</div>
			</section>

			<footer className="border-t border-line">
				<div className="mx-auto flex w-full max-w-[1080px] flex-col gap-4 px-5 py-8 text-body-sm text-fg-subtle sm:flex-row sm:items-center sm:justify-between md:px-12">
					<div className="flex items-center gap-2 text-fg">
						<Logo size={18} />
						<span className="font-semibold tracking-[-0.01em]">looot tables</span>
						<span className="text-fg-subtle">· MIT license</span>
						<PoweredBy className="ml-2 font-normal text-fg-subtle" />
					</div>
					<div className="flex flex-wrap items-center gap-x-5 gap-y-2">
						<a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className={footerLink}>GitHub</a>
						<a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className={footerLink}>Docs</a>
						<a href={`${GITHUB_URL}/blob/main/docs/mcp.md`} target="_blank" rel="noopener noreferrer" className={footerLink}>MCP</a>
						<a href={`${GITHUB_URL}/blob/main/THIRD_PARTY_NOTICES.md`} target="_blank" rel="noopener noreferrer" className={footerLink}>Third-party notices</a>
					</div>
				</div>
			</footer>
		</div>
	);
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
	return (
		<section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-6 border-t border-line">
			<div className="mx-auto grid w-full max-w-[1080px] gap-6 px-5 py-16 md:grid-cols-[280px_1fr] md:gap-12 md:px-12 md:py-24">
				<h2 id={`${id}-title`} className="text-h3 font-medium tracking-[-0.02em] text-balance">{title}</h2>
				<div className="min-w-0">{children}</div>
			</div>
		</section>
	);
}
