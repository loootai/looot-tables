'use client';

import { useMemo, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import clsx from 'clsx';
import type { Provider } from '@/lib/organization-settings';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { MenuButton, type MenuItem } from '@/components/ui/menu';
import { useToast } from '@/components/ui/toast';
import { useSettings } from './settings-context';
import { ConnectionDialog, ProviderLogo } from './keys-dialog';
import { CONNECTION_ORDER, PROVIDER_INFO, REQUIRED_PROVIDERS, type Connection } from './providers';
import { providerCheck, useVerification, type ProviderCheck } from './use-verification';

const TONE = { success: 'text-success', danger: 'text-danger', warning: 'text-warning', muted: 'text-fg-subtle' } as const;

function status(provider: Provider, connection: Connection, check?: ProviderCheck): { text: string; tone: keyof typeof TONE } {
	if (connection.state === 'missing') return { text: connection.detail ?? 'Not connected', tone: (REQUIRED_PROVIDERS as readonly Provider[]).includes(provider) ? 'warning' : 'muted' };
	if (connection.state === 'expired') return { text: 'Expired', tone: 'danger' };
	if (check && !check.ok) return { text: check.message ?? 'Needs attention', tone: 'danger' };
	if (connection.state === 'deployment') return { text: 'Provided by deployment', tone: 'muted' };
	if (connection.state === 'saved' && !check) return { text: 'Saved', tone: 'muted' };
	return { text: 'Connected', tone: 'success' };
}

function detail(provider: Provider, connection: Connection) {
	return connection.state === 'missing' ? PROVIDER_INFO[provider].description : connection.detail ?? PROVIDER_INFO[provider].description;
}

/** Every provider in one list: logo, status, and one action menu. Configured connections are checked (without inference) on load. */
export function Connections() {
	const { settings, connections, organization, server, selfHosted, disconnectProvider, canImportSettings, importSettings } = useSettings();
	const { toast } = useToast();
	const [editing, setEditing] = useState<Provider | null>(null);
	const [disconnecting, setDisconnecting] = useState<Provider | null>(null);
	const [busy, setBusy] = useState(false);
	const [importing, setImporting] = useState(false);
	const [passwordOpen, setPasswordOpen] = useState(false);
	const checkable = useMemo(() => CONNECTION_ORDER.filter((provider) => PROVIDER_INFO[provider].verifiable && connections[provider].state !== 'missing' && connections[provider].state !== 'expired'), [connections]);
	const verification = useVerification(settings, checkable, { version: JSON.stringify([organization?.revision, server]) });

	function actions(provider: Provider, connection: Connection): MenuItem[] {
		const configured = connection.state === 'connected' || connection.state === 'saved' || connection.state === 'expired';
		return [
			{ label: configured ? 'Replace key' : 'Add key', onSelect: () => setEditing(provider) },
			...(configured ? [{ separator: true, label: '' }, { label: 'Disconnect', danger: true, onSelect: () => setDisconnecting(provider) }] : []),
		];
	}

	return (
		<section aria-labelledby="connections-title" className="glass-card flex flex-col px-5 py-2">
			<div className="flex flex-col gap-0.5 border-b border-line-subtle py-3">
				<h2 id="connections-title" className="text-body text-fg">Connections</h2>
				<p className="text-caption text-fg-subtle">{selfHosted ? 'Keys are saved in this browser and sent only with your requests.' : 'Encrypted and shared with everyone in your workspace and its agents.'}</p>
			</div>
			{canImportSettings && <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-subtle py-3"><p className="text-body-sm text-fg-muted">This browser has keys from before workspaces were shared.</p><Button size="sm" onClick={() => setImporting(true)}>Import them</Button></div>}
			<ul className="divide-y divide-line-subtle">
				{CONNECTION_ORDER.map((provider) => {
					const connection = connections[provider];
					const label = status(provider, connection, providerCheck(verification.result, provider));
					return (
						<li key={provider} className="flex items-center gap-3 py-3">
							<ProviderLogo provider={provider} />
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="text-body-sm text-fg">{PROVIDER_INFO[provider].name}</span>
								<span className="truncate text-caption text-fg-subtle">{detail(provider, connection)}</span>
							</div>
							<span className={clsx('max-w-[45%] text-right text-caption break-words', TONE[label.tone])}>
								{label.text}
							</span>
							{connection.state === 'missing'
								? <Button size="xs" onClick={() => setEditing(provider)}>Connect</Button>
								: <MenuButton label={`${PROVIDER_INFO[provider].name} actions`} align="right" items={actions(provider, connection)} className="grid size-7 shrink-0 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-tint/[0.05] hover:text-fg max-md:size-11"><MoreHorizontal aria-hidden="true" className="size-4" /></MenuButton>}
						</li>
					);
				})}
				{selfHosted && server?.passwordRequired && <li className="flex items-center gap-3 py-3">
					<div className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="text-body-sm text-fg">Deployment password</span><span className="text-caption text-fg-subtle">Use the keys this deployment provides.</span></div>
					<span className="text-caption text-fg-subtle">{settings.accessPassword ? 'Saved' : 'Not set'}</span>
					<Button size="xs" onClick={() => setPasswordOpen(true)}>{settings.accessPassword ? 'Change' : 'Add'}</Button>
				</li>}
			</ul>
			{editing && <ConnectionDialog provider={editing} onClose={() => setEditing(null)} />}
			{passwordOpen && <PasswordDialog onClose={() => setPasswordOpen(false)} />}
			{disconnecting && <ConfirmDialog
				title={`Disconnect ${PROVIDER_INFO[disconnecting].name}?`}
				description={selfHosted ? 'The saved key is removed from this browser.' : 'This removes the connection for everyone in your workspace and its agents. It does not revoke the key at the provider.'}
				confirmLabel="Disconnect"
				danger
				loading={busy}
				onClose={() => { if (!busy) setDisconnecting(null); }}
				onConfirm={async () => {
					setBusy(true);
					try { await disconnectProvider(disconnecting); setDisconnecting(null); }
					catch (error) { toast(error instanceof Error ? error.message : 'Could not disconnect.', 'error'); }
					finally { setBusy(false); }
				}}
			/>}
			{importing && <ConfirmDialog
				title="Share this browser’s keys with your workspace?"
				description="Keys and preferences saved in this browser are added to your workspace. Existing connections and settings are not overwritten. The browser copy is removed after a successful import."
				confirmLabel="Import and share"
				loading={busy}
				onClose={() => { if (!busy) setImporting(false); }}
				onConfirm={async () => {
					setBusy(true);
					try { await importSettings(); setImporting(false); toast('Keys imported.', 'success'); }
					catch (error) { toast(error instanceof Error ? error.message : 'Could not import settings.', 'error'); }
					finally { setBusy(false); }
				}}
			/>}
		</section>
	);
}

function PasswordDialog({ onClose }: { onClose: () => void }) {
	const { settings, update } = useSettings();
	const [password, setPassword] = useState(settings.accessPassword);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState('');
	async function save() {
		setSaving(true); setError('');
		try { await update({ accessPassword: password.trim() }); onClose(); }
		catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save the password.'); }
		finally { setSaving(false); }
	}
	return (
		<Dialog title="Deployment password" description="Use the keys this deployment provides instead of your own." onClose={onClose} footer={<Button variant="brand" size="sm" loading={saving} onClick={() => void save()}>Save</Button>}>
			<Field label="Deployment password" error={error}>{(id) => <Input id={id} type="password" autoFocus autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} />}</Field>
		</Dialog>
	);
}
