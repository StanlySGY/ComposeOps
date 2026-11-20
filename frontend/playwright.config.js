import { defineConfig, devices } from '@playwright/test';

const chromiumLaunch = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {};
const previewPort = Number(process.env.PREVIEW_PORT || 4174);
if (!Number.isInteger(previewPort) || previewPort < 1 || previewPort > 65535) throw new Error('Invalid PREVIEW_PORT');
const previewUrl = `http://127.0.0.1:${previewPort}/ComposeOps/`;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.js',
  fullyParallel: true,
  // Monaco + the full 22-route sweep are memory-heavy under WSL; two workers keep mobile-route startup deterministic.
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: process.env.PREVIEW_BASE_URL || previewUrl,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], launchOptions: chromiumLaunch, viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], launchOptions: chromiumLaunch } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 1000 } } },
    { name: 'webkit-mobile', use: { ...devices['iPhone 13'] } },
  ],
  // A different worktree may already serve this port. Never silently test its
  // stale assets; an explicitly supplied PREVIEW_BASE_URL remains opt-in.
  webServer: process.env.PREVIEW_BASE_URL ? undefined : {
    command: 'npm run preview:serve', url: previewUrl,
    env: { PREVIEW_PORT: String(previewPort) }, reuseExistingServer: false,
  },
});
