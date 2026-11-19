# Email enrichment waterfall

Add → Add column → Email enrichment maps name, company domain, and optional company / LinkedIn columns. The compact picker saves enabled providers in drag order. Keyboard sorting uses Space, arrow keys, then Space. It stops at the first usable work email returned, regardless of verification status. No additional verification calls are made; the provider’s verification status is retained in result details. All steps request work email only; phone and personal-email add-ons are disabled.

## Connect your own providers

Self-hosted deployments require your own provider API keys. In Configuration → Connections, connect any providers you want to use: QuickEnrich, Hunter, Apollo, Prospeo, and ContactOut. Select only the connected providers in your waterfall. Lookups are billed to your provider accounts and use their quotas; unsuccessful lookups may still incur charges.

Self-hosted browser workspaces keep manually entered keys in local storage and forward them to the app's API routes. Private deployments can instead configure `QUICKENRICH_API_KEY`, `HUNTER_API_KEY`, `APOLLO_API_KEY`, `PROSPEO_API_KEY`, and `CONTACTOUT_API_KEY` on the server with the deployment-password controls in the [README](../README.md#api-keys). The official service stores organization provider keys in its encrypted vault.

Direct calls use fixed provider HTTPS endpoints and header authentication. Raw provider errors, payloads, and credentials are not returned to clients. Result details retain the provider attempt order and verification status. Availability and charges follow each provider's plan.
