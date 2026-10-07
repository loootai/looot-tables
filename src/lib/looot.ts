export class LoootError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "LoootError";
  }
}

export interface LoootConfig {
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface SearchHit {
  endpointId: string;
  provider?: string;
  name?: string;
  category?: string;
  estimatedPrice?: number | string | null;
}

export interface InspectResult {
  estimatedMaxCost?: number;
  inputSchema?: { properties?: Record<string, { type?: string; description?: string }>; required?: string[] } | null;
  usageHints?: { requiredInputFields?: string[] };
  endpoint?: Record<string, unknown>;
}

export interface LoootRun {
  runId: string;
  status: string;
  result?: unknown;
  normalized?: Record<string, unknown>;
  outcome?: string;
  outcomeReason?: string;
  actualCost?: number | null;
  error?: { code?: string; message?: string } | null;
}

export const TERMINAL_STATUSES = ["completed", "failed", "blocked", "stopped"];

/** Thin client for the five looot REST calls this app needs. Runs on the server only. */
export class LoootClient {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(config: LoootConfig) {
    this.#token = config.token;
    this.#baseUrl = (config.baseUrl ?? "https://api.looot.ai").replace(/\/+$/, "");
    this.#fetch = config.fetch ?? fetch;
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = (json as { error?: { message?: string; code?: string } } | null)?.error;
      throw new LoootError(err?.message ?? `looot returned HTTP ${res.status}`, res.status, err?.code);
    }
    return json as T;
  }

  /** Free. Find endpoints by what you want to do. */
  async search(q: string, limit = 20): Promise<SearchHit[]> {
    const params = new URLSearchParams({ q, limit: String(limit) });
    const data = await this.#request<{ endpoints?: SearchHit[] }>("GET", `/v1/catalog/search?${params}`);
    return data.endpoints ?? [];
  }

  /** Free. Inputs and price of one endpoint or job. */
  inspect(endpointId: string): Promise<InspectResult> {
    return this.#request("GET", `/v1/operations/${encodeURIComponent(endpointId)}`);
  }

  /** Paid. Same key and same input never pays twice. waitSeconds is sent as the ?wait= query. */
  run(endpointId: string, input: Record<string, unknown>, idempotencyKey: string, waitSeconds = 15): Promise<LoootRun> {
    return this.#request("POST", `/v1/runs?wait=${waitSeconds}`, { endpointId, input, idempotencyKey });
  }

  /** Free. Read a run again, for example after it was still pending. */
  getRun(runId: string): Promise<LoootRun> {
    return this.#request("GET", `/v1/runs/${encodeURIComponent(runId)}`);
  }

  /** Free. Prepaid balance. */
  balance(): Promise<{ available: number; topUpUrl?: string | null }> {
    return this.#request("GET", "/v1/balance");
  }
}

/** Build a client from LOOOT_TOKEN. Throws when the token is missing. */
export function loootFromEnv(env: Record<string, string | undefined> = process.env): LoootClient {
  const token = env.LOOOT_TOKEN;
  if (!token) throw new LoootError("LOOOT_TOKEN is not set on the server", 500, "missing_token");
  return new LoootClient({ token, baseUrl: env.LOOOT_API_URL });
}
