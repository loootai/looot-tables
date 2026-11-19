import { defineConfig } from '@playwright/test';

const baseURL = 'http://127.0.0.1:3107';
export default defineConfig({
 testDir: './tests/self-hosted',
 workers: 1,
 timeout: 60_000,
 use: { baseURL, viewport: { width: 1360, height: 900 }, trace: 'retain-on-failure', launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {} },
 webServer: {
  command: 'npm run dev -- --hostname 127.0.0.1 --port 3107',
  url: `${baseURL}/icon.svg`,
  reuseExistingServer: false,
  env: { ENRICHABLE_NEXT_DIST_DIR: '.next-self-hosted-test', ENRICHABLE_APP_URL: baseURL, ENRICHABLE_SESSION_SECRET: '', ENRICHABLE_DEV_AUTH: 'false', CONTEXT_OAUTH_CLIENT_ID: '', CONTEXT_OAUTH_CLIENT_SECRET: '', ENRICHABLE_OPENAI_TRIAL_ENABLED: 'false', ENRICHABLE_ALLOW_SERVER_KEYS_WITHOUT_PASSWORD: 'false', ENRICHABLE_PASSWORD: '' },
  timeout: 60_000,
 },
});
