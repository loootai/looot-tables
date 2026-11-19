-- MoltSets is an optional flat-fee contact data source. Its key is stored like the other provider keys.
ALTER TABLE enrichable.organization_providers DROP CONSTRAINT IF EXISTS organization_providers_provider_check;
ALTER TABLE enrichable.organization_providers ADD CONSTRAINT organization_providers_provider_check CHECK (provider IN ('openai','looot','typesafe','moltsets','context','hunter','prospeo','quickenrich','apollo','contactout'));
