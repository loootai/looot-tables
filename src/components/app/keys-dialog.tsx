'use client';

import Image from 'next/image';
import { useMemo, useState, type ReactNode } from 'react';
import { CheckCircle2, ExternalLink, XCircle } from 'lucide-react';
import { trackEvent } from '@/lib/analytics';
import type { Settings } from '@/lib/keys';
import { providerField, type Provider } from '@/lib/organization-settings';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { useSettings } from './settings-context';
import { CONNECTION_ORDER, isConfigured, isReady, LOGOLINK_URL, PROVIDER_INFO, reconnectContext, type Connection } from './providers';
import { providerCheck, useVerification, type ProviderCheck } from './use-verification';

export function ProviderLogo({ provider }: { provider: Provider }) {
	return <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line-subtle bg-white"><Image src={PROVIDER_INFO[provider].logo} alt="" width={20} height={20} className="size-5 object-contain" /></span>;
}

/** Live check result under a key field. Never blocks saving. */
function CheckLine({ checking, check, error, provider }: { checking: boolean; check?: ProviderCheck; error?: string; provider: Provider }) {
	if (checking) return <p role="status" className="text-caption text-fg-subtle">Checking…</p>;
	if (error) return <p role="status" className="text-caption text-fg-subtle">{error}</p>;
	if (!check) return null;
	if (check.ok) return <p role="status" className="flex items-center gap-1 text-caption text-success"><CheckCircle2 aria-hidden="true" className="size-3.5" />Connected{check.credits !== undefined ? ` · ${check.credits.toLocaleString()} credits` : ''}</p>;
	return <>
		<p role="alert" className="flex items-start gap-1 text-caption text-danger"><XCircle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />{check.message ?? `${PROVIDER_INFO[provider].name} rejected this key.`}</p>
		{provider === 'openai' && check.issue === 'billing' && <a href="https://platform.openai.com/settings/organization/billing/overview" target="_blank" rel="noopener noreferrer" className="text-caption text-brand hover:underline">Open OpenAI billing <ExternalLink aria-hidden="true" className="inline size-3" /></a>}
	</>;
}

function KeyField({ label, link, value, onChange, placeholder, help, required, autoFocus }: { label: string; link?: string; value: string; onChange: (value: string) => void; placeholder: string; help?: string; required?: boolean; autoFocus?: boolean }) {
	return (
		<Field label={label} required={required} help={help} labelAction={link && <a href={link} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 text-caption text-brand hover:underline">Get a key <ExternalLink aria-hidden="true" className="size-3" strokeWidth={1.75} /></a>}>
			{(id) => <Input id={id} aria-label={label} autoFocus={autoFocus} required={required} type="password" autoComplete="off" spellCheck={false} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />}
		</Field>
	);
}

function ProviderCard({ provider, status, children }: { provider: Provider; status?: ReactNode; children?: ReactNode }) {
	return (
		<section aria-label={PROVIDER_INFO[provider].name} className="rounded-xl border border-line-subtle bg-surface">
			<div className="flex items-center gap-3 px-3 py-2.5">
				<ProviderLogo provider={provider} />
				<span className="min-w-0 flex-1"><span className="block text-body-sm font-medium text-fg">{PROVIDER_INFO[provider].name}</span><span className="block text-caption text-fg-subtle">{PROVIDER_INFO[provider].description}</span></span>
				{status}
			</div>
			{children && <div className="flex flex-col gap-2 border-t border-line-subtle px-4 py-3">{children}</div>}
		</section>
	);
}

const ConnectedBadge = () => <span className="inline-flex shrink-0 items-center gap-1 text-caption text-success"><CheckCircle2 aria-hidden="true" className="size-3.5" />Connected</span>;

/** Configured providers after a save, for analytics. */
function configuredCount(connections: Record<Provider, Connection>, patch: Partial<Settings>) {
	return CONNECTION_ORDER.filter((provider) => isConfigured(connections[provider]) || Boolean(patch[providerField[provider]])).length;
}

/** A provider's key field with a live check of only that provider, so typing one key never repeats another's billed OpenAI inference test. */
function VerifiedKeyField({ provider, value, onChange, required, autoFocus, help }: { provider: Provider; value: string; onChange: (value: string) => void; required?: boolean; autoFocus?: boolean; help?: string }) {
	const { settings } = useSettings();
	const info = PROVIDER_INFO[provider];
	const trimmed = value.trim();
	const field = providerField[provider];
	const draft = useMemo(() => ({ ...settings, [field]: trimmed }) as Settings, [settings, field, trimmed]);
	const verification = useVerification(draft, trimmed && info.verifiable ? [provider] : [], { inference: provider === 'openai' });
	return <>
		<KeyField label={`${info.name} API key`} required={required} link={info.link} value={value} onChange={onChange} placeholder={info.placeholder} autoFocus={autoFocus} help={help} />
		<CheckLine provider={provider} checking={verification.checking} check={providerCheck(verification.result, provider)} error={verification.error} />
	</>;
}

type Workspace = ReturnType<typeof useSettings>;

/** What first-run setup asks for, given the workspace's connections and the trimmed keys typed so far. */
function setupNeeds({ connections, trialLimitMessage, contextSignIn, selfHosted, server }: Workspace, typed: { contextKey: string; openaiKey: string; password: string }) {
	const askContext = !isReady(connections.context);
	const askOpenAI = !isReady(connections.openai) || Boolean(trialLimitMessage);
	// Hosted members reconnect their Context.dev sign-in; they never need to find an API key.
	const contextByReconnect = askContext && contextSignIn;
	const showPassword = selfHosted && Boolean(server?.passwordRequired);
	const usePassword = showPassword && Boolean(typed.password);
	const missingContext = askContext && !contextByReconnect && !typed.contextKey && !usePassword;
	const missingOpenAI = askOpenAI && !typed.openaiKey && !(usePassword && !trialLimitMessage);
	let title = 'Set up enrichment';
	if (trialLimitMessage && !askContext) title = 'Add your OpenAI API key';
	else if (contextByReconnect && !askOpenAI) title = 'Reconnect Context.dev';
	return { askContext, askOpenAI, contextByReconnect, showPassword, usePassword, title, missing: missingContext || missingOpenAI, typeable: (askContext && !contextByReconnect) || askOpenAI || showPassword };
}

/** First run and key-requiring actions: only the two required connections, saved without waiting for live checks. */
export function KeysDialog({ onClose }: { onClose: () => void }) {
	const workspace = useSettings();
	const { settings, update, trialLimitMessage, selfHosted, connections, workspaceName } = workspace;
	const [contextKey, setContextKey] = useState('');
	const [openaiKey, setOpenaiKey] = useState('');
	const [password, setPassword] = useState(settings.accessPassword);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState('');
	const needs = setupNeeds(workspace, { contextKey: contextKey.trim(), openaiKey: openaiKey.trim(), password: password.trim() });

	async function save() {
		setSaving(true); setSaveError('');
		const patch: Partial<Settings> = {};
		if (contextKey.trim()) patch.contextKey = contextKey.trim();
		if (openaiKey.trim()) patch.openaiKey = openaiKey.trim();
		if (needs.showPassword && password.trim() !== settings.accessPassword) patch.accessPassword = password.trim();
		try {
			await update(patch);
			trackEvent('keys_saved', { providers: configuredCount(connections, patch) });
			onClose();
		} catch (error) { setSaveError(error instanceof Error ? error.message : 'Could not save your connections.'); }
		finally { setSaving(false); }
	}

	return (
		<Dialog
			title={needs.title}
			description={selfHosted ? 'Context.dev finds and researches the web; OpenAI writes the answers. Keys stay in this browser.' : `Connections are shared with everyone in ${workspaceName || 'your workspace'}.`}
			onClose={onClose}
			size="lg"
			footer={needs.typeable ? <Button variant="brand" size="sm" loading={saving} disabled={needs.missing} onClick={() => void save()}>Save and start</Button> : <Button size="sm" onClick={onClose}>Not now</Button>}
		>
			<div className="flex flex-col gap-3">
				{trialLimitMessage && <p role="alert" className="rounded-lg bg-warning-soft px-3 py-2 text-body-sm text-fg">{trialLimitMessage}</p>}
				<ProviderCard provider="context" status={needs.askContext ? undefined : <ConnectedBadge />}>
					{needs.contextByReconnect ? <ContextReconnect expired={connections.context.state === 'expired'} /> : needs.askContext && <VerifiedKeyField provider="context" required={!needs.usePassword} value={contextKey} onChange={setContextKey} autoFocus />}
				</ProviderCard>
				<ProviderCard provider="openai" status={needs.askOpenAI ? undefined : <OpenAIStatus included={connections.openai.state === 'included'} />}>
					{needs.askOpenAI && <VerifiedKeyField provider="openai" required={!needs.usePassword || Boolean(trialLimitMessage)} value={openaiKey} onChange={setOpenaiKey} autoFocus={!needs.askContext || needs.contextByReconnect} />}
				</ProviderCard>
				{needs.showPassword && <Field label="Deployment password" help="Use the keys this deployment provides instead of your own.">{(id) => <Input id={id} type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} />}</Field>}
				<p className="text-caption text-fg-subtle">Optional providers, like email finders, live in Configuration → Connections.</p>
				{saveError && <p role="alert" className="text-body-sm text-danger">{saveError}</p>}
			</div>
		</Dialog>
	);
}

function ContextReconnect({ expired }: { expired: boolean }) {
	return <>
		<p className="text-body-sm text-fg-muted">{expired ? 'Your Context.dev connection expired.' : 'Context.dev isn’t connected for this workspace.'} Reconnect to keep enriching. You’ll come right back here.</p>
		<Button variant="brand" size="sm" className="self-start" onClick={reconnectContext}>Reconnect Context.dev</Button>
	</>;
}

const OpenAIStatus = ({ included }: { included: boolean }) => included ? <span className="shrink-0 text-caption text-fg-subtle">Included trial</span> : <ConnectedBadge />;

/** Dialog copy for Configuration → Connections: the Logo Link override, or connecting/replacing a provider key. */
function connectionCopy(provider: Provider, section: 'key' | 'logolink', replacing: boolean, selfHosted: boolean) {
	const info = PROVIDER_INFO[provider];
	if (section === 'logolink') return { title: 'Logo Link key', description: 'Logos in sheets load through Context.dev Logo Link.' };
	return { title: `${replacing ? 'Replace' : 'Connect'} ${info.name}`, description: `${info.description}. ${selfHosted ? 'Saved in this browser.' : 'Encrypted and shared with your workspace.'}` };
}

/** Configuration → Connections: add or replace one provider's key. `logolink` edits only the Context.dev Logo Link client ID. */
export function ConnectionDialog({ provider, section = 'key', onClose }: { provider: Provider; section?: 'key' | 'logolink'; onClose: () => void }) {
	const { settings, update, connections, logolinkPublicId, selfHosted } = useSettings();
	const info = PROVIDER_INFO[provider];
	const [key, setKey] = useState('');
	const [logolinkKey, setLogolinkKey] = useState(settings.logolinkKey);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState('');
	const trimmed = key.trim();
	const field = providerField[provider];
	const logoChanged = provider === 'context' && logolinkKey.trim() !== settings.logolinkKey;
	const copy = connectionCopy(provider, section, isConfigured(connections[provider]), selfHosted);
	const logoField = <KeyField label="Logo Link key (optional override)" link={LOGOLINK_URL} value={logolinkKey} onChange={setLogolinkKey} placeholder="brandLL_…" autoFocus={section === 'logolink'} help={logolinkPublicId ? 'Leave empty to use your workspace’s Logo Link client ID.' : 'A Logo Link public client ID from your Context.dev dashboard.'} />;

	async function save() {
		setSaving(true); setSaveError('');
		const patch: Partial<Settings> = {};
		if (trimmed) patch[field] = trimmed;
		if (logoChanged) patch.logolinkKey = logolinkKey.trim();
		try {
			await update(patch);
			if (trimmed) trackEvent('keys_saved', { providers: configuredCount(connections, patch) });
			onClose();
		} catch (error) { setSaveError(error instanceof Error ? error.message : 'Could not save this connection.'); }
		finally { setSaving(false); }
	}

	return (
		<Dialog
			title={copy.title}
			description={copy.description}
			onClose={onClose}
			footer={<Button variant="brand" size="sm" loading={saving} disabled={!trimmed && !logoChanged} onClick={() => void save()}>Save</Button>}
		>
			<div className="flex flex-col gap-3">
				{section === 'logolink' ? logoField : <>
					<VerifiedKeyField provider={provider} required={provider !== 'context' || !logoChanged} value={key} onChange={setKey} autoFocus help={info.verifiable ? undefined : 'Checked on your first lookup; billed through your provider plan.'} />
					{provider === 'context' && <details className="group/advanced text-body-sm"><summary className="cursor-pointer text-caption text-fg-muted hover:text-fg">Advanced</summary><div className="pt-3">{logoField}</div></details>}
				</>}
				{saveError && <p role="alert" className="text-body-sm text-danger">{saveError}</p>}
			</div>
		</Dialog>
	);
}
