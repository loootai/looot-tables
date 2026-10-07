import { describe, expect, it, vi } from "vitest";
import { LoootClient } from "./looot";
import { runColumnRows, type CellPatch } from "./runner";

type Call = { url: string; method: string; body: Record<string, unknown> | null };

function mockLooot(handler: (call: Call) => { status?: number; json: unknown }) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const { status = 200, json } = handler(call);
    return new Response(JSON.stringify(json), { status });
  });
  return { calls, client: new LoootClient({ token: "test-token", fetch: fetchMock as unknown as typeof fetch }) };
}

function memoryStore() {
  const cells = new Map<string, CellPatch>();
  return {
    cells,
    store: {
      async setCell(rowId: string, columnId: string, patch: CellPatch) {
        const k = `${rowId}:${columnId}`;
        cells.set(k, { ...(cells.get(k) ?? {}), ...patch });
      },
    },
  };
}

const column = { id: "col1", operation_id: "job:people.email.find", input_map: { company_domain: "{{Domain}}" }, output_path: "email" };

describe("runColumnRows", () => {
  it("sends the token, the mapped input and an idempotency key, and stores result and cost", async () => {
    const { calls, client } = mockLooot(() => ({ json: { runId: "run_1", status: "completed", result: { email: "ada@example.com" }, actualCost: 0.05 } }));
    const { cells, store } = memoryStore();
    const summary = await runColumnRows({
      looot: client, store, column, required: ["company_domain"],
      targets: [{ rowId: "r1", values: { Domain: "example.com" } }],
    });
    expect(summary).toEqual({ done: 1, error: 0, pending: 0, costUsd: 0.05 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.looot.ai/v1/runs?wait=15");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toMatchObject({ endpointId: "job:people.email.find", input: { company_domain: "example.com" } });
    expect(String(calls[0].body?.idempotencyKey)).toMatch(/^tables-col1-r1-/);
    expect(cells.get("r1:col1")).toMatchObject({ status: "done", value: "ada@example.com", cost_usd: 0.05, run_id: "run_1" });
  });

  it("polls a run that is still running and stores it when it completes", async () => {
    const { calls, client } = mockLooot((c) =>
      c.method === "POST"
        ? { json: { runId: "run_2", status: "running" } }
        : { json: { runId: "run_2", status: "completed", result: { email: "b@example.com" }, actualCost: 0.02 } },
    );
    const { cells, store } = memoryStore();
    const sleep = vi.fn(async () => {});
    const summary = await runColumnRows({ looot: client, store, column, sleep, targets: [{ rowId: "r1", values: { Domain: "b.example.com" } }] });
    expect(calls.map((c) => c.method + " " + c.url.replace("https://api.looot.ai", ""))).toEqual(["POST /v1/runs?wait=15", "GET /v1/runs/run_2"]);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(summary.done).toBe(1);
    expect(cells.get("r1:col1")?.value).toBe("b@example.com");
  });

  it("leaves a slow run pending with its run id, then re-reads it later without paying again", async () => {
    const first = mockLooot(() => ({ json: { runId: "run_3", status: "queued" } }));
    const { cells, store } = memoryStore();
    const a = await runColumnRows({ looot: first.client, store, column, maxPolls: 1, sleep: async () => {}, targets: [{ rowId: "r1", values: { Domain: "c.example.com" } }] });
    expect(a.pending).toBe(1);
    expect(cells.get("r1:col1")).toMatchObject({ status: "pending", run_id: "run_3" });

    const second = mockLooot(() => ({ json: { runId: "run_3", status: "completed", result: { email: "c@example.com" }, actualCost: 0.03 } }));
    const b = await runColumnRows({ looot: second.client, store, column, targets: [{ rowId: "r1", values: {}, existing: { status: "pending", run_id: "run_3" } }] });
    expect(second.calls.map((c) => c.method)).toEqual(["GET"]);
    expect(b.done).toBe(1);
  });

  it("marks a failed run as an error with the message and no charge", async () => {
    const { client } = mockLooot(() => ({ json: { runId: "run_4", status: "failed", error: { message: "provider said no" } } }));
    const { cells, store } = memoryStore();
    const summary = await runColumnRows({ looot: client, store, column, targets: [{ rowId: "r1", values: { Domain: "d.example.com" } }] });
    expect(summary).toMatchObject({ error: 1, done: 0, costUsd: 0 });
    expect(cells.get("r1:col1")).toMatchObject({ status: "error", error: "provider said no" });
  });

  it("does not call looot when a required input is empty", async () => {
    const { calls, client } = mockLooot(() => ({ json: {} }));
    const { cells, store } = memoryStore();
    const summary = await runColumnRows({ looot: client, store, column, required: ["company_domain"], targets: [{ rowId: "r1", values: { Domain: "" } }] });
    expect(calls).toHaveLength(0);
    expect(summary.error).toBe(1);
    expect(cells.get("r1:col1")?.error).toBe("missing input: company_domain");
  });

  it("turns an HTTP error into an error cell and keeps going with other rows", async () => {
    const { client } = mockLooot((c) =>
      (c.body?.input as { company_domain: string }).company_domain === "bad.example.com"
        ? { status: 402, json: { error: { code: "insufficient_balance", message: "Top up your balance" } } }
        : { json: { runId: "ok", status: "completed", result: { email: "x@example.com" }, actualCost: 0.01 } },
    );
    const { cells, store } = memoryStore();
    const summary = await runColumnRows({
      looot: client, store, column, concurrency: 1,
      targets: [{ rowId: "r1", values: { Domain: "bad.example.com" } }, { rowId: "r2", values: { Domain: "good.example.com" } }],
    });
    expect(summary).toMatchObject({ done: 1, error: 1 });
    expect(cells.get("r1:col1")).toMatchObject({ status: "error", error: "Top up your balance" });
    expect(cells.get("r2:col1")?.status).toBe("done");
  });

  it("uses a fresh idempotency key when retrying an errored cell", async () => {
    const { calls, client } = mockLooot(() => ({ json: { runId: "r", status: "completed", result: { email: "x" }, actualCost: 0 } }));
    const { store } = memoryStore();
    const target = { rowId: "r1", values: { Domain: "e.example.com" } };
    await runColumnRows({ looot: client, store, column, targets: [target] });
    await runColumnRows({ looot: client, store, column, targets: [{ ...target, existing: { status: "error", run_id: null } }] });
    expect(calls[0].body?.idempotencyKey).not.toBe(calls[1].body?.idempotencyKey);
  });
});

describe("LoootClient", () => {
  it("searches and inspects with the bearer token", async () => {
    const { calls, client } = mockLooot((c) =>
      c.url.includes("/catalog/search") ? { json: { endpoints: [{ endpointId: "e1", estimatedPrice: 0.01 }] } } : { json: { estimatedMaxCost: 0.01, inputSchema: { properties: {} } } },
    );
    expect((await client.search("work email")).map((h) => h.endpointId)).toEqual(["e1"]);
    expect((await client.inspect("job:people.email.find")).estimatedMaxCost).toBe(0.01);
    expect(calls[0].url).toBe("https://api.looot.ai/v1/catalog/search?q=work+email&limit=20");
    expect(calls[1].url).toBe("https://api.looot.ai/v1/operations/job%3Apeople.email.find");
  });
});
