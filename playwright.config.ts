import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  webServer: {
    command: "npx http-server e2e/pages -p 8790 -c-1 --silent",
    url: "http://localhost:8790/index.html",
    reuseExistingServer: true,
  },
});
