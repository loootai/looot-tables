CREATE TABLE IF NOT EXISTS looot_tables.enrichment_budgets (
  id text PRIMARY KEY,
  spent_nano bigint NOT NULL DEFAULT 0 CHECK (spent_nano >= 0)
);
CREATE TABLE IF NOT EXISTS looot_tables.enrichment_reservations (
  id text PRIMARY KEY,
  budget_id text NOT NULL REFERENCES looot_tables.enrichment_budgets(id),
  reserved_nano bigint NOT NULL CHECK (reserved_nano > 0),
  charged_nano bigint,
  status text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'settled', 'uncertain')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS enrichment_reservations_budget_time ON looot_tables.enrichment_reservations (budget_id, created_at);

ALTER TABLE looot_tables.organization_providers DROP CONSTRAINT IF EXISTS organization_providers_provider_check;
ALTER TABLE looot_tables.organization_providers ADD CONSTRAINT organization_providers_provider_check CHECK (provider IN ('openai','context','typesafe','hunter','prospeo','quickenrich','apollo','contactout'));
