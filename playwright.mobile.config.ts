import { defineConfig } from '@playwright/test';

const baseURL = 'http://127.0.0.1:3118';

export default defineConfig({
	testDir: './tests/mobile',
	outputDir: './test-results-mobile',
	workers: 1,
	timeout: 60_000,
	use: {
		baseURL,
		hasTouch: true,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
	},
	projects: [
		{ name: 'phone-small', use: { viewport: { width: 320, height: 640 }, isMobile: true } },
		{ name: 'phone', use: { viewport: { width: 390, height: 844 }, isMobile: true } },
		{ name: 'tablet', use: { viewport: { width: 768, height: 1024 } } },
		{ name: 'desktop', use: { viewport: { width: 1360, height: 900 }, hasTouch: false } },
	],
	webServer: {
		command: 'npm run dev -- --hostname 127.0.0.1 --port 3118',
		url: `${baseURL}/icon.svg`,
		reuseExistingServer: false,
		env: {
			ENRICHABLE_NEXT_DIST_DIR: '.next-mobile-test',
			ENRICHABLE_APP_URL: baseURL,
			ENRICHABLE_SESSION_SECRET: '',
			ENRICHABLE_DEV_AUTH: 'false',
			CONTEXT_OAUTH_CLIENT_ID: '',
			CONTEXT_OAUTH_CLIENT_SECRET: '',
			ENRICHABLE_OPENAI_TRIAL_ENABLED: 'false',
			ENRICHABLE_ALLOW_SERVER_KEYS_WITHOUT_PASSWORD: 'false',
			ENRICHABLE_PASSWORD: '',
			DATABASE_URL: '',
		},
		timeout: 120_000,
	},
});
