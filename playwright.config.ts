import { defineConfig } from '@playwright/test';

const port=Number(process.env.ENRICHABLE_TEST_PORT||3100);
const baseURL=`http://127.0.0.1:${port}`;
export default defineConfig({
	testDir: './tests/browser',
	workers: 1,
	timeout: 30_000,
	use: {
		baseURL,
		viewport: { width: 1360, height: 900 },
		trace: 'retain-on-failure',
		launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
	},
	webServer: {
		command: `npm run dev -- --hostname 127.0.0.1 --port ${port}`,
		url: `${baseURL}/login`,
		reuseExistingServer: false,
		env: {
			ENRICHABLE_NEXT_DIST_DIR: process.env.ENRICHABLE_TEST_DIST_DIR||'.next-browser',
			ENRICHABLE_APP_URL: baseURL,
			ENRICHABLE_SESSION_SECRET: 'browser-test-session-secret-32-characters',
			CONTEXT_IDENTITY_ISSUER: 'http://127.0.0.1:3102',
			CONTEXT_OAUTH_CLIENT_ID: 'enrichable',
			CONTEXT_OAUTH_CLIENT_SECRET: 'browser-test-client-secret-32-characters',
		},
		timeout: 60_000,
	},
});
