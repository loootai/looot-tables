'use client';

export const LOOOT_REQUEST_EVENT = 'looot-tables:looot-request';

export function notifyLoootRequest() {
	if (typeof window !== 'undefined') window.dispatchEvent(new Event(LOOOT_REQUEST_EVENT));
}

/** Refresh the balance after successes and failures, which can also cost money. */
export async function loootRequest(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	try {
		return await fetch(input, init);
	} finally {
		notifyLoootRequest();
	}
}
