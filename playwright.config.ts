import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const HAS_SYSTEM_CHROME = Boolean(process.env.CI) || existsSync('/opt/google/chrome/chrome');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chrome',
      use: {
        ...devices['Desktop Chrome'],
        ...(HAS_SYSTEM_CHROME ? { channel: 'chrome' } : {}),
      },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
  ],
  webServer: {
    command: 'node server-dist/index.js',
    url: `${BASE_URL}/api/me`,
    reuseExistingServer: !process.env.CI,
    env: {
      PORT: String(PORT),
      APP_ORIGIN: BASE_URL,
      DEV_USER_EMAIL: 'dev@bluecore.energy',
      LINEAR_CLIENT_ID: 'test-client-id',
      LINEAR_CLIENT_SECRET: 'test-client-secret',
      LINEAR_REDIRECT_URI: `${BASE_URL}/api/linear/callback`,
      STATIC_DIR: 'dist',
    },
  },
});
