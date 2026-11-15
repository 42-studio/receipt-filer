# receipt-filer

Cloudflare Worker that attaches emailed receipts to FreeAgent bank transaction explanations. Design: `docs/superpowers/specs/2026-11-15-receipt-filer-design.md`.

- `npm test` runs Vitest in the Workers pool with a local D1 (migrations applied from `migrations/`).
- `npm run types` regenerates `worker-configuration.d.ts` after editing `wrangler.jsonc`.
- `wrangler.jsonc` holds placeholder D1 and R2 ids. Create the real resources before the first deploy.
- Secrets `FREEAGENT_CLIENT_ID` and `FREEAGENT_CLIENT_SECRET` are Worker secrets (`wrangler secret put`), never committed.

## Web UI and access

- Every route, `/health` included, needs a Cloudflare Access identity that equals `OWNER_EMAIL`. The Worker reads it from `ctx.access.getIdentity()` and answers 403 when it is missing, different, or when `OWNER_EMAIL` is blank. Switch Access on for the Worker as well.
- Local dev: `wrangler.jsonc` has an `access.dev` block that signs `wrangler dev` in as `owner@example.com`. Run dev with `OWNER_EMAIL=owner@example.com`, for example `npx wrangler dev --local --var OWNER_EMAIL:owner@example.com`.
- Every POST must carry an `Origin` header equal to the request's own origin.

## Exchange rates

`src/match/fx.ts` reads daily rates from Frankfurter: `GET https://api.frankfurter.dev/v1/<day>?base=<CUR>&symbols=GBP`. It is free and needs no account or key. Checked 2026-11-15: `.../v1/2026-11-09?base=USD&symbols=GBP` returns `{"amount":1.0,"base":"USD","date":"2026-11-09","rates":{"GBP":0.74538}}`. For a weekend date it returns the nearest earlier business day (`.../v1/2026-11-08?base=EUR&symbols=GBP` returns `"date":"2026-11-06"`). Rates are cached in the `rates` table under the requested day.
