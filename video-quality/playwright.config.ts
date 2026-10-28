import { defineConfig, devices } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

function loadEnvFile(filePath: string): Record<string, string> {
  try {
    if (!existsSync(filePath)) return {};
    const content = readFileSync(filePath, 'utf8');
    const env: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i > 0) {
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
        if (v) env[k] = v;
      }
    }
    return env;
  } catch {
    return {};
  }
}

// Automatically load .env.loadtest from repo root, with process.env taking precedence
const rootEnv = loadEnvFile(path.resolve(__dirname, '..', '.env.loadtest'));
const merged = { ...rootEnv, ...process.env };

const targetEnv = (merged.LOAD_TEST_ENV ?? (merged.TAILNET_HOST ? 'dev' : 'local')).toLowerCase();
const tailnetHost = merged.TAILNET_HOST ?? '';
const defaultWhepBase = targetEnv === 'dev' && tailnetHost
  ? `https://${tailnetHost}/webrtc`
  : 'http://127.0.0.1:8889';

const WHEP_BASE = (merged.WHEP_BASE_URL || defaultWhepBase).replace(/\/$/, '');
const botCount = Number(merged.TEST_BOT_COUNT || 3);
const VINS = (merged.TEST_VINS && merged.TEST_VINS.trim().length > 0)
  ? merged.TEST_VINS.split(',').map((v) => v.trim()).filter(Boolean)
  : Array.from({ length: botCount }, (_, i) => `TEST-VIN-${String(i + 1).padStart(3, '0')}`);
const streams = VINS.map((vin) => ({ name: vin.toLowerCase(), url: `${WHEP_BASE}/${vin}` }));

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './tests',
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'html',
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('')`. */
    // baseURL: 'http://localhost:3000',

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },

  /* Configure projects for major browsers */
  projects: [
    /* One project per stream, so each stream gets its own
     * result row in the HTML report. */
    ...streams.map((stream) => ({
      name: `chromium-${stream.name}`,
      use: {
        ...devices['Desktop Chrome'],
        env: { STREAM_URL: stream.url },
      },
    })),

    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },

    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },

    /* Test against mobile viewports. */
    // {
    //   name: 'Mobile Chrome',
    //   use: { ...devices['Pixel 5'] },
    // },
    // {
    //   name: 'Mobile Safari',
    //   use: { ...devices['iPhone 12'] },
    // },

    /* Test against branded browsers. */
    // {
    //   name: 'Microsoft Edge',
    //   use: { ...devices['Desktop Edge'], channel: 'msedge' },
    // },
    // {
    //   name: 'Google Chrome',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    // },
  ],

  /* Run your local dev server before starting the tests */
  // webServer: {
  //   command: 'npm run start',
  //   url: 'http://localhost:3000',
  //   reuseExistingServer: !process.env.CI,
  // },
});
