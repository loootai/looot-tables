'use client';

import { notifyContextRequest } from './context-credits';
import { notifyTrialLimit } from './ai-trial';
import { ApiError, parseFailure, readError } from './api';
import { keyHeaders } from './keys';
import type { PopulateEvent, PopulateRequest } from './types';

/** Newline-delimited lines of a streamed body, ending with any unterminated tail. */
async function* ndjsonLines(body: ReadableStream<Uint8Array>) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		yield* lines;
	}
	yield buffer + decoder.decode();
}

/**
 * Stream rows from the populate agent. `completed` is true only when the server sent its `done` event:
 * a body that simply ends (cut connection, function timeout) is not a finished search.
 */
export async function streamPopulate(request: PopulateRequest, onEvent: (event: PopulateEvent) => void | Promise<void>, signal?: AbortSignal): Promise<{ completed: boolean }> {
	// Discovery can perform several Context requests between streamed row events.
	const timer = setInterval(notifyContextRequest, 2_000);
	let completed = false;
	const handle = async (line: string) => {
		if (!line.trim()) return;
		let event: PopulateEvent;
		try { event = JSON.parse(line) as PopulateEvent; }
		catch { return; }
		if (event.type === 'error') {
			const failure = parseFailure(event.failure);
			notifyTrialLimit(event.message, failure);
			throw new ApiError(event.message, 0, failure);
		}
		if (event.type === 'done') completed = true;
		await onEvent(event);
	};
	try {
		const response = await fetch('/api/populate', { method: 'POST', headers: keyHeaders(), body: JSON.stringify(request), signal });
		if (!response.ok) throw await readError(response);
		if (!response.body) throw new ApiError(`Request failed (${response.status})`, response.status);
		// Events apply strictly in order; the next chunk is read only after the previous lines are handled.
		for await (const line of ndjsonLines(response.body)) await handle(line);
		return { completed };
	} finally {
		clearInterval(timer);
		notifyContextRequest();
	}
}
