# Security

## Report a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/context-dot-dev/enrichable/security/advisories/new) for vulnerabilities in looot tables. Include the affected commit, reproduction steps using synthetic data, likely impact, and any suggested mitigation. Do not put vulnerabilities or credentials in public issues or pull requests.

If the private reporting form is unavailable, email [support@looot.ai](mailto:support@looot.ai) with the subject "looot tables security report" to request a private security channel before sharing details. Do not send secrets or production data, or put exploit details in a public issue.

Security fixes target the latest code on `main`; older snapshots do not have a separate backport commitment. This project does not currently promise a response deadline or operate a bug bounty program.

## Data and credentials

| Mode | Storage and access |
| --- | --- |
| Self-hosted browser workspace | A random HttpOnly cookie identifies the workspace. Manually entered provider keys live in workspace-partitioned browser local storage and are forwarded to server API routes. Sheets and rows live in your Neon database, with IndexedDB as a browser cache. |
| Official-site organization | Context.dev sign-in establishes organization membership. Organization provider secrets are encrypted in Neon using a server-only encryption root. Members share provider connections and sheets. |
| MCP | One full-access key per workspace. Authentication uses a hash; a recoverable copy is encrypted in Neon. Treat this key as a credential for all sheets and saved provider connections in that workspace. |

The self-hosted cookie is the workspace credential. Clearing it loses browser access to that workspace; exporting sheets provides a transfer path. Self-hosted mode does not provide organization accounts or cross-device recovery.

Requests for AI and web enrichment send the relevant prompts, row values, or URLs to the selected providers. Consult each provider's data policies before using sensitive records. Custom OpenAI-compatible endpoints receive the inputs sent to them. Browser local storage is readable by JavaScript running on the same origin; use a trusted deployment and browser profile.

## Operating a deployment

- Keep `.env.local`, database connection strings, private keys, browser profiles, traces, and provider credentials outside Git and release archives.
- Use a dedicated Neon database and a separate development branch/database for tests. Apply migrations before deploying code that uses new tables.
- Use HTTPS for remotely hosted instances. Restrict network or hosting access if the instance is private: the deployment password protects server-supplied provider keys, not the entire application or database provisioning of anonymous workspaces.
- Keep `ENRICHABLE_MCP_ENCRYPTION_SECRET` stable and backed up. All servers sharing a database need the same value; changing it requires re-encrypting saved secrets first.
- Rotate MCP keys and revoke provider credentials when exposed. Rotating the hosted session secret invalidates existing signed sessions; logout alone does not revoke a copied cookie or organization provider credentials.

See [MCP access and rotation](docs/mcp.md) for key scope, member access, expiration, and execution limits.
