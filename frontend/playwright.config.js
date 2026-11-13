import { defineConfig, devices } from '@playwright/test';

// Real E2E tests against the actual dev server and the actual backend API —
// no mocking. Each spec is responsible for creating and cleaning up its own
// fixtures (see e2e/*.spec.js), the same "arrange via direct DB/API, act via
// the real UI, tear down after" pattern the backend suite already uses.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // specs share one backend DB; parallel runs would race on fixtures
  retries: 0,
  workers: 1,
  reporter: [['list']],
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 60000,
  },
});
