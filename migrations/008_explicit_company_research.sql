CREATE TABLE IF NOT EXISTS looot_tables.company_research (
 workspace_id text NOT NULL REFERENCES looot_tables.workspaces(id),
 domain text NOT NULL,
 profile jsonb,
 researched_at bigint,
 research_token text,
 research_until bigint NOT NULL DEFAULT 0,
 PRIMARY KEY (workspace_id,domain)
);
