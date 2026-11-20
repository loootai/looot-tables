-- Server-side money guards for looot runs: a spend cap per sheet, a miss streak per column, and every cell run's
-- idempotency seed stored before it is dispatched.
CREATE TABLE IF NOT EXISTS looot_tables.sheet_spend (
  workspace_id text NOT NULL,
  sheet_id text NOT NULL,
  cap_micros bigint NOT NULL DEFAULT 5000000 CHECK (cap_micros >= 0),
  spent_micros bigint NOT NULL DEFAULT 0 CHECK (spent_micros >= 0),
  held_micros bigint NOT NULL DEFAULT 0 CHECK (held_micros >= 0),
  PRIMARY KEY (workspace_id, sheet_id)
);
CREATE TABLE IF NOT EXISTS looot_tables.column_streaks (
  workspace_id text NOT NULL,
  sheet_id text NOT NULL,
  column_id text NOT NULL,
  misses integer NOT NULL DEFAULT 0 CHECK (misses >= 0),
  halted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (workspace_id, sheet_id, column_id)
);
CREATE TABLE IF NOT EXISTS looot_tables.cell_runs (
  workspace_id text NOT NULL,
  attempt text NOT NULL,
  sheet_id text NOT NULL,
  row_id text NOT NULL,
  column_id text NOT NULL,
  generation integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'dispatched' CHECK (status IN ('dispatched', 'settled', 'retry')),
  held_micros bigint NOT NULL DEFAULT 0 CHECK (held_micros >= 0),
  charged_micros bigint NOT NULL DEFAULT 0 CHECK (charged_micros >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, attempt)
);
CREATE INDEX IF NOT EXISTS cell_runs_sheet ON looot_tables.cell_runs (workspace_id, sheet_id, created_at);
