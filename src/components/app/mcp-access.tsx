'use client';

import { useState, useSyncExternalStore } from 'react';
import { accountHeaders } from '@/lib/account-storage';
import { liveStore, useLiveStore } from '@/lib/live-store';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { useSettings } from './settings-context';
import { formatExpiry, mcpConfig, type Connection } from './providers';

type KeyInfo = { prefix: string; version: string; createdAt: number; recoverable?: boolean; secret?: string };
type AgentKey = KeyInfo & { created: string };
type Busy = 'create' | 'copy' | 'reveal' | 'rotate';

async function keyRequest(method: 'GET' | 'POST' | 'PATCH', options: { reveal?: boolean; version?: string; signal?: AbortSignal } = {}): Promise<KeyInfo | null> {
	const response = await fetch(`/api/mcp-key${options.reveal ? '?reveal=1' : ''}`, { method, cache: 'no-store', signal: options.signal, headers: { ...accountHeaders(), ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) }, ...(method === 'GET' ? {} : { body: JSON.stringify(options.version ? { version: options.version } : {}) }) });
	if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || 'Could not reach agent access. Try again.');
	return (await response.json()).key ?? null;
}

// Keys only ever arrive in the browser, so their date is formatted once there instead of in render.
const withCreated = (key: KeyInfo | null): AgentKey | null => key && { ...key, created: new Date(key.createdAt).toLocaleDateString() };
/** The workspace's agent key while Settings shows it. Revealed secrets are dropped with it when the page closes. */
const agentKey = liveStore<{ status: 'loading' } | { status: 'failed'; error: string } | { status: 'ready'; key: AgentKey | null }>({ status: 'loading' }, ({ signal, set }) => {
	keyRequest('GET', { signal }).then((key) => set({ status: 'ready', key: withCreated(key) }), (cause: Error) => set({ status: 'failed', error: cause.message }));
});
const setKey = (key: KeyInfo | null) => agentKey.set({ status: 'ready', key: withCreated(key) });
const subscribeNothing = () => () => {};
const useEndpoint = () => useSyncExternalStore(subscribeNothing, () => `${window.location.origin}/mcp`, () => '/mcp');

export function McpAccess() {
	const { selfHosted, connections } = useSettings();
	const load = useLiveStore(agentKey);
	const key = load.status === 'ready' ? load.key : null;
	const [busy, setBusy] = useState<Busy | null>(null);
	const [actionError, setActionError] = useState('');
	const [confirmRotate, setConfirmRotate] = useState(false);
	const [copied, setCopied] = useState(false);
	const [visible, setVisible] = useState(false);
	const endpoint = useEndpoint();
	const error = load.status === 'failed' ? load.error : actionError;
	const secret = visible ? key?.secret : undefined;
	async function run(action: Busy, task: () => Promise<void>) {
		setBusy(action); setActionError(''); setCopied(false);
		try { await task(); } catch (cause) { setActionError(cause instanceof Error ? cause.message : 'Could not update agent access.'); }
		finally { setBusy(null); }
	}
	const issue = (rotate: boolean) => run(rotate ? 'rotate' : 'create', async () => { setKey(await keyRequest(rotate ? 'PATCH' : 'POST', { version: key?.version })); setVisible(true); setConfirmRotate(false); });
	const copyConfig = () => run('copy', async () => { const revealed = await keyRequest('GET', { reveal: true }); await navigator.clipboard.writeText(mcpConfig(endpoint, revealed?.secret, selfHosted)); setCopied(true); });
	const reveal = () => run('reveal', async () => { setKey(await keyRequest('GET', { reveal: true })); setVisible(true); });
	function hide() { setVisible(false); if (key) setKey({ ...key, secret: undefined }); }
	return <section className="glass-card flex min-w-0 flex-col gap-4 px-5 py-5" aria-labelledby="mcp-access-title">
		<div className="flex flex-col gap-1">
			<h2 id="mcp-access-title" className="text-body text-fg">Agent access</h2>
			<p className="text-body-sm text-fg-muted">Connect Claude, Cursor, or any MCP client to this workspace’s sheets and enrichment tools. One agent key works for every agent; rotating it replaces it everywhere.</p>
		</div>
		{load.status === 'loading' && <p className="text-caption text-fg-subtle">Loading agent key…</p>}
		{load.status === 'failed' && <Button size="sm" className="self-start" onClick={() => window.location.reload()}>Refresh</Button>}
		{load.status === 'ready' && (key
			? <AgentKeyActions agentKey={key} busy={busy} visible={visible} onCopy={() => void copyConfig()} onToggle={() => visible ? hide() : void reveal()} onRotate={() => setConfirmRotate(true)} />
			: <Button size="sm" variant="brand" className="self-start" loading={busy === 'create'} onClick={() => void issue(false)}>Create agent key</Button>)}
		{copied && <p role="status" className="text-body-sm text-fg">MCP config copied{selfHosted ? '. Replace the two provider key placeholders before using it.' : '.'}</p>}
		{error && <p role="alert" className="text-body-sm text-danger">{error}</p>}
		{key?.recoverable === false && <p className="text-caption text-fg-subtle">This older key needs a verified backfill by your server administrator before it can be retrieved. Rotation creates a recoverable replacement.</p>}
		{secret && <code className="break-all rounded-lg border border-line-subtle p-3 text-body-sm select-all">{secret}</code>}
		<AgentConnectionNote selfHosted={selfHosted} context={connections.context} />
		<details className="text-body-sm text-fg-muted">
			<summary className="cursor-pointer">View config</summary>
			<div className="mt-3 flex flex-col gap-2">
				<span className="text-caption">Endpoint <code className="break-all font-mono text-fg select-all">{endpoint}</code></span>
				<pre className="max-w-full overflow-x-auto rounded-lg border border-line-subtle p-3 text-caption">{mcpConfig(endpoint, secret, selfHosted)}</pre>
			</div>
		</details>
		{confirmRotate && <ConfirmDialog title="Rotate the agent key?" description="Every agent using the current key loses access for new requests. Update each agent with the new key. Requests already running may finish." confirmLabel="Rotate key" loading={busy === 'rotate'} onClose={() => { if (!busy) setConfirmRotate(false); }} onConfirm={() => issue(true)} />}
	</section>;
}

function AgentKeyActions({ agentKey, busy, visible, onCopy, onToggle, onRotate }: { agentKey: AgentKey; busy: Busy | null; visible: boolean; onCopy: () => void; onToggle: () => void; onRotate: () => void }) {
	return <>
		<div className="flex flex-wrap gap-2">
			<Button size="sm" variant="brand" loading={busy === 'copy'} disabled={busy !== null} onClick={onCopy}>Copy MCP config</Button>
			<Button size="sm" loading={busy === 'reveal'} disabled={busy !== null} onClick={onToggle}>{visible ? 'Hide key' : 'Show key'}</Button>
			<Button size="sm" variant="ghost" disabled={busy !== null} onClick={onRotate}>Rotate key</Button>
		</div>
		<p className="text-caption text-fg-subtle">Agent key <span className="font-mono">{agentKey.prefix}…</span> · created {agentKey.created}</p>
	</>;
}

function AgentConnectionNote({ selfHosted, context }: { selfHosted: boolean; context: Connection }) {
	if (selfHosted) return <p className="text-caption text-fg-subtle"><span className="font-medium text-fg-muted">Required:</span> agents must send <code className="font-mono">x-openai-key</code> and <code className="font-mono">x-context-key</code> headers. Keys you saved here stay in this browser, so agents can’t use them.</p>;
	if (context.source === 'signin' && context.expiresAt) return <p className="text-caption text-fg-subtle">Agents use your workspace’s Context.dev sign-in, which {formatExpiry(context.expiresAt)}. For always-on agents, add a Context.dev API key in Connections.</p>;
	return <p className="text-caption text-fg-subtle">Agents use your workspace’s connections and defaults.</p>;
}
