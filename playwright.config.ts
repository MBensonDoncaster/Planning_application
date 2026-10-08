import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', globalSetup: './e2e/setup.ts', fullyParallel: false, workers: 1,
  forbidOnly: Boolean(process.env.CI), retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:4174', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
