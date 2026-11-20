'use client';

import { useId, useState, useSyncExternalStore } from 'react';
import type { CollaborationStatus } from '@/lib/collaboration';
import { collaborationStore } from '@/lib/realtime-client';

function CollaboratorAvatar({ name, color }: { name: string; color: string }) {
	const tooltipId = useId();
	const [visible, setVisible] = useState(false);
	return <span className="relative inline-flex shrink-0" onMouseEnter={() => setVisible(true)} onMouseLeave={() => setVisible(false)}>
		<button
			type="button"
			aria-label={`${name} is viewing this sheet`}
			aria-describedby={visible ? tooltipId : undefined}
			onFocus={() => setVisible(true)}
			onBlur={() => setVisible(false)}
			onClick={() => setVisible(true)}
			onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setVisible(false); } }}
			className="grid size-6 place-items-center rounded-full border-2 border-surface text-[10px] font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2"
			style={{ background: color, outlineColor: color }}
		>
			{name === 'You (another tab)' ? 'Y' : name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()}
		</button>
		{visible && <span id={tooltipId} role="tooltip" className="absolute top-full right-0 z-50 w-max max-w-48 pt-2">
			<span className="block rounded-md px-2.5 py-1.5 text-caption font-medium break-words text-white shadow-floating" style={{ background: color }}>{name}</span>
		</span>}
	</span>;
}

// Polling is also the steady state when a deployment has no realtime, so only being offline reads as a problem.
const CONNECTION: Record<CollaborationStatus, { label: string; tone: string }> = {
	connecting: { label: 'Connecting to live updates…', tone: 'bg-neutral-30' },
	live: { label: 'Live: edits sync instantly', tone: 'bg-success' },
	reconnecting: { label: 'Reconnecting to live updates…', tone: 'bg-neutral-30' },
	polling: { label: 'Checking for edits periodically', tone: 'bg-neutral-30' },
	offline: { label: 'Offline: edits sync when you reconnect', tone: 'bg-warning' },
	paused: { label: 'Live updates paused while this tab is hidden', tone: 'bg-neutral-30' },
};

/** Teammates viewing this sheet. */
export function CollaborationBar() {
	const { peers: people, status } = useSyncExternalStore(collaborationStore.subscribe, collaborationStore.getSnapshot, collaborationStore.getServerSnapshot);
	const connection = CONNECTION[status];
	return <div className="flex items-center gap-2" aria-label="Sheet collaboration" data-collaboration-status={status}>
		<span role="img" aria-label={connection.label} title={connection.label} className={`grid size-5 place-items-center ${status === 'offline' ? '' : 'max-md:hidden'}`}><span className={`size-1.5 rounded-full transition-colors ${connection.tone}`} /></span>
		{people.length > 0 && <div className="flex -space-x-1" aria-label={`${people.length} other collaborator${people.length === 1 ? '' : 's'}`}>
			{people.slice(0, 4).map((peer) => <CollaboratorAvatar key={peer.client_id} name={peer.name} color={peer.color} />)}
			{people.length > 4 && <span className="grid size-6 place-items-center rounded-full bg-neutral-10 text-caption text-fg">+{people.length - 4}</span>}
		</div>}
	</div>;
}
