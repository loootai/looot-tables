CREATE TABLE IF NOT EXISTS looot_tables.mcp_keys (
  workspace_id text PRIMARY KEY REFERENCES looot_tables.workspaces(id),
  key_hash text NOT NULL UNIQUE,
  prefix text NOT NULL,
  version text NOT NULL,
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS looot_tables.mcp_attempts (
  workspace_id text NOT NULL REFERENCES looot_tables.workspaces(id),
  id text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'finished', 'uncertain')),
  started_at bigint NOT NULL,
  result jsonb,
  PRIMARY KEY (workspace_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS mcp_one_active_batch ON looot_tables.mcp_attempts (workspace_id) WHERE status = 'running';
