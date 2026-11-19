# Deploy to Vercel with Neon

The README's **Deploy with Vercel** button opens a guided setup with Neon Postgres selected. You still choose your Git account, database region, and plan, and approve the installation. Your Vercel and Neon accounts own the resulting app and database.

1. Click the button and choose where to clone the repository.
2. Create a Neon Postgres database in the setup flow. Keep the default database-variable names; the app uses `DATABASE_URL`.
3. Confirm the plan and deploy. Neon supplies the connection variables. Vercel runs `npm run db:migrate` before `npm run build`, so the app's tables are ready when the deployment goes live.
4. Open `/app` on the deployed site and enter your own OpenAI and Context.dev keys. Add optional enrichment keys in Configuration.

Self-hosted deployments use API keys. Context.dev organization sign-in is reserved for the official service. Neon Auth is not required. Realtime and MCP access are optional; see [Realtime](realtime.md) and [MCP setup](mcp.md).

## Existing database or project

Connect a dedicated Neon database to the Vercel project with the `DATABASE_URL` variable. If Neon also supplies `DATABASE_URL_UNPOOLED`, the migration runner prefers that connection. Use separate database branches for production and previews.

Keep the repository's `vercel.json` build command. It runs migrations before building, including on later deployments. Migrations are serialized with a transaction-level advisory lock and run in one transaction. If they fail, the build stops. Ordinary local and CI `npm run build` does not run migrations; local setup still uses `npm run db:migrate` explicitly.

An existing project may have a dashboard build-command override. Confirm that its effective build command is `npm run db:migrate && npm run build` when adopting this setup. Test changes on a development database branch first.

## Troubleshooting

- **Repository cannot be cloned:** the template repository must be public for other people to use the button. The flow clones the GitHub version, so local changes must be committed and pushed first.
- **Database migration failed:** confirm that Neon is connected to the project and supplies `DATABASE_URL` for the deployment environment. Check database access and the migration files, then redeploy. A failed migration rolls back that attempt's schema changes.
- **App reports storage is not configured:** check the runtime `DATABASE_URL` and redeploy after connecting the database.
- **Using a different variable prefix:** configure the app's `DATABASE_URL` explicitly, or reconnect Neon with its default variable names.
- **Provider connection fails:** enter your own provider keys in the app. The deployment button configures storage, not provider accounts.

The button follows [Vercel's Deploy Button product flow](https://vercel.com/docs/deploy-button#products) and the [Neon native integration](https://neon.com/docs/guides/vercel-managed-integration). Its product selection matches [Neon's official template](https://github.com/neondatabase/vercel-marketplace-neon).
