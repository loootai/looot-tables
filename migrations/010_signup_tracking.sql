CREATE TABLE IF NOT EXISTS looot_tables.signup_tracking (
 id boolean PRIMARY KEY DEFAULT true CHECK (id),
 started_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO looot_tables.signup_tracking (id) VALUES (true) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS looot_tables.signed_in_users (
 issuer text NOT NULL,
 user_id text NOT NULL,
 first_signed_in_at timestamptz NOT NULL DEFAULT now(),
 last_signed_in_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (issuer, user_id)
);
CREATE INDEX IF NOT EXISTS signed_in_users_first_signin ON looot_tables.signed_in_users (first_signed_in_at);

CREATE TABLE IF NOT EXISTS looot_tables.signed_in_memberships (
 workspace_id text NOT NULL REFERENCES looot_tables.workspaces(id) ON DELETE CASCADE,
 issuer text NOT NULL,
 user_id text NOT NULL,
 first_signed_in_at timestamptz NOT NULL DEFAULT now(),
 last_signed_in_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (workspace_id, issuer, user_id),
 FOREIGN KEY (issuer, user_id) REFERENCES looot_tables.signed_in_users(issuer, user_id)
);
