import { defineConfig, devices } from "@playwright/test";
import { setting } from "./src/server/env";

// The browser tests open the running Mission Control and sign in through Keycloak's own form.
// Start the stack and the web process first. The tests change real rows, so they run one at a time.
export default defineConfig({
  testDir: "e2e",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: setting("APP_URL"),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } } }],
});
