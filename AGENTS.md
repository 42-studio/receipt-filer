# AGENTS.md

Receipt filer is a Cloudflare Worker with one user. It reads receipts that arrive by email, matches each one to a FreeAgent bank line, and attaches it. Commands and setup are in `README.md`; the security rules are in `SECURITY.md`.

## Layout

- `src/email/`: the inbound email hook (who may send, what is stored).
- `src/read/`: turns a receipt (PDF, image, email body) into supplier, total, date and a confidence.
- `src/match/`: decides which bank line a receipt belongs to and files it in FreeAgent.
- `src/freeagent/`: the FreeAgent API client and OAuth tokens.
- `src/ui/`: the JSON API under `/api`, the OAuth routes, and the static UI behind the owner check.
- `ui/`: the React app (Vite, Tailwind, shadcn/ui). `ui/src/components/ui/` is generated shadcn code.
- `dev/`: the local UI playground (fake FreeAgent, test data). It is never deployed.
- `test/`: Vitest in the Workers pool, against a local D1.

## Conventions

- The receipt states, the actions each state allows, and their labels live only in `src/ui/app.ts`. The UI shows what the API returns.
- API response shapes live in `src/ui/api-types.ts`, which imports nothing, so `ui/` can import it too. Logic the UI shares (`src/ui/stats.ts`) is import-free for the same reason, and `test/` covers it.
- Money is an integer in minor units with a currency code. Times are ISO strings in UTC.
- Tests use fakes for FreeAgent, the model, email and exchange rates. A test never reaches the network.
- A behaviour change ships with a test. The UI tests assert the API's JSON, not markup.
- Copy the user reads is plain English in short sentences, and says what to do next.

## Review guidelines

Rank findings by harm. Treat these as P0 or P1:

- Anything that breaks a rule in `SECURITY.md`.
- A receipt that can be lost: dropped before it is stored, deleted by mistake, or left in a state no action can move it out of.
- A receipt filed against the wrong bank line, or filed twice. Auto-filing needs exactly one fitting line and a confidence of at least `CONFIDENCE_AUTO`. A FreeAgent attach runs only while the receipt holds its attach claim (`claimForAttach`).
- A new route or endpoint outside the owner check, or a state change on a GET.
- Behaviour that changes without a test that would catch it going back.

Review `dev/` and `ui/src/dev/` only for one thing: code that could reach production, such as `src/` importing from `dev/`, or the dev panel loading outside localhost.
