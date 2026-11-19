CREATE TABLE IF NOT EXISTS enrichable.organization_settings (
 workspace_id text PRIMARY KEY REFERENCES enrichable.workspaces(id),
 revision integer NOT NULL DEFAULT 0,
 preferences jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS enrichable.organization_providers (
 workspace_id text NOT NULL REFERENCES enrichable.workspaces(id),
 provider text NOT NULL CHECK (provider IN ('openai','context','typesafe','hunter','prospeo')),
 encrypted_secret text NOT NULL,
 prefix text NOT NULL,
 source text NOT NULL CHECK (source IN ('manual','signin')),
 subject_id text NOT NULL,
 subject_email text NOT NULL,
 expires_at bigint,
 updated_at bigint NOT NULL,
 PRIMARY KEY (workspace_id,provider)
);
CREATE TABLE IF NOT EXISTS enrichable.organization_settings_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES enrichable.workspaces(id),
 actor_id text NOT NULL,
 action text NOT NULL,
 fields jsonb NOT NULL,
 created_at bigint NOT NULL
);

ALTER TABLE enrichable.organization_providers ADD COLUMN IF NOT EXISTS disabled boolean NOT NULL DEFAULT false;
