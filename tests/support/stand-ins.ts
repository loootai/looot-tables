import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

/** A free local port. */
export function freePort(): Promise<number> {
	return new Promise((done, fail) => {
		const server = createServer();
		server.once('error', fail);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as { port: number };
			server.close(() => done(port));
		});
	});
}

/** Start one of the stand-ins in scripts/ (mock-looot.mjs, mock-moltsets.mjs) on free ports and wait until it listens. */
export async function startStandIn(script: 'mock-looot.mjs' | 'mock-moltsets.mjs', args: string[] = []): Promise<{ url: string; port: number; stop(): void; log(): Promise<Record<string, unknown>> }> {
	const port = await freePort();
	const env = { ...process.env, MOCK_LOOOT_PORT: String(port), MOCK_MOLTSETS_PORT: String(port), MOCK_ATTEMPT_MS: '0' };
	const child: ChildProcess = spawn(process.execPath, [resolve('scripts', script), ...args], { env, stdio: ['ignore', 'pipe', 'inherit'] });
	await new Promise<void>((done, fail) => {
		const timer = setTimeout(() => fail(new Error(`${script} did not start`)), 10_000);
		child.stdout!.on('data', (chunk: Buffer) => { if (/on http/.test(chunk.toString())) { clearTimeout(timer); done(); } });
		child.once('exit', (code) => { clearTimeout(timer); fail(new Error(`${script} exited with ${code}`)); });
	});
	const url = `http://127.0.0.1:${port}`;
	return { url, port, stop: () => { child.kill(); }, log: async () => (await fetch(`${url}/__log`)).json() as Promise<Record<string, unknown>> };
}
