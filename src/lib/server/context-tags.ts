import 'server-only';
import { contextFetch } from './context-cache';

/** Bind attribution to a client, so concurrent users never share mutable identity. */
export function taggedContextFetch(email?: string, transport: typeof fetch = contextFetch): typeof fetch {
	if (!email) return transport;
	const tag = `enrichable-${email}`;
	return async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (url.origin !== 'https://api.context.dev') return transport(input, init);
		if (request.method === 'GET') {
			const tags = url.searchParams.getAll('tags').flatMap((value) => value.split(','));
			url.searchParams.set('tags', [...new Set([...tags, tag])].join(','));
			return transport(new Request(url, request));
		}
		if (request.headers.get('content-type')?.includes('application/json')) {
			const body = await request.json();
			body.tags = [...new Set([...(body.tags ?? []), tag])];
			const headers = new Headers(request.headers);
			headers.delete('content-length');
			return transport(new Request(request, { headers, body: JSON.stringify(body) }));
		}
		return transport(input, init);
	};
}
