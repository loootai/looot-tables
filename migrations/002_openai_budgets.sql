CREATE TABLE IF NOT EXISTS looot_tables.openai_budgets (
  id text PRIMARY KEY,
  spent_nano bigint NOT NULL DEFAULT 0 CHECK (spent_nano >= 0)
);
CREATE TABLE IF NOT EXISTS looot_tables.openai_reservations (
  id text PRIMARY KEY,
  budget_id text NOT NULL REFERENCES looot_tables.openai_budgets(id),
  reserved_nano bigint NOT NULL CHECK (reserved_nano > 0),
  charged_nano bigint,
  status text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'settled', 'uncertain')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS openai_reservations_budget_time ON looot_tables.openai_reservations (budget_id, created_at);
