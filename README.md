# receipt-filer

Cloudflare Worker that attaches emailed receipts to FreeAgent bank transaction explanations. Design: `docs/superpowers/specs/2026-11-15-receipt-filer-design.md`.

- `npm install && npm --prefix ui install` installs the Worker and the UI.
- `npm test` runs Vitest in the Workers pool with a local D1 (migrations applied from `migrations/`). The tests take the secrets from `vitest.config.ts`.
- `npm run typecheck` checks the Worker and the UI. `npm run build` builds the UI into `ui/dist`.
- `npm run types` regenerates `worker-configuration.d.ts` after editing `wrangler.jsonc`.
- `wrangler.jsonc` holds the ids and the hostname of the running deployment. For a new deployment, replace them as the setup steps say.

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
5. Set `APP_URL` in `wrangler.jsonc` to the Worker's URL. `FREEAGENT_BASE_URL` selects the FreeAgent company: `https://api.freeagent.com/v2` is the real one, `https://api.sandbox.freeagent.com/v2` is the sandbox. Test against the sandbox first. After a change, deploy and reconnect FreeAgent on the Settings page.
6. Deploy: `npm run deploy`. It builds the UI first. The Images binding needs Images enabled on the Cloudflare account.
7. Switch on Cloudflare Access for the Worker. Make the owner's email the only allowed identity.
8. In Email Routing, verify the `NOTIFY_TO` address as a destination address. The Worker cannot send to an unverified address.
9. In Email Routing, add a rule that sends mail for the forwarding address to the Worker. When the address is on a subdomain, add the subdomain first (Email Routing, Settings, Subdomains).
10. In the FreeAgent developer app, register `<APP_URL>/oauth/callback` as the redirect URI.
11. Open the Settings page and connect FreeAgent.
12. In Gmail, add the forwarding address as a forwarding address. The Worker forwards Gmail's confirmation email to `NOTIFY_TO`. Then add the filter that forwards receipts.

For `wrangler dev`, copy `.dev.vars.example` to `.dev.vars`. It holds example values only.

## Web UI and access

- The UI is a React app in `ui/` (Vite, Tailwind, shadcn/ui). The Worker serves its build from `ui/dist` as static assets and answers JSON under `/api`. API response shapes are in `src/ui/api-types.ts`, which the UI imports.
- The state rules (which actions each state allows), the labels and the Fits ranking stay in the Worker (`src/ui/app.ts`). The UI only shows what the API returns.
- Pages: the dashboard (`/`) leads with one sentence ("4 receipts need you. 38 are on track.") over a bar of where every receipt is, then works through the receipts that need you one at a time in an "Up next" card: the receipt itself, what went wrong, what to do, and its action. Previous and Next step through them in a fixed order (failed, could not read, choices), wrapping at the ends; a swipeable gallery of all of them sits under the card, and choosing one shows it. When the one showing is dealt with, the next takes its place. A side column shows what is reading, what is waiting, this month and receipts per week. `/queue` lists every receipt. Receipt details (`/receipts/:id`) and manual matching (`/receipts/:id/match`) open as dialogs over the page you came from. A direct link, such as the one in a notification email, opens the dialog over the dashboard.
- The month figures (filed this calendar month, UTC, against last month; the share filed with no manual match) and the weekly buckets are computed in `src/ui/stats.ts` from the receipt list; `test/stats.test.ts` covers them.
- "Match by hand" for a receipt that could not be read opens a split view: the receipt (each PDF or image, and the email) beside the bank lines, which are ordered by names shared with the email, then by closeness to its date. The email body comes from `/api/receipts/:id/body` under a `sandbox` Content-Security-Policy with no network, inside a sandboxed iframe, so it runs no script and loads no remote image.
- "Receipts per week" is a small stacked column chart of the receipts received in each of the last 10 weeks (Monday to Sunday, UTC) by where each one is now: filed, in progress, or needs you. Duplicates are left out. Its colours are the dataviz default categorical slots 1-3, validated for both themes against the card surface; the light-mode filed green is under 3:1, so its table button shows the same numbers as a table. The tile has no legend: the hover tooltip and the table name each series. A dotted line marks the average per week over the full weeks (this week is left out until it ends). The bucketing is `weeklyByStatus` in `src/ui/stats.ts`.
- Each state has at most one guided action button (`ui/src/components/receipt-actions.tsx`); the other allowed actions are in the "⋯" menu.
- `run_worker_first` sends every request, the UI files included, through the Worker, so the Access check below covers them.
- The page's Content-Security-Policy allows scripts and styles from the Worker's own origin only (plus inline style attributes, which Radix sets).
- UI playground: `npm run dev:ui` starts it in one command: the dev Worker on 8788 (fake FreeAgent, AI and email, and test receipts) and Vite on 5173 (the UI with hot reload, proxying `/api` and `/oauth` to the Worker). Open http://localhost:5173. Ctrl-C stops both. `npm run dev:worker` starts the Worker alone, serving the last built UI on http://localhost:8788. A "Test data" button (bottom left, on localhost only) switches between data scenarios in `dev/scenarios.ts`: the everyday mix, empty, all caught up, a single failure, a pile-up, a reading burst, long names and huge amounts, missing or odd files, history only, nothing filed this month, lots of duplicates and foreign currencies. Each switch wipes the local data and seeds the scenario. `/__reset` reseeds the one that is showing. The seeded Reading receipts stay in Reading; "Email in a receipt" (`/__new`) adds one that finishes reading about 8 seconds later. These routes exist only in the dev worker; the deployed app never loads the panel's code. The test receipts' PDFs are generated by `dev/receipt-pdf.ts`, each with its supplier, items and total.
- Every route, `/health` included, needs a Cloudflare Access identity that equals `OWNER_EMAIL`. The Worker reads it from `ctx.access.getIdentity()` and answers 403 when it is missing, different, or when `OWNER_EMAIL` is blank. Switch Access on for the Worker as well.
- Local dev: `wrangler.jsonc` has an `access.dev` block that signs `wrangler dev` in as `owner@example.com`. `.dev.vars.example` sets `OWNER_EMAIL=owner@example.com` to match.
- Every request other than GET or HEAD must carry an `Origin` header equal to the request's own origin.

## Bank accounts

The matcher reads only GBP bank accounts; an account with no currency counts as GBP. Its rules are written for pound lines. A payment from a non-GBP account needs a manual Match: the Match page lists lines from every account.

## Exchange rates

`src/match/fx.ts` reads daily rates from Frankfurter: `GET https://api.frankfurter.dev/v1/<day>?base=<CUR>&symbols=GBP`. It is free and needs no account or key. Checked 2026-11-15: `.../v1/2026-11-09?base=USD&symbols=GBP` returns `{"amount":1.0,"base":"USD","date":"2026-11-09","rates":{"GBP":0.74538}}`. For a weekend date it returns the nearest earlier business day (`.../v1/2026-11-08?base=EUR&symbols=GBP` returns `"date":"2026-11-06"`). Rates are cached in the `rates` table under the requested day.
