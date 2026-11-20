CREATE TABLE IF NOT EXISTS looot_tables.sheet_presence (
  workspace_id text NOT NULL,
  sheet_id text NOT NULL,
  client_id text NOT NULL,
  user_id text NOT NULL,
  name text NOT NULL,
  color text NOT NULL,
  row_id text,
  column_id text,
  updated_at bigint NOT NULL,
  PRIMARY KEY (workspace_id, client_id),
  FOREIGN KEY (workspace_id, sheet_id) REFERENCES looot_tables.sheets(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS sheet_presence_lookup ON looot_tables.sheet_presence (workspace_id, sheet_id, updated_at);
