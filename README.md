# receipt-filer

Cloudflare Worker that attaches emailed receipts to FreeAgent bank transaction explanations. Design: `docs/superpowers/specs/2026-11-15-receipt-filer-design.md`.

- `npm test` runs Vitest in the Workers pool with a local D1 (migrations applied from `migrations/`). The tests take the secrets from `vitest.config.ts`.
- `npm run types` regenerates `worker-configuration.d.ts` after editing `wrangler.jsonc`.
- `wrangler.jsonc` holds a placeholder D1 id. Create the real resources before the first deploy.

## One-time setup

Run these steps in this order. Every command runs from the repo folder.

1. Create the database: `npx wrangler d1 create receipt-filer`. Put the `database_id` it prints into `wrangler.jsonc`.
2. Create the tables: `npx wrangler d1 migrations apply receipt-filer --remote`.
3. Create the file bucket: `npx wrangler r2 bucket create receipt-filer-files`.
4. Set the secrets. Run `npx wrangler secret put <NAME>` for each name below and type the value when asked:
   - `FORWARD_ADDRESS`: the forwarding address, with a random local part. It is a shared secret.
   - `ALLOWED_SENDERS`: the addresses that may send receipts, separated by commas.
   - `NOTIFY_TO`: the address that gets the notifications.
   - `OWNER_EMAIL`: the only email that Cloudflare Access lets into the UI.
   - `FREEAGENT_CLIENT_ID` and `FREEAGENT_CLIENT_SECRET`: from the FreeAgent developer app.
5. Set `APP_URL` in `wrangler.jsonc` to the Worker's URL. When you are ready for the real company, set `FREEAGENT_BASE_URL` to `https://api.freeagent.com/v2`. The default is the sandbox.
6. Deploy: `npx wrangler deploy`. The Images binding needs Images enabled on the Cloudflare account.
7. Switch on Cloudflare Access for the Worker. Make the owner's email the only allowed identity.
8. In Email Routing, verify the `NOTIFY_TO` address as a destination address. The Worker cannot send to an unverified address.
9. In Email Routing, add a rule that sends mail for the forwarding address to the Worker.
10. In the FreeAgent developer app, register `<APP_URL>/oauth/callback` as the redirect URI.
11. Open the Settings page and connect FreeAgent.
12. In Gmail, add the forwarding address as a forwarding address. The Worker forwards Gmail's confirmation email to `NOTIFY_TO`. Then add the filter that forwards receipts.

For `wrangler dev`, copy `.dev.vars.example` to `.dev.vars`. It holds example values only.

## Web UI and access

- Every route, `/health` included, needs a Cloudflare Access identity that equals `OWNER_EMAIL`. The Worker reads it from `ctx.access.getIdentity()` and answers 403 when it is missing, different, or when `OWNER_EMAIL` is blank. Switch Access on for the Worker as well.
- Local dev: `wrangler.jsonc` has an `access.dev` block that signs `wrangler dev` in as `owner@example.com`. `.dev.vars.example` sets `OWNER_EMAIL=owner@example.com` to match.
- Every POST must carry an `Origin` header equal to the request's own origin.

## Bank accounts

The matcher reads only GBP bank accounts; an account with no currency counts as GBP. Its rules are written for pound lines. A payment from a non-GBP account needs a manual Match: the Match page lists lines from every account.

## Exchange rates

`src/match/fx.ts` reads daily rates from Frankfurter: `GET https://api.frankfurter.dev/v1/<day>?base=<CUR>&symbols=GBP`. It is free and needs no account or key. Checked 2026-11-15: `.../v1/2026-11-09?base=USD&symbols=GBP` returns `{"amount":1.0,"base":"USD","date":"2026-11-09","rates":{"GBP":0.74538}}`. For a weekend date it returns the nearest earlier business day (`.../v1/2026-11-08?base=EUR&symbols=GBP` returns `"date":"2026-11-06"`). Rates are cached in the `rates` table under the requested day.
