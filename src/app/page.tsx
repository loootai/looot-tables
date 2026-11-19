import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { GithubIcon, Logo } from '@/components/ui/logo';
import { CONTEXT_DEV_URL, DOCS_URL, ENRICHABLE_URL, GITHUB_URL, SITE_DESCRIPTION, SITE_LEDE, SITE_TITLE } from '@/lib/constants';
import { siteUrl } from '@/lib/server/deployment';

export const metadata: Metadata = {
	title: { absolute: SITE_TITLE },
	description: SITE_DESCRIPTION,
	alternates: { canonical: '/' },
	// Page-level openGraph/twitter replace the layout's objects, so repeat the shared fields.
	openGraph: { type: 'website', siteName: 'looot tables', locale: 'en_US', title: SITE_TITLE, description: SITE_DESCRIPTION, url: '/' },
	twitter: { card: 'summary_large_image', title: SITE_TITLE, description: SITE_DESCRIPTION },
};

const CONTEXT_ORG = 'https://www.context.dev/#organization';
const LOOOT_ORG = 'https://looot.ai/#organization';

const FEATURES = [
	{ title: 'Build lead lists from a prompt', body: 'Ask for “every Series A fintech in Europe” or “VPs of Sales at US logistics companies”. Matching companies or people stream into the sheet, deduplicated by domain.' },
	{ title: 'Research every row', body: 'Add a column with a question like “Who is the CEO?” or “Does the pricing page offer a free tier?”. looot tables answers it for each row and links every answer to its sources.' },
	{ title: 'Qualify and score accounts', body: 'True or false checks, categories and scores on levels you define. Each call comes with a probability or confidence, so you can filter on how sure it is.' },
	{ title: 'Find work emails and phones', body: 'One column asks looot for a work email. looot tries its email providers one after another, cheapest or most reliable first, and keeps the first address it finds. A phone column and an email check work the same way.' },
	{ title: 'Run any looot endpoint', body: 'Search the looot catalog in plain words, map an endpoint’s inputs from your columns, and see the cost for the rows you pick before it runs.' },
	{ title: 'Draft outreach and documents', body: 'Write a personalized email or a branded PDF for every row, using the research already in the sheet.' },
	{ title: 'Use real spreadsheet formulas', body: 'SUM, IF, VLOOKUP and hundreds more run in your browser through IronCalc, with no API calls and no keys.' },
	{ title: 'Export anywhere', body: 'Download CSV, Excel or JSON, with or without confidence scores and sources.' },
	{ title: 'Work from your AI agent', body: 'A built-in MCP server lets Claude Code, Cursor and other MCP clients read sheets, add columns and run enrichment.' },
];

const STEPS = [
	{ title: 'Find rows', body: 'Describe the companies or people you want, import a CSV, or start from a blank sheet.' },
	{ title: 'Add AI columns', body: 'Write a question and reference other columns, like {{Website}}. looot tables picks the method: web research, reading a page, a company lookup or an email search.' },
	{ title: 'Review and export', body: 'Open any cell to see its sources and confidence. Rerun or edit it, filter the rows that pass, and export.' },
];

const FAQ = [
	{ q: 'What is looot tables?', a: 'looot tables is a free, open-source AI spreadsheet for data enrichment. You describe a list of companies or people, it finds them, and then AI columns research every row with live web data and keep the sources.' },
	{ q: 'Is looot tables free?', a: 'Yes. The code is MIT licensed. A copy runs on your own looot token and OpenAI key, so you pay looot and OpenAI directly for what you use. There is no shared token and no included credit: every run is billed to your own balance.' },
	{ q: 'What is data enrichment?', a: 'Data enrichment adds missing facts to a list of companies or people: websites, headcount, funding, leadership, tech stack, work emails or anything else on the public web. looot tables does it by researching each row on the live web instead of reading from a static database.' },
	{ q: 'Is looot tables an open-source alternative to Clay?', a: 'For the core workflow, yes. It builds lead lists, enriches them with AI research and finds emails through looot, which walks its providers for you. It is open source, you can self-host it, and every run bills your own looot balance.' },
	{ q: 'Where does the data come from?', a: 'Web search, page reads, company and people data, emails and phone numbers come from looot, which runs each lookup on the best provider for the job. OpenAI models do the reasoning. TypeSafe can make calibrated true or false and category calls.' },
	{ q: 'Can I self-host looot tables?', a: 'Yes. Deploy it to Vercel with a Postgres database, or run it locally with Node.js 22. You need a looot token and an OpenAI API key. The README on GitHub has the steps.' },
	{ q: 'Can AI agents use looot tables?', a: 'Yes. looot tables includes an MCP server, so Claude Code, Cursor and other MCP clients can list sheets, read rows, add columns and run enrichment in the same workspace you use in the browser.' },
	{ q: 'How big can a sheet be?', a: 'Up to 1,000 rows per sheet and 10 sheets per workspace by default. Self-hosted copies can change both limits.' },
];

function structuredData() {
	const url = siteUrl().toString();
	return {
		'@context': 'https://schema.org',
		'@graph': [
			{ '@type': 'Organization', '@id': LOOOT_ORG, name: 'looot', url: 'https://looot.ai' },
				{ '@type': 'Organization', '@id': CONTEXT_ORG, name: 'Context.dev', url: CONTEXT_DEV_URL },
			{ '@type': 'WebSite', '@id': `${url}#website`, url, name: 'looot tables', description: SITE_DESCRIPTION, inLanguage: 'en', publisher: { '@id': LOOOT_ORG } },
			{
				'@type': 'SoftwareApplication', '@id': `${url}#app`, name: 'looot tables', url, description: SITE_DESCRIPTION, image: new URL('/opengraph-image.png', url).toString(),
				applicationCategory: 'BusinessApplication', applicationSubCategory: 'Data enrichment', operatingSystem: 'Web', browserRequirements: 'Requires JavaScript',
				isAccessibleForFree: true, license: 'https://opensource.org/licenses/MIT', offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
				featureList: FEATURES.map((feature) => feature.title), sameAs: [GITHUB_URL], publisher: { '@id': LOOOT_ORG }, creator: { '@id': CONTEXT_ORG },
			},
			{ '@type': 'SoftwareSourceCode', name: 'looot tables', codeRepository: GITHUB_URL, programmingLanguage: 'TypeScript', runtimePlatform: 'Node.js', license: 'https://opensource.org/licenses/MIT', targetProduct: { '@id': `${url}#app` } },
			{ '@type': 'FAQPage', '@id': `${url}#faq`, mainEntity: FAQ.map(({ q, a }) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
		],
	};
}

/** Faint sample cells laid on the background grid: one finished column, one still researching. */
const DOMAINS = ['sunnova.com', 'tesla.com', 'nextracker.com', 'sunrun.com', 'enphase.com', 'aurorasolar.com', 'firstsolar.com', 'sunpower.com', 'arcadia.com', 'palmetto.com', 'solaredge.com'];
const CEOS = ['John Berger', 'Elon Musk', 'Dan Shugar', 'Mary Powell', 'Badri Kothandaraman'];

const primaryButton = 'inline-flex h-13 items-center justify-center gap-2 rounded-xl bg-brand px-6 text-[1rem] font-medium text-white shadow-[0_1px_2px_rgb(37_99_235/0.3),0_8px_24px_-8px_rgb(37_99_235/0.55)] transition-[background-color,scale] duration-150 hover:bg-brand-hover active:scale-[0.98] motion-reduce:active:scale-100';
const secondaryButton = 'inline-flex h-13 items-center justify-center gap-2 rounded-xl bg-surface px-[22px] text-[1rem] font-medium shadow-[inset_0_0_0_1px_#d9d9d9] transition-[box-shadow,scale] duration-150 hover:shadow-[inset_0_0_0_1px_var(--color-fg)] active:scale-[0.98] motion-reduce:active:scale-100';
const inlineLink = 'font-medium text-fg underline decoration-line-strong underline-offset-[3px] transition-colors hover:decoration-fg';

export default function Landing() {
	return (
		<div className="bg-surface text-fg">
			<script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData()).replace(/</g, '\\u003c') }} />

			<div className="relative isolate flex min-h-dvh flex-col overflow-hidden">
				<SheetBackdrop />
				<header className="flex items-center justify-between gap-4 px-5 pt-5 pb-3 md:px-12 md:pt-7 short:pt-3 short:pb-1">
					<Link href="/" className="flex items-center gap-2.5 rounded-md" aria-label="looot tables home">
						<Logo size={24} />
						<span className="text-[17px] font-semibold tracking-[-0.01em]">looot tables</span>
					</Link>
					<nav aria-label="Site" className="flex items-center gap-1 text-body text-fg-muted">
						<a href="#how-it-works" className="hidden rounded-md px-2.5 py-1.5 transition-colors hover:text-fg sm:block">How it works</a>
						<a href="#faq" className="hidden rounded-md px-2.5 py-1.5 transition-colors hover:text-fg sm:block">FAQ</a>
						<a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 transition-colors hover:text-fg">
							<GithubIcon className="size-4" /> GitHub
						</a>
					</nav>
				</header>

				<main className="flex flex-1 flex-col items-center justify-center px-5 pb-8 text-center md:px-12 short:pb-3">
					<h1 className="max-w-[840px] text-[clamp(2.5rem,1.4rem+3.6vw,4.25rem)] leading-[1.06] font-medium tracking-[-0.035em] text-balance short:text-[2.25rem]">
						A spreadsheet that <span className="text-brand">enriches itself</span> from the internet.
					</h1>
					<p className="mt-5 max-w-[600px] text-[1.0625rem] leading-relaxed text-pretty text-fg-muted md:mt-6 md:text-[1.1875rem] short:mt-3 short:text-[1rem]">{SITE_LEDE}</p>
					<div className="mt-8 flex w-full max-w-[350px] flex-col gap-2.5 sm:w-auto sm:max-w-none sm:flex-row sm:gap-3 short:mt-5">
						<Link href="/app" data-track="landing_cta" data-cta="start" className={`${primaryButton} short:h-11`}>
							Start enriching <ArrowRight aria-hidden className="size-4" strokeWidth={2} />
						</Link>
						<a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" data-track="landing_cta" data-cta="github" className={`${secondaryButton} short:h-11`}>
							<GithubIcon className="size-[17px]" /> View on GitHub
						</a>
					</div>
				</main>

				<div className="flex flex-col items-center justify-center gap-1.5 px-5 pb-7 text-body-sm text-fg-subtle sm:flex-row sm:gap-3.5 md:pb-8 short:pb-3">
					<span>Free and open source (MIT)</span>
					<span aria-hidden className="hidden h-3.5 w-px bg-line-strong sm:block" />
					<BuiltOnEnrichable />
				</div>
			</div>

			<Section id="what-is-looot-tables" title="What is looot tables?">
				<div className="space-y-4 text-[1.0625rem] leading-relaxed text-fg-muted">
					<p>
						<strong className="font-medium text-fg">looot tables is a free, open-source AI spreadsheet for data enrichment.</strong> You describe the list you need, such as “every solar company in the US with 50+ employees”, and it fills a sheet with matching companies or people.
					</p>
					<p>Then you add columns by asking questions in plain English. looot tables answers each one for every row by searching the web, reading pages and pulling company and contact data. Every answer keeps its sources, so you can check the work before you use it.</p>
				</div>
			</Section>

			<Section id="features" title="What you can do with it">
				<ul className="grid gap-x-12 sm:grid-cols-2">
					{FEATURES.map((feature) => (
						<li key={feature.title} className="border-t border-line py-6">
							<h3 className="text-h5 font-medium tracking-[-0.01em]">{feature.title}</h3>
							<p className="mt-2 leading-relaxed text-pretty text-fg-muted">{feature.body}</p>
						</li>
					))}
				</ul>
			</Section>

			<Section id="how-it-works" title="How it works">
				<ol className="overflow-hidden rounded-[10px] border border-line">
					{STEPS.map((step, index) => (
						<li key={step.title} className="flex border-b border-line-subtle last:border-b-0">
							<span aria-hidden className="flex w-12 shrink-0 justify-center border-r border-line-subtle bg-neutral-5 pt-[22px] text-caption text-fg-subtle tabular">{index + 1}</span>
							<div className="px-5 py-5 md:px-6">
								<h3 className="text-h5 font-medium tracking-[-0.01em]">{step.title}</h3>
								<p className="mt-1.5 leading-relaxed text-pretty text-fg-muted">{step.body}</p>
							</div>
						</li>
					))}
				</ol>
			</Section>

			<Section id="open-source" title="Open source, built on Enrichable">
				<div className="space-y-4 text-[1.0625rem] leading-relaxed text-fg-muted">
					<p>
						looot tables is MIT licensed and built on <a href={ENRICHABLE_URL} target="_blank" rel="noopener" className={inlineLink}>Enrichable</a> by <a href={CONTEXT_DEV_URL} target="_blank" rel="noopener" className={inlineLink}>Context.dev</a>. Every search, page read, company lookup, person lookup, email and phone lookup runs as a <a href="https://looot.ai" target="_blank" rel="noopener" className={inlineLink}>looot</a> job on your own looot balance.
						</p>
						<p>
							<a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className={inlineLink}>Self-host it</a> with your own looot token and OpenAI key. Your sheets live in your own Postgres database.
					</p>
				</div>
			</Section>

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
						<h2 id="try-looot-tables" className="text-h3 font-medium tracking-[-0.02em]">Try it on a list you need this week.</h2>
						<p className="mt-2 text-fg-muted">Free and open source. Run your own copy.</p>
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
					</div>
					<div className="flex flex-wrap items-center gap-x-5 gap-y-2">
						<a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="hover:text-fg">GitHub</a>
						<a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="hover:text-fg">Docs</a>
						<a href={`${GITHUB_URL}/blob/main/docs/mcp.md`} target="_blank" rel="noopener noreferrer" className="hover:text-fg">MCP</a>
						<BuiltOnEnrichable />
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

/** The credit line: looot tables is built on Enrichable, which Context.dev published under the MIT license. */
function BuiltOnEnrichable() {
	return (
		<a href={ENRICHABLE_URL} target="_blank" rel="noopener" className="inline-flex items-center gap-[7px] rounded-md hover:text-fg">
			Built on Enrichable by <Image src="/providers/context.svg" alt="" width={20} height={14} unoptimized /> <span className="font-semibold tracking-[-0.01em] text-fg">Context.dev</span>
		</a>
	);
}

function SheetBackdrop() {
	return (
		<div aria-hidden data-nosnippet className="sheet-backdrop pointer-events-none absolute inset-0 -z-10 select-none">
			<div className="sheet-backdrop-column left-[calc(50%-630px)]">
				<span className="sheet-backdrop-head">Website</span>
				{DOMAINS.map((domain) => (
					<span key={domain}>{domain}</span>
				))}
			</div>
			<div className="sheet-backdrop-column left-[calc(50%+450px)]">
				<span className="sheet-backdrop-head">
					<i className="sheet-backdrop-dot" /> CEO
				</span>
				{CEOS.map((ceo, index) => (
					<span key={ceo} className="sheet-backdrop-arrival" style={{ animationDelay: `${300 + index * 140}ms` }}>
						{ceo}
					</span>
				))}
				<span className="sheet-backdrop-active">
					<i className="sheet-backdrop-dot" /> Researching…
				</span>
			</div>
		</div>
	);
}
