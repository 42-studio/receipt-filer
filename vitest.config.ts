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
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      };
    }),
  ],
  test: { setupFiles: ["./test/apply-migrations.ts"] },
});
