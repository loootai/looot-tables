type Politeness = 'polite' | 'assertive';
type AriaNotify = (message: string, options?: { priority?: 'normal' | 'high' }) => void;

const regions = new Map<Politeness, HTMLElement>();
let lastMessage = '';

function liveRegion(politeness: Politeness) {
	const existing = regions.get(politeness);
	if (existing?.isConnected) return existing;
	const node = document.createElement('div');
	node.setAttribute('aria-live', politeness);
	node.setAttribute('aria-atomic', 'true');
	node.setAttribute('data-announcer', politeness);
	node.className = 'sr-only';
	document.body.append(node);
	regions.set(politeness, node);
	return node;
}

/** Mounts the shared live regions early: a region inserted together with its first message is often not read. */
export function prepareAnnouncer() {
	if (typeof document === 'undefined' || 'ariaNotify' in document) return;
	liveRegion('polite');
	liveRegion('assertive');
}

/** Speaks a status message without moving focus. Uses `document.ariaNotify` where available, otherwise one shared live region per politeness.
 * Returns a cancel function so a caller can drop a message that is superseded before its delay passes. */
export function announce(message: string, { assertive = false, delay = 100 }: { assertive?: boolean; delay?: number } = {}): () => void {
	const text = message.trim();
	if (!text || typeof document === 'undefined') return () => {};
	const notify = (document as Document & { ariaNotify?: AriaNotify }).ariaNotify;
	if (notify) {
		const timer = setTimeout(() => notify.call(document, text, { priority: assertive ? 'high' : 'normal' }), delay);
		return () => clearTimeout(timer);
	}
	const region = liveRegion(assertive ? 'assertive' : 'polite');
	const timer = setTimeout(() => {
		// VoiceOver skips a message identical to the previous one; a trailing no-break space makes it differ silently.
		const spoken = text === lastMessage ? `${text} ` : text;
		lastMessage = spoken;
		region.textContent = spoken;
	}, delay);
	return () => clearTimeout(timer);
}
