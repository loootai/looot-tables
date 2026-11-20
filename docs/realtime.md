# Live sheet collaboration

looot tables uses the official `@neon/realtime` SDK for live updates from both browser edits and MCP writes. Existing authenticated API routes remain the only write path. Database credentials and the branch Realtime secret never go to the browser.

## Enable

1. Enable Realtime on your existing Neon branch in the Neon Console. Enabling it turns on logical replication project-wide and briefly disconnects database connections. Follow Neon's current region and beta requirements.
2. Run `npm run db:migrate`. Migration `005_collaboration.sql` adds the ephemeral presence table and its index.
3. Configure server-only `NEON_REALTIME_URL` and `NEON_REALTIME_SECRET` from the branch's Realtime page. HTTPS endpoint URLs are normalized to WSS. Keep the secret out of public environment variables and source control.
4. Restart the local server or deploy the configured application, then reload open tabs. Cloud environment changes take effect on subsequent deployments.

No auth migration is needed. The private workspace cookie determines access. Self-hosters configure their own branch; cloning this repository grants no access to hosted data. If configuration is absent or disabled, each tab asks once and then refreshes visible tabs every 30 seconds, with a steady "Checking for edits periodically" dot and no presence requests; tabs opened before Realtime was enabled keep polling until reloaded. Set `LOOOT_TABLES_REALTIME_ENABLED=false` to force that fallback. If the service is configured but unavailable, tabs poll the same way and try to connect again every 30 seconds.

## Behavior

- One multiplexed WebSocket per browser tab, with a workspace metadata subscription and data/presence subscriptions for the open sheet.
- Inserts, edits, row deletions, column changes, sheet renames/deletions, formula results, and saved enrichment results appear automatically. Existing formulas are calculated through the normal browser write path; receiving a remote result does not create another write or undo entry.
- Row data and sheet revision are selected together with a UNION query, so committed transaction updates become visible atomically. Newer acknowledged local revisions take priority over older live snapshots.
- Incoming bursts are coalesced before cache updates. Only changed rows are written to IndexedDB; the SDK transfers incremental query changes rather than repeatedly downloading an entire sheet.
- Collaborator avatars and cell outlines identify other active browser sessions. They are advisory selections, not locks or a character-by-character shared text editor. Unsaved drafts are not sent to other clients.
- Inline and formula-bar editors preserve drafts while a remote edit arrives. On save, a conflicting cell prompts the user to keep the saved value or explicitly replace it with their draft. A save racing another commit also refuses to silently rebase over a changed cell. Independent edits can still rebase normally.
- Connection labels show connecting, live, reconnecting, offline, paused, or polling fallback. A tab is live only when every one of its subscriptions (workspace, open sheet, presence) is; anything less keeps polling. The SDK reconnects and renews short-lived capabilities; reconnects receive authoritative snapshots. Hidden tabs keep their connection for five minutes without applying sheet updates, then disconnect; focus checks refresh data and account identity.
- `src/lib/workspace-realtime.ts` is the connection state machine. It reaches the network, socket, cache, tab and timers only through `RealtimePorts`; `src/lib/realtime-client.ts` is the Neon + DOM Adapter and tests use an in-memory one.

## Authorization

`GET /api/realtime` uses the existing browser session and account/session header checks. It seals fixed SQL with a server-derived workspace ID and an optional validated sheet ID. No SQL, user ID, workspace ID, or branch secret is accepted from the caller. Capabilities expire after 60 seconds, and renewal checks the current session again.

Presence writes validate that the sheet, row, and column belong to the authenticated workspace. Display name, public user hash, and color are derived on the server; a client cannot impersonate a different user's presence session. Presence rows cascade when a sheet is deleted. Clients filter out heartbeats older than 60 seconds, and active writes clean up stale records. No row-level-security support is assumed from the beta service.

## Cost controls

Normal sheet polling stops while live subscriptions are healthy. Only open-sheet row data is subscribed to; the sidebar uses metadata. Renewal signs capabilities locally and does not query Postgres. Active presence sends a small heartbeat every 20 seconds, with selection changes debounced. Hidden tabs stop publishing, and a tab with no keyboard/pointer interaction for two minutes leaves presence while its data subscription can stay live. Presence therefore adds writes while users actively collaborate, but does not require keeping idle sessions alive forever.

Realtime service charges are currently waived during Neon's beta; database compute and egress are still subject to the Neon plan. Future Realtime pricing is not guaranteed. Keep the polling fallback available.

## Verification

- `tests/server/realtime.test.ts`: sealed capability scope/expiry, secret protection, tenant isolation, presence impersonation prevention, expiry cleanup, and sheet-deletion cascade against embedded Postgres.
- `tests/collaboration.test.ts`: atomic local snapshots, stale-revision protection, deletion, payload validation, and local presence expiration.
- `tests/workspace-realtime.test.ts`: the state machine on the in-memory Adapter with a manual clock: a deployment without Realtime asks once and keeps a steady dot, live requires every subscription, the hidden-tab grace period, retries after transient failures, ordered presence requests, shared capability renewal, and local collaborator expiry.
- `tests/self-hosted/realtime.spec.ts`: requires configured Neon Realtime; uses two independent browser storage contexts sharing an isolated test workspace. Real MCP writes must reach both clients, selections appear remotely, conflicting drafts remain recoverable, and offline clients catch up on reconnect. Only test-created sheets are removed afterward.
