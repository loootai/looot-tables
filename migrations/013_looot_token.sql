-- One looot token replaces the separate web-data key and the email provider keys.
-- Rows saved under the old provider names stay valid and nothing reads them any more.
-- The included-credit tables from earlier migrations are left in place, unused.
ALTER TABLE looot_tables.organization_providers DROP CONSTRAINT IF EXISTS organization_providers_provider_check;
ALTER TABLE looot_tables.organization_providers ADD CONSTRAINT organization_providers_provider_check CHECK (provider IN ('openai','looot','typesafe','context','hunter','prospeo','quickenrich','apollo','contactout'));
