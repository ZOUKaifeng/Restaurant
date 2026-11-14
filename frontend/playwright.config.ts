import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const serverEnv = { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` };

export default defineConfig({
  testDir: './test',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  reporter: 'list',
  outputDir: '../.workbuddy/runtime/browser-results',
  webServer: [
    {
      command: 'npm run dev', cwd: fileURLToPath(new URL('../backend', import.meta.url)), env: serverEnv,
      url: 'http://127.0.0.1:4000/api/v1/health/ready', reuseExistingServer: true, timeout: 30000,
    },
    {
      command: 'npm run dev', cwd: fileURLToPath(new URL('.', import.meta.url)), env: serverEnv,
      url: 'https://localhost:5173', ignoreHTTPSErrors: true, reuseExistingServer: true, timeout: 30000,
    },
  ],
  use: {
    browserName: 'chromium', baseURL: 'https://localhost:5173', ignoreHTTPSErrors: true,
    trace: 'off', screenshot: 'off', video: 'off',
    launchOptions: { executablePath: process.env.E2E_CHROMIUM_PATH },
  },
});
