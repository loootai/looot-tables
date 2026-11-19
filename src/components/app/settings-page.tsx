'use client';

import Dexie from 'dexie';
import { useEffect, useRef, useState } from 'react';
import { accountStorageKey } from '@/lib/account-storage';
import { importMyLocalSheets } from '@/lib/db';
import type { Settings } from '@/lib/keys';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { PageColumn, PageHeader } from './page-header';
import { ModelPicker } from './model-picker';
import { useSettings } from './settings-context';
import { McpAccess } from './mcp-access';
import { CompanyBranding } from './company-branding';
import { brandingDomain, loadBrand } from './brand-lookup';
import { Connections } from './connections';
import { isReady } from './providers';
import { providerCheck, useVerification, type ProviderCheck } from './use-verification';

export function SettingsPage() {
	const { selfHosted, workspaceName } = useSettings();
	return (
		<PageColumn>
			<PageHeader title="Configuration" description={selfHosted ? 'Your workspace is tied to this browser. Keep its cookies to keep your sheets.' : `Shared with ${workspaceName || 'your Context.dev team'}.`} />
			<Connections />
			<Defaults />
			<McpAccess />
			{!selfHosted && <LegacySheetsImport />}
		</PageColumn>
	);
}

const clampConcurrency = (value: number) => Math.max(1, Math.min(16, Math.round(value)));

function Defaults() {
	const { settings, update, organization } = useSettings();
	const { toast } = useToast();
	const [draft, setDraft] = useState<Partial<Settings> | null>(null);
	const [concurrencyText, setConcurrencyText] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState('');
	// The revision this draft started from: a teammate's save in between is reported as a conflict, not overwritten.
	const draftRevision = useRef<number | undefined>(undefined);
	const values = { ...settings, ...draft };
	function change(patch: Partial<Settings>) {
		if (!draft) draftRevision.current = organization?.revision;
		setDraft((current) => ({ ...current, ...patch }));
		setError('');
	}
	/** One save for the card. A new company website must resolve to a brand first, so a bad domain never saves. */
	async function save() {
		if (!draft) return;
		setSaving(true); setError('');
		try {
			const patch = { ...draft };
			if (patch.companyDomain !== undefined) {
				const domain = brandingDomain(patch.companyDomain);
				if (domain === null) throw new Error('Enter a valid company website.');
				await loadBrand(domain);
				patch.companyDomain = domain;
			}
			await update(patch, draftRevision.current);
			setDraft(null); setConcurrencyText(null);
			toast('Defaults saved.', 'success');
		} catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save defaults.'); }
		finally { setSaving(false); }
	}
	return (
		<section aria-labelledby="defaults-title" className="glass-card flex flex-col gap-5 px-5 py-5">
			<h2 id="defaults-title" className="text-body text-fg">Defaults</h2>
			<Field label="Parallel cells" help="How many cells enrich at once. Lower it if you hit rate limits.">
				{(id) => <Input id={id} type="number" min={1} max={16} value={concurrencyText ?? String(values.concurrency)} onChange={(event) => { const text = event.target.value; setConcurrencyText(text); if (text.trim() && Number.isFinite(Number(text))) change({ concurrency: clampConcurrency(Number(text)) }); }} onBlur={() => setConcurrencyText(null)} className="max-w-28" />}
			</Field>
			<details className="group/advanced flex flex-col">
				<summary className="cursor-pointer text-body-sm text-fg-muted hover:text-fg">Advanced</summary>
				<div className="flex flex-col gap-5 pt-4">
					<ModelDefaults values={values} draft={draft} onChange={change} />
				</div>
			</details>
			<div className="border-t border-line-subtle pt-5"><CompanyBranding value={values.companyDomain ?? ''} onChange={(companyDomain) => change({ companyDomain })} /></div>
			{error && <p role="alert" className="text-body-sm text-danger">{error}</p>}
			<Button size="sm" className="self-start" disabled={!draft} loading={saving} onClick={() => void save()}>Save defaults</Button>
		</section>
	);
}

/** The model or base URL was edited away from the saved value, so it needs a live test. */
const modelEdited = (draft: Partial<Settings> | null, settings: Settings) => (draft?.model !== undefined && draft.model !== settings.model) || (draft?.openaiBaseUrl !== undefined && draft.openaiBaseUrl !== settings.openaiBaseUrl);

function ModelDefaults({ values, draft, onChange }: { values: Settings; draft: Partial<Settings> | null; onChange: (patch: Partial<Settings>) => void }) {
	const { settings, connections } = useSettings();
	const modelChanged = modelEdited(draft, settings);
	const modelCheck = useVerification(values, modelChanged && isReady(connections.openai) ? ['openai'] : [], { inference: true });
	return <>
		<Field label="AI model" help="Used for AI columns, research, and Find rows. Any OpenAI model ID works.">
			{(id) => <ModelPicker id={id} value={values.model} onChange={(model) => onChange({ model })} />}
		</Field>
		{modelChanged && <ModelCheckLine checking={modelCheck.checking} check={providerCheck(modelCheck.result, 'openai')} />}
		<Field label="Yes/no and category answers" help="Automatic (recommended) uses calibrated decisions when TypeSafe is connected, and your AI model otherwise. Or pick a specific model.">
			{(id) => <ModelPicker id={id} value={values.classifierModel} onChange={(classifierModel) => onChange({ classifierModel, preferJev: classifierModel === 'decisions' })} classifier />}
		</Field>
		<Field label="OpenAI-compatible base URL (optional)" help="Leave empty for OpenAI. Set it for Azure OpenAI, a proxy, or a local server; those use the Chat Completions API.">
			{(id) => <Input id={id} value={values.openaiBaseUrl} onChange={(event) => onChange({ openaiBaseUrl: event.target.value.trim() })} placeholder="https://api.openai.com/v1" spellCheck={false} />}
		</Field>
	</>;
}

function ModelCheckLine({ checking, check }: { checking: boolean; check?: ProviderCheck }) {
	if (checking) return <p role="status" className="-mt-3 text-caption text-fg-subtle">Testing this model…</p>;
	if (!check) return null;
	return <p role={check.ok ? 'status' : 'alert'} className={`-mt-3 text-caption ${check.ok ? 'text-success' : 'text-danger'}`}>{check.ok ? 'This model works with your key.' : check.message ?? 'This model did not respond.'}</p>;
}

/** Offered only when this browser still holds sheets from before workspaces were shared. */
function LegacySheetsImport() {
	const { toast } = useToast();
	const [available, setAvailable] = useState(false);
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		let cancelled = false;
		void Dexie.exists(accountStorageKey('enrichable')).then((exists) => { if (!cancelled) setAvailable(exists); }, () => {});
		return () => { cancelled = true; };
	}, []);
	if (!available) return null;
	return (
		<section className="glass-card flex flex-col items-start justify-between gap-4 px-5 py-4 sm:flex-row sm:items-center">
			<div className="flex min-w-0 flex-col gap-0.5"><span className="text-body-sm text-fg">Import my previous local sheets</span><span className="text-caption text-fg-subtle">This browser has sheets saved before workspaces were shared.</span></div>
			<Button size="sm" onClick={() => setOpen(true)}>Import local sheets</Button>
			{open && <ConfirmDialog title="Share your local sheets with your workspace?" description="Your previous local sheets are copied to the cloud, where everyone in your workspace can view, edit, and delete them. The 10-sheet and 1,000-row limits apply. Original local copies stay intact." confirmLabel="Import and share" loading={busy} onClose={() => { if (!busy) setOpen(false); }} onConfirm={async () => {
				setBusy(true);
				try { const count = await importMyLocalSheets(); toast(count ? `Imported ${count} sheets` : 'No new local sheets to import.', 'success'); setOpen(false); }
				catch (cause) { toast(cause instanceof Error ? cause.message : 'Could not import local sheets.', 'error'); }
				finally { setBusy(false); }
			}} />}
		</section>
	);
}
