import 'server-only';

// Keep error diagnostics explicit: driver objects can contain SQL, parameters and credentials.
function redact(value: string): string {
	let text = value;
	for (const [key, secret] of Object.entries(process.env)) {
		if (secret && secret.length >= 4 && /DATABASE_URL|KEY|SECRET|TOKEN|PASSWORD/i.test(key)) text = text.split(secret).join('[redacted]');
	}
	return text
		.replace(/(?:postgres(?:ql)?|https?|wss?):\/\/[^\s'"<>]+/gi, '[redacted URL]')
		.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
		.replace(/\b(password|token|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]')
		.slice(0, 6000);
}

export function storageErrorDetails(error: unknown, seen = new Set<object>(), depth = 0): Record<string, unknown> {
	if (depth >= 5) return { truncated: true };
	if (!error || typeof error !== 'object') return { message: redact(String(error)) };
	if (seen.has(error)) return { circular: true };
	seen.add(error);
	const source = error as Record<string, unknown>;
	const details: Record<string, unknown> = {};
	for (const key of ['name', 'message', 'stack', 'code', 'errno', 'syscall', 'address', 'port', 'severity', 'routine']) {
		if (typeof source[key] === 'string') details[key] = redact(source[key]);
		else if (typeof source[key] === 'number') details[key] = source[key];
	}
	for (const key of ['cause', 'sourceError', 'error']) {
		if (source[key] !== undefined) details[key] = storageErrorDetails(source[key], seen, depth + 1);
	}
	if (Array.isArray(source.errors)) details.errors = source.errors.slice(0, 8).map((entry) => storageErrorDetails(entry, seen, depth + 1));
	return details;
}

export function logWorkspaceError(error: unknown, context: { requestId: string; operation: string; phase: string; durationMs: number }) {
	// A single serialized argument preserves nested details in Next's development log file.
	console.error(JSON.stringify({ event: 'workspace.storage.error', timestamp: new Date().toISOString(), ...context, error: storageErrorDetails(error) }));
}
