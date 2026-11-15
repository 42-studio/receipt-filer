import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations("./migrations");
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        // AI/IMAGES/EMAIL bindings stay local; tests pass fakes instead of calling out.
        remoteBindings: false,
        // The secrets, with example values; tests that need others set them on their own env.
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            FORWARD_ADDRESS: "receipts-k3v9x2@example.com",
            ALLOWED_SENDERS: "josh@example.com",
            NOTIFY_TO: "owner@example.com",
            OWNER_EMAIL: "owner@example.com",
          },
        },
      };
    }),
  ],
  test: { setupFiles: ["./test/apply-migrations.ts"] },
});
