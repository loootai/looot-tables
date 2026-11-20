import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
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
const inlineLink = 'font-medium text-fg underline decoration-line-strong underline-offset-[3px] transition-colors hover:decoration-fg';

export default function Landing() {
	return (
		<div className="bg-surface text-fg">
			<script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData()).replace(/</g, '\\u003c') }} />

			<div className="relative isolate overflow-hidden border-b border-line bg-canvas">
				<header className="mx-auto flex w-full max-w-[1180px] items-center justify-between gap-4 px-5 pt-5 pb-3 md:px-12 md:pt-7">
					<Link href="/" className="flex items-center gap-2.5 rounded-md" aria-label="looot tables home">
						<Logo size={24} />
						<span className="text-[17px] font-semibold tracking-[-0.01em]">looot tables</span>
					</Link>
					<nav aria-label="Site" className="flex items-center gap-1 text-body text-fg-muted">
						<a href="#how-it-works" className="hidden rounded-md px-2.5 py-1.5 transition-colors hover:text-fg sm:block">How it works</a>
						<a href="#faq" className="hidden rounded-md px-2.5 py-1.5 transition-colors hover:text-fg sm:block">FAQ</a>
						<Link href="/app" className="hidden rounded-md px-2.5 py-1.5 transition-colors hover:text-fg sm:block">Open the app</Link>
						<a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 transition-colors hover:text-fg">
							<GithubIcon className="size-4" /> GitHub
						</a>
					</nav>
				</header>

				<main className="mx-auto flex w-full max-w-[1180px] flex-col items-center px-5 pt-4 pb-14 text-center md:px-12 md:pt-5 md:pb-20">
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

			<Section id="open-source" title="Open source, MIT">
				<div className="space-y-4 text-[1.0625rem] leading-relaxed text-fg-muted">
					<p>
						looot tables is MIT licensed. Every search, page read, company lookup, person lookup, email and phone lookup runs as a <a href="https://looot.ai" target="_blank" rel="noopener" className={inlineLink}>looot</a> job on your own looot balance. With a <a href={MOLTSETS_URL} target="_blank" rel="noopener" className={inlineLink}>MoltSets</a> key, work emails come from your flat-fee plan first and looot only answers the misses.
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
						<PoweredBy className="ml-2 font-normal text-fg-subtle" />
					</div>
					<div className="flex flex-wrap items-center gap-x-5 gap-y-2">
						<a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="hover:text-fg">GitHub</a>
						<a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="hover:text-fg">Docs</a>
						<a href={`${GITHUB_URL}/blob/main/docs/mcp.md`} target="_blank" rel="noopener noreferrer" className="hover:text-fg">MCP</a>
						<a href={`${GITHUB_URL}/blob/main/THIRD_PARTY_NOTICES.md`} target="_blank" rel="noopener noreferrer" className="hover:text-fg">Third-party notices</a>
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
