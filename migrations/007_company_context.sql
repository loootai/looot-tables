CREATE TABLE IF NOT EXISTS enrichable.company_context (
 workspace_id text PRIMARY KEY REFERENCES enrichable.workspaces(id),
 lookup_status text NOT NULL DEFAULT 'pending',
 brand jsonb,
 lookup_at bigint NOT NULL,
 profile jsonb,
 researched_at bigint,
 research_token text,
 research_until bigint NOT NULL DEFAULT 0
);
