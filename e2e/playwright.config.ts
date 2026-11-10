import { defineConfig } from '@playwright/test';

export const BASE_URL = process.env.BASE_URL ?? `http://localhost:${process.env.TEST_SERVER_PORT ?? '3003'}`;

export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  workers: 1, // one browser at a time keeps timing measurements meaningful
  fullyParallel: false,
  retries: 0,
  globalSetup: './global-setup.ts',
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  use: { baseURL: BASE_URL, trace: 'retain-on-failure' },
});
