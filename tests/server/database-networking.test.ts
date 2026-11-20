import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { getDefaultResultOrder } from 'node:dns';
import { neonConfig } from '@neondatabase/serverless';
import WebSocket, { WebSocketServer } from 'ws';

test('database HTTP and WebSocket transports reach an IPv4 listener through localhost without changing global networking', { timeout: 10_000 }, async (t) => {
	const originalFetch = globalThis.fetch;
	const originalDnsOrder = getDefaultResultOrder();
	await import('../../src/lib/server/database');
	const server = createServer(async (request, response) => {
		let body = '';
		for await (const chunk of request) body += chunk;
		response.setHeader('Content-Type', 'application/json');
		response.end(JSON.stringify({ method: request.method, body }));
	});
	const websocketServer = new WebSocketServer({ server });
	websocketServer.on('connection', (socket) => socket.send('connected'));
	t.after(async () => {
		for (const socket of websocketServer.clients) socket.terminate();
		websocketServer.close();
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	const response = await neonConfig.fetchFunction(`http://localhost:${address.port}/sql`, { method: 'POST', body: 'query', signal: AbortSignal.timeout(3000) });
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { method: 'POST', body: 'query' });
	const socket = new neonConfig.webSocketConstructor!(`ws://localhost:${address.port}`);
	assert.ok(socket instanceof WebSocket);
	const [message] = await once(socket, 'message');
	assert.equal(message.toString(), 'connected');
	socket.close();
	await once(socket, 'close');
	assert.equal(globalThis.fetch, originalFetch);
	assert.equal(getDefaultResultOrder(), originalDnsOrder);
});
