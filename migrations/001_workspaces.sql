CREATE SCHEMA IF NOT EXISTS looot_tables;

CREATE TABLE IF NOT EXISTS looot_tables.workspaces (
  id text PRIMARY KEY,
  issuer text NOT NULL,
  organization_id text NOT NULL,
  name text NOT NULL,
  UNIQUE (issuer, organization_id)
);

CREATE TABLE IF NOT EXISTS looot_tables.sheets (
  workspace_id text NOT NULL REFERENCES looot_tables.workspaces(id),
  id text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  data jsonb NOT NULL,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS looot_tables.sheet_rows (
  workspace_id text NOT NULL,
  sheet_id text NOT NULL,
  id text NOT NULL,
  position double precision NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, sheet_id) REFERENCES looot_tables.sheets(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS sheet_rows_order ON looot_tables.sheet_rows (workspace_id, sheet_id, position, id);
