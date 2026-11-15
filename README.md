# receipt-filer

Cloudflare Worker that attaches emailed receipts to FreeAgent bank transaction explanations. Design: `docs/superpowers/specs/2026-11-15-receipt-filer-design.md`.

- `npm test` runs Vitest in the Workers pool with a local D1 (migrations applied from `migrations/`).
- `npm run types` regenerates `worker-configuration.d.ts` after editing `wrangler.jsonc`.
- `wrangler.jsonc` holds placeholder D1 and R2 ids. Create the real resources before the first deploy.
- Secrets `FREEAGENT_CLIENT_ID` and `FREEAGENT_CLIENT_SECRET` are Worker secrets (`wrangler secret put`), never committed.
