'use client';

export const CONTEXT_REQUEST_EVENT = 'enrichable:context-request';

export function notifyContextRequest() {
	if (typeof window !== 'undefined') window.dispatchEvent(new Event(CONTEXT_REQUEST_EVENT));
}

/** Refresh usage after successes and failures, which can also consume credits. */
export async function contextRequest(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	try {
		return await fetch(input, init);
	} finally {
		notifyContextRequest();
	}
}
