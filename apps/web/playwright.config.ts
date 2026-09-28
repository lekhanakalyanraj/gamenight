import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;

// End-to-end tests drive several browsers at once (a TV and phones) against the local Supabase stack.
// Locally they reuse a running dev server; CI builds the app and runs `next start`.
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0, // a flaky lobby is a bug to fix, not to retry away
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: process.env.CI ? "npm run start" : "npm run dev",
    url: `http://localhost:${PORT}/tv`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
