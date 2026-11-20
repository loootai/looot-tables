'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Download, Eye, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { keyHeaders } from '@/lib/keys';
import type { DocumentBranding } from '@/lib/document-branding';
import { useSettings } from '@/components/app/settings-context';

const MarkdownEditor = dynamic(() => import('@uiw/react-md-editor/nohighlight'), {
	ssr: false,
	loading: () => <p role="status" className="p-4 text-body-sm text-fg-muted">Loading editor…</p>,
});

export function DocumentPreview({ markdown, title, clientDomain = '', onSave }: { markdown: string; title: string; clientDomain?: string; onSave: (markdown: string) => Promise<void> }) {
	const { settings } = useSettings();
	const [primaryOverride, setPrimaryDomain] = useState<string | null>(null);
	const primaryDomain = primaryOverride ?? settings.companyDomain ?? '';
	const [secondaryDomain, setSecondaryDomain] = useState(clientDomain);
	const [draft, setDraft] = useState<string | null>(null);
	const [mode, setMode] = useState<'edit' | 'preview'>('preview');
	const [saving, setSaving] = useState(false);
	const [exporting, setExporting] = useState(false);
	const { toast } = useToast();
	const value = draft ?? markdown;
	const dirty = value !== markdown;
	async function save() {
		setSaving(true);
		try {
			await onSave(value);
			setDraft((current) => current === value ? null : current);
			setMode('preview');
		} catch (error) { toast(error instanceof Error ? error.message : 'Could not save document', 'error'); }
		finally { setSaving(false); }
	}
	async function download() {
		setExporting(true);
		try {
			const { downloadDocumentPdf } = await import('@/lib/document-pdf');
			const response = await fetch('/api/documents/branding', { method: 'POST', headers: keyHeaders(), body: JSON.stringify({ primaryDomain, secondaryDomain }) });
			const branding: DocumentBranding & { error?: string } = await response.json();
			if (!response.ok) throw new Error(branding.error || 'Could not load PDF branding.');
			await downloadDocumentPdf(value, title, branding);
		} catch (error) { toast(error instanceof Error ? error.message : 'Could not download PDF. Please try again.', 'error'); }
		finally { setExporting(false); }
	}
	return <section aria-label="Document" className="document-editor flex min-w-0 flex-col gap-3" data-color-mode="light">
		<div className="flex flex-wrap items-center justify-between gap-2">
			<div className="relative isolate grid grid-cols-2 rounded-lg border border-line-subtle bg-neutral-5 p-0.5" role="group" aria-label="Document mode">
				<span aria-hidden className="pointer-events-none absolute inset-y-0.5 left-0.5 -z-10 w-[calc(50%-2px)] rounded-md bg-surface shadow-sm transition-transform duration-200 ease-out motion-reduce:transition-none" style={{ transform: mode === 'edit' ? 'translateX(100%)' : 'translateX(0)' }} />
				{([{ value: 'preview', label: 'Preview', Icon: Eye }, { value: 'edit', label: 'Edit', Icon: Pencil }] as const).map(({ value, label, Icon }) => <button key={value} type="button" aria-pressed={mode === value} disabled={saving} onClick={() => setMode(value)} className={`relative inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-3 text-caption transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50 ${mode === value ? 'font-medium text-fg' : 'text-fg-subtle hover:text-fg'}`}><Icon aria-hidden className="size-3.5" strokeWidth={1.75} />{label}</button>)}
			</div>
			<Button size="xs" disabled={exporting || !value.trim()} loading={exporting} onClick={() => void download()}><Download aria-hidden strokeWidth={1.75} /> Download PDF</Button>
		</div>
		<details className="text-caption text-fg-muted">
			<summary className="cursor-pointer">PDF branding</summary>
			<div className="mt-2 grid gap-3 sm:grid-cols-2">
				<label className="grid gap-1">Your company website<input aria-label="Your company website" value={primaryDomain} onChange={(event) => setPrimaryDomain(event.target.value)} placeholder="Use workspace company" className="rounded-md border border-line-subtle bg-surface px-2 py-1.5 text-fg" /></label>
				<label className="grid gap-1">Client website (optional)<input aria-label="Client website" value={secondaryDomain} onChange={(event) => setSecondaryDomain(event.target.value)} placeholder="No client branding" className="rounded-md border border-line-subtle bg-surface px-2 py-1.5 text-fg" /></label>
			</div>
		</details>
		<MarkdownEditor
			value={value}
			onChange={(next) => setDraft(next ?? '')}
			preview={mode}
			extraCommands={[]}
			hideToolbar={mode === 'preview'}
			height={480}
			visibleDragbar={false}
			textareaProps={{ 'aria-label': 'Document Markdown', disabled: saving, placeholder: '# Document title\n\nWrite your research here…', onKeyDown: (event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (!saving && dirty) void save(); } } }}
			previewOptions={{ skipHtml: true }}
			components={{ preview: (source) => <article aria-label="Document preview" className="document-preview p-5 text-body-sm leading-relaxed">
				<Markdown skipHtml remarkPlugins={[remarkGfm]} components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>, img: ({ alt }) => <span>{alt}</span> }}>{source ?? ''}</Markdown>
			</article> }}
		/>
		{(dirty || mode === 'edit') && <div className="flex items-center justify-end gap-2">
			{dirty && <span className="mr-auto text-caption text-fg-subtle" role="status">Unsaved changes</span>}
			<Button size="xs" disabled={saving} onClick={() => { setDraft(null); setMode('preview'); }}>Cancel</Button>
			<Button size="xs" variant="brand" loading={saving} disabled={!dirty || saving} onClick={() => void save()}>Save</Button>
		</div>}
	</section>;
}
