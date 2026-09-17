import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'prototype', testMatch: 'workspace.spec.ts' },
    { name: 'desktop', testMatch: 'desktop.spec.ts', use: { baseURL: 'http://127.0.0.1:1420' } },
    { name: 'tasks', testMatch: 'tasks.spec.ts', use: { baseURL: 'http://127.0.0.1:1420' } },
    { name: 'themes', testMatch: 'themes.spec.ts', use: { baseURL: 'http://127.0.0.1:1420' } },
  ],
  webServer: [{
    command: 'bun run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
  }, {
    command: 'bun run dev:desktop',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: !process.env.CI,
  }],
});
