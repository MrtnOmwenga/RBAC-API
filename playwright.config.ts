import { defineConfig, devices } from '@playwright/test';

// Browser tests for the "Redacted" demo UI, against the built API and web app (npm run build:all).
export default defineConfig({
  testDir: 'test/browser',
  fullyParallel: true,
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 } } }],
  webServer: {
    command: 'node test/browser/server.cjs',
    url: 'http://127.0.0.1:3100/health/ready',
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
