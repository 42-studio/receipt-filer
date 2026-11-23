# Security

## Reporting a vulnerability

Report it privately through GitHub: the repository's **Security** tab, then **Report a vulnerability**. Please do not open a public issue. Only the `main` branch and the Worker deployed from it are supported.

## What must hold

Receipt filer has one user, the owner. It holds FreeAgent OAuth tokens that can change the owner's books, and it stores email that anyone could have written. These rules keep both safe. A change that breaks one is a security bug.

### Access

1. Only the owner reaches the app. Every request, including `/health`, the API and the UI's static files, passes the owner check in `src/ui/app.ts`: a Cloudflare Access identity whose email equals `OWNER_EMAIL`. A missing identity, another email, or a blank `OWNER_EMAIL` gets 403. `run_worker_first` in `wrangler.jsonc` keeps the static files behind this check.
2. A request that changes data uses a method other than GET, and its `Origin` must equal the request's own origin.
3. The UI page's Content-Security-Policy allows scripts and styles from the Worker's own origin only (plus inline style attributes), and `frame-ancestors 'none'`.

### Email content is untrusted

4. Only email from `ALLOWED_SENDERS` is stored. Gmail's forwarding confirmation is passed to `NOTIFY_TO`; the app's own notifications, forwarded back, are dropped.
5. The subject, sender, body and attachments are data from outside. The UI shows them as text (React escaping); nothing uses `dangerouslySetInnerHTML` or `innerHTML`.
6. An email body is served only from `/api/receipts/:id/body`, under a `sandbox` Content-Security-Policy with no network, and shown in an `<iframe sandbox="">`. It runs no script and loads nothing remote.
7. Stored files are served inline only for the types in `SAFE_TYPES`, always with `nosniff`. Any other type downloads as an attachment.
8. What the model reads from a receipt is data: a supplier, a total, a date and a confidence. Receipt text never becomes an instruction, a URL or a request.

### FreeAgent

9. The OAuth `state` is random, single use, and expires after 10 minutes. Tokens are stored only in the D1 `settings` table.
10. A bank line URL from the browser is checked (`ownLine`) to be `FREEAGENT_BASE_URL/bank_transactions/<digits>` before the Worker calls it with the owner's token.

### Secrets and development

11. Secrets (`FORWARD_ADDRESS`, `ALLOWED_SENDERS`, `NOTIFY_TO`, `OWNER_EMAIL`, `FREEAGENT_CLIENT_ID`, `FREEAGENT_CLIENT_SECRET`) are Worker secrets. They are never in `wrangler.jsonc` vars, code, logs or tests; tests use example values. `.dev.vars` is ignored by git.
12. The `dev/` playground and its `/__*` routes exist only in the dev Worker (`dev/wrangler.jsonc`), which is never deployed. The UI loads its dev panel only on `localhost`, and shows it only when the dev Worker answers.
13. Errors shown to the user are plain messages. Details go to the Worker log only.

## Out of scope

Weaknesses in Cloudflare, Cloudflare Access, FreeAgent or Gmail themselves, and volume-based denial of service.
