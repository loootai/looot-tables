// A tiny OpenAI-compatible mock (Chat Completions) for exercising Enrichable's plumbing without spending tokens.
// It answers structured-output requests with schema-shaped placeholder values and drives tool loops with one
// scripted tool call per available tool before finishing. Run: node scripts/mock-openai.mjs (port 4545).
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 4545);

function fill(schema, name = '') {
	if (!schema || typeof schema !== 'object') return null;
	if (schema.anyOf) return fill(schema.anyOf.find((s) => s.type !== 'null') ?? schema.anyOf[0], name);
	if (schema.oneOf) return fill(schema.oneOf[0], name);
	if (schema.const !== undefined) return schema.const;
	if (schema.enum) return schema.enum[0];
	const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
	switch (type) {
		case 'object': {
			const out = {};
			for (const [key, value] of Object.entries(schema.properties ?? {})) out[key] = fill(value, key);
			return out;
		}
		case 'array':
			return name === 'sources' ? ['https://example.com/mock-source'] : [fill(schema.items, name)];
		case 'number':
		case 'integer':
			return name === 'confidence' || name === 'probability' ? 0.83 : 42;
		case 'boolean':
			return true;
		case 'string':
			return name === 'name' ? 'Mock column' : name === 'reasoning' || name === 'rationale' ? 'Mock reasoning from the fake model.' : `mock ${name || 'text'}`;
		default:
			return null;
	}
}

function scriptedToolCalls(tools, messages) {
	const called = new Set(messages.filter((m) => m.role === 'assistant' && m.tool_calls).flatMap((m) => m.tool_calls.map((c) => c.function.name)));
	const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
	const text = typeof lastUser === 'string' ? lastUser : JSON.stringify(lastUser);
	for (const tool of tools) {
		const name = tool.function.name;
		if (called.has(name)) continue;
		if (name === 'searchCompanies') return [{ name, args: { query: text.match(/Request: (.*)/)?.[1]?.split('\n')[0] ?? 'solar companies in the US' } }];
		if (name === 'searchPeople') return [{ name, args: { query: text.match(/Request: (.*)/)?.[1]?.split('\n')[0] ?? 'founders', mode: 'fast' } }];
		if (name === 'searchWeb') return [{ name, args: { query: text.match(/Request: (.*)/)?.[1]?.split('\n')[0] ?? 'solar', numResults: 10 } }];
		if (name === 'readPage') continue;
		if (name === 'findPage') continue;
	}
	return [];
}

http
	.createServer((req, res) => {
		let body = '';
		req.on('data', (chunk) => (body += chunk));
		req.on('end', () => {
			if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-1', object: 'model' }] }));
			if (!req.url?.includes('/chat/completions')) {
				res.statusCode = 404;
				return res.end(JSON.stringify({ error: { message: `mock: unsupported ${req.url}` } }));
			}
			const request = JSON.parse(body || '{}');
			const tools = request.tools ?? [];
			const calls = tools.length ? scriptedToolCalls(tools, request.messages ?? []) : [];
			let message;
			if (calls.length) {
				message = { role: 'assistant', content: null, tool_calls: calls.map((call, i) => ({ id: `call_${Date.now()}_${i}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) };
			} else if (request.response_format?.type === 'json_schema') {
				message = { role: 'assistant', content: JSON.stringify(fill(request.response_format.json_schema.schema)) };
			} else {
				message = { role: 'assistant', content: 'Mock summary: finished.' };
			}
			const payload = { id: `chatcmpl-mock-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: request.model ?? 'mock-1', choices: [{ index: 0, message, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify(payload));
		});
	})
	.listen(PORT, () => console.log(`mock openai listening on http://localhost:${PORT}/v1`));
