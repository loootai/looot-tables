-- Quotes and budgeted runs for agents (MCP and the in-app agent). A quote is free and names the cells a run may fill and
-- the most it can cost. A run needs a quote id and the caller's budget, so no agent spends without one.
CREATE TABLE IF NOT EXISTS looot_tables.run_quotes (
  workspace_id text NOT NULL,
  id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('column', 'find')),
  sheet_id text NOT NULL,
  column_id text,
  request jsonb NOT NULL,
  op_hash text NOT NULL,
  cells integer NOT NULL CHECK (cells >= 0),
  per_cell_micros bigint NOT NULL DEFAULT 0 CHECK (per_cell_micros >= 0),
  max_micros bigint NOT NULL DEFAULT 0 CHECK (max_micros >= 0),
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE IF NOT EXISTS looot_tables.agent_runs (
  workspace_id text NOT NULL,
  id text NOT NULL,
  quote_id text NOT NULL,
  idempotency_key text NOT NULL,
  sheet_id text NOT NULL,
  column_id text,
  budget_micros bigint NOT NULL CHECK (budget_micros >= 0),
  status text NOT NULL CHECK (status IN ('running', 'finished', 'cancelled', 'uncertain')),
  cancel_requested boolean NOT NULL DEFAULT false,
  cells integer NOT NULL DEFAULT 0,
  done integer NOT NULL DEFAULT 0,
  spent_micros bigint NOT NULL DEFAULT 0 CHECK (spent_micros >= 0),
  result jsonb,
  started_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_key ON looot_tables.agent_runs (workspace_id, quote_id, idempotency_key);
CREATE INDEX IF NOT EXISTS agent_runs_sheet ON looot_tables.agent_runs (workspace_id, sheet_id, started_at)
