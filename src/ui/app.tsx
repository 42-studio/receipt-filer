import { Hono, type Context } from "hono";
import { html } from "hono/html";
import { addEvent, deleteReceipt, getReceipt, getSetting, listEvents, listFiles, listReceipts, pin, releaseClaim, unpin, updateReceipt, usedLines, type Receipt, type State } from "../db";
import { MANUAL_MATCH_DAYS, type Env } from "../env";
import * as freeagent from "../freeagent/client";
import { FreeAgentAuthError, FreeAgentUnavailable, type BankLine } from "../freeagent/client";
import { runMatcher } from "../match/run";
import { readReceipt } from "../read/reader";

export interface AppDeps {
  fa: Pick<typeof freeagent, "listBankLines" | "getBankLine" | "authoriseUrl" | "exchangeCode" | "isConnected">;
  read: (env: Env, receiptId: string) => Promise<void>;
  runMatcher: (env: Env, receiptId: string) => Promise<void>;
}

const defaults: AppDeps = { fa: freeagent, read: (env, id) => readReceipt(env, id), runMatcher: (env, id) => runMatcher(env, {}, id) };

type Action = "match" | "retry" | "delete";
// The table under "Receipt states" in the design. It is binding.
const ACTIONS: Record<State, Action[]> = {
  reading: ["delete"], // it can sit here for up to a day when the model is down
  could_not_read: ["match", "retry", "delete"],
  duplicate: ["delete"],
  waiting_payment: ["match", "retry", "delete"],
  needs_choice: ["match", "delete"],
  waiting_explanation: ["match", "delete"],
  filed: ["delete"],
  failed: ["match", "retry", "delete"],
};
const STATE_LABEL: Record<State, string> = {
  reading: "Reading", could_not_read: "Could not read", duplicate: "Duplicate", waiting_payment: "Waiting for payment",
  needs_choice: "Needs your choice", waiting_explanation: "Matched, waiting for explanation", filed: "Filed", failed: "Failed",
};
const REASON_LABEL: Record<string, string> = {
  no_attachment: "no receipt file", file_too_large: "file too large", unreadable_file: "file could not be read", no_total: "no total found", zero_total: "zero total",
};
const SAFE_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "image/heic", "image/heif"]);
const DAY_MS = 86_400_000;
const STATE_TTL_MS = 600_000;

const money = (minor: number | null, currency: string | null) => {
  if (minor === null) return "–";
  const abs = Math.abs(minor);
  return `${currency ? `${currency} ` : ""}${minor < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
};
const day = (iso: string | null) => (iso ?? "").slice(0, 10) || "–";
const receiptDay = (r: Receipt) => r.receiptDate ?? r.emailDate?.slice(0, 10) ?? r.receivedAt.slice(0, 10);
const why = (r: Receipt) => (r.reason ? (REASON_LABEL[r.reason] ?? r.reason) : null);

const CSS = `
:root{color-scheme:light dark;font-family:system-ui,sans-serif;line-height:1.4}
body{margin:0 auto;max-width:60rem;padding:1rem}
nav{display:flex;gap:1rem;margin-bottom:1rem}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:.4rem .5rem;border-bottom:1px solid #8884;vertical-align:top}
button,.btn{font:inherit;padding:.25rem .6rem;cursor:pointer}
form{display:inline}
details{display:inline-block}
.muted{opacity:.7}
.err{color:#b00020}
img,iframe{max-width:100%;border:1px solid #8884}
iframe{width:100%;height:32rem}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem}
dd{margin:0;overflow-wrap:anywhere}
@media(max-width:640px){thead{display:none}tr,td{display:block}tr{border-bottom:1px solid #8884;padding:.5rem 0}td{border:0;padding:.1rem 0}td[data-l]::before{content:attr(data-l);display:inline-block;min-width:6rem;opacity:.7}}
`;

const Layout = ({ title, children }: { title: string; children?: unknown }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title} · Receipt filer</title>
      <style>{CSS}</style>
    </head>
    <body>
      <nav><a href="/">Queue</a><a href="/settings">Settings</a></nav>
      <h1>{title}</h1>
      {children}
    </body>
  </html>
);

const Actions = ({ r }: { r: Receipt }) => {
  const a = ACTIONS[r.state];
  return (
    <>
      {a.includes("match") && <a class="btn" href={`/receipts/${r.id}/match`}>Match</a>}{" "}
      {a.includes("retry") && <form method="post" action={`/receipts/${r.id}/retry`}><button>Retry</button></form>}{" "}
      {a.includes("delete") && (
        <details><summary>Delete</summary><form method="post" action={`/receipts/${r.id}/delete`}><button>Confirm delete</button></form></details>
      )}
    </>
  );
};

const StateCell = ({ r }: { r: Receipt }) => <>{STATE_LABEL[r.state]}{why(r) && <span class={r.state === "failed" ? "err" : "muted"}> ({why(r)})</span>}</>;

const Queue = ({ receipts }: { receipts: Receipt[] }) =>
  receipts.length === 0 ? <p>No receipts yet.</p> : (
    <table>
      <thead><tr><th>Receipt</th><th>Amount</th><th>Received</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>
        {receipts.map((r) => (
          <tr>
            <td><a href={`/receipts/${r.id}`}>{r.supplier || r.subject || "(no subject)"}</a></td>
            <td data-l="Amount">{money(r.totalMinor, r.currency)}</td>
            <td data-l="Received">{day(r.receivedAt)}</td>
            <td data-l="Status"><StateCell r={r} /></td>
            <td><Actions r={r} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );

const Field = ({ k, children }: { k: string; children?: unknown }) => <><dt>{k}</dt><dd>{children}</dd></>;

const ReceiptPage = ({ r, files, events }: { r: Receipt; files: Awaited<ReturnType<typeof listFiles>>; events: { at: string; message: string }[] }) => (
  <Layout title={r.supplier || r.subject || "Receipt"}>
    <p><Actions r={r} /></p>
    <dl>
      <Field k="Status"><StateCell r={r} /></Field>
      <Field k="Supplier">{r.supplier ?? "–"}</Field>
      <Field k="Total">{money(r.totalMinor, r.currency)}</Field>
      <Field k="Receipt date">{day(r.receiptDate)}</Field>
      <Field k="Confidence">{r.confidence === null ? "–" : `${r.confidence.toFixed(2)} (${r.inputKind ?? "?"})`}</Field>
      <Field k="Email subject">{r.subject ?? "–"}</Field>
      <Field k="From">{r.sender ?? "–"}</Field>
      <Field k="Received">{day(r.receivedAt)}</Field>
      <Field k="Bank line">{r.pinnedLine ? `${r.pinnedLine} (${r.pinnedBy})` : "none"}</Field>
      {r.duplicateOf && <Field k="Duplicate of"><a href={`/receipts/${r.duplicateOf}`}>{r.duplicateOf}</a></Field>}
    </dl>
    <h2>Files</h2>
    {files.length === 0 && <p class="muted">No files.</p>}
    {r.state === "filed" && files.length > 0 && <p class="muted">Attached in FreeAgent; the stored copies are removed after filing.</p>}
    {files.map((f) => {
      const src = `/receipts/${r.id}/files/${f.id}`;
      return (
        <div>
          <p>{r.state === "filed" ? f.filename : <a href={src}>{f.filename}</a>} <span class="muted">({f.contentType}, {f.size} bytes)</span></p>
          {r.state !== "filed" && f.contentType.startsWith("image/") && !f.contentType.includes("hei") && <img src={src} alt={f.filename} loading="lazy" />}
          {r.state !== "filed" && f.contentType === "application/pdf" && <iframe src={src} title={f.filename} loading="lazy" />}
        </div>
      );
    })}
    <h2>History</h2>
    <ul>{events.map((e) => <li><span class="muted">{e.at.slice(0, 16).replace("T", " ")}</span> {e.message}</li>)}</ul>
  </Layout>
);

const MatchPage = ({ r, lines, q, own, held }: { r: Receipt; lines: BankLine[]; q: string; own: string | null; held: Set<string> }) => (
  <Layout title="Match a bank line">
    <p><a href={`/receipts/${r.id}`}>{r.supplier || r.subject || "Receipt"}</a>: {money(r.totalMinor, r.currency)} on {receiptDay(r)}. Bank lines within {MANUAL_MATCH_DAYS} days.</p>
    <form method="get" action={`/receipts/${r.id}/match`}><input name="q" value={q} placeholder="Filter" /> <button>Filter</button></form>
    {lines.length === 0 ? <p>No bank lines found.</p> : (
      <table>
        <thead><tr><th>Date</th><th>Amount</th><th>Description</th><th>Explained</th><th></th></tr></thead>
        <tbody>
          {lines.map((l) => {
            const taken = held.has(l.url) && l.url !== own;
            return (
              <tr>
                <td data-l="Date">{l.datedOn}</td>
                <td data-l="Amount">{money(l.amountMinor, null)}</td>
                <td>{l.description}</td>
                <td data-l="Explained">{l.explanations.length ? "explained" : "not explained"}{taken && <span class="err"> · held by another receipt</span>}{l.url === own && " · current match"}</td>
                <td>{!taken && <form method="post" action={`/receipts/${r.id}/match`}><input type="hidden" name="line" value={l.url} /><button>Match</button></form>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    )}
  </Layout>
);

/** The line URL, normalised, when it is a bank transaction under the FreeAgent base URL; otherwise null. */
function ownLine(env: Env, raw: string): string | null {
  try {
    const base = new URL(env.FREEAGENT_BASE_URL).href.replace(/\/$/, "");
    const u = new URL(raw);
    if (u.search || u.hash || u.username || u.password) return null;
    const rest = u.href.startsWith(`${base}/bank_transactions/`) ? u.href.slice(`${base}/bank_transactions/`.length) : "";
    return /^\d+$/.test(rest) ? u.href : null;
  } catch {
    return null;
  }
}

const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

export function createApp(partial: Partial<AppDeps> = {}) {
  const d: AppDeps = { ...defaults, ...partial };
  const app = new Hono<{ Bindings: Env }>();
  type C = Context<{ Bindings: Env }>;

  const page = (c: C, node: unknown, status: 200 | 400 | 404 | 409 | 503 | 500 = 200) => {
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    return c.html(html`<!DOCTYPE html>${node as never}`, status);
  };
  const message = (c: C, status: 200 | 400 | 404 | 409 | 503 | 500, text: string) => page(c, <Layout title={status === 404 ? "Not found" : status >= 500 ? "Problem" : "Cannot do that"}><p>{text}</p></Layout>, status);

  // Access puts the signed-in person on the execution context. No context identity means Access did not authenticate this request.
  app.use("*", async (c, next) => {
    const owner = c.env.OWNER_EMAIL?.trim().toLowerCase();
    let email: string | undefined;
    try {
      email = (await (c.executionCtx as ExecutionContext).access?.getIdentity())?.email?.trim().toLowerCase();
    } catch {
      email = undefined;
    }
    if (!owner || email !== owner) return c.text("Forbidden", 403);
    if (c.req.method === "POST" && c.req.header("Origin") !== new URL(c.req.url).origin) return c.text("Forbidden", 403);
    await next();
  });

  app.onError((e, c) => {
    if (e instanceof FreeAgentAuthError) return message(c, 503, "FreeAgent needs a new sign-in. Connect it again on the Settings page.");
    if (e instanceof FreeAgentUnavailable) return message(c, 503, "FreeAgent could not be reached. Try again in a few minutes.");
    console.error("request failed", e);
    return message(c, 500, "Something went wrong. The error is in the Worker log.");
  });

  app.get("/health", (c) => c.text("ok"));

  app.get("/", async (c) => page(c, <Layout title="Receipts"><Queue receipts={await listReceipts(c.env.DB)} /></Layout>));

  app.get("/settings", async (c) => {
    const connected = await d.fa.isConnected(c.env);
    return page(c,
      <Layout title="Settings">
        <dl>
          <Field k="Forwarding address">{c.env.FORWARD_ADDRESS || "not set"}</Field>
          <Field k="FreeAgent">{connected ? "Connected" : "Not connected"} <span class="muted">({c.env.FREEAGENT_BASE_URL})</span></Field>
        </dl>
        <form method="get" action="/oauth/start"><button>{connected ? "Reconnect FreeAgent" : "Connect FreeAgent"}</button></form>
      </Layout>);
  });

  const redirectUri = (c: C) => `${new URL(c.req.url).origin}/oauth/callback`;

  app.get("/oauth/start", async (c) => {
    const state = hex(24);
    await c.env.DB.prepare("INSERT INTO settings (key, value) VALUES ('oauth_state', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(`${state}.${Date.now()}`).run();
    return c.redirect(d.fa.authoriseUrl(c.env, state, redirectUri(c)), 302);
  });

  app.get("/oauth/callback", async (c) => {
    const [state, at] = ((await getSetting(c.env.DB, "oauth_state")) ?? "").split(".");
    const given = c.req.query("state");
    const code = c.req.query("code");
    if (!state || !given || given !== state || Date.now() - Number(at) > STATE_TTL_MS) return message(c, 400, "The sign-in link is not valid or has expired. Start again from Settings.");
    await c.env.DB.prepare("DELETE FROM settings WHERE key = 'oauth_state'").run(); // single use
    if (!code) return message(c, 400, `FreeAgent did not give a code${c.req.query("error") ? `: ${c.req.query("error")}` : ""}. Start again from Settings.`);
    await d.fa.exchangeCode(c.env, code, redirectUri(c));
    return c.redirect("/settings", 303);
  });

  // Loads the receipt and checks the action fits its state; a Response means stop.
  const guard = async (c: C, action: Action): Promise<Receipt | Response> => {
    const r = await getReceipt(c.env.DB, c.req.param("id")!);
    if (!r) return message(c, 404, "No such receipt.");
    if (!ACTIONS[r.state].includes(action)) return message(c, 409, `${STATE_LABEL[r.state]} receipts cannot be ${action === "match" ? "matched" : action === "retry" ? "retried" : "deleted"}.`);
    return r;
  };

  app.get("/receipts/:id", async (c) => {
    const r = await getReceipt(c.env.DB, c.req.param("id"));
    if (!r) return message(c, 404, "No such receipt.");
    return page(c, <ReceiptPage r={r} files={await listFiles(c.env.DB, r.id)} events={await listEvents(c.env.DB, r.id)} />);
  });

  app.get("/receipts/:id/files/:fileId", async (c) => {
    const file = (await listFiles(c.env.DB, c.req.param("id"))).find((f) => f.id === c.req.param("fileId"));
    const obj = file && (await c.env.FILES.get(file.r2Key));
    if (!file || !obj) return c.text("Not found", 404);
    const safe = SAFE_TYPES.has(file.contentType);
    return new Response(obj.body, {
      headers: {
        "Content-Type": safe ? file.contentType : "application/octet-stream",
        "Content-Disposition": safe ? "inline" : "attachment",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  });

  app.get("/receipts/:id/match", async (c) => {
    const r = await guard(c, "match");
    if (r instanceof Response) return r;
    const centre = Date.parse(receiptDay(r)) || Date.parse(r.receivedAt);
    const from = new Date(centre - MANUAL_MATCH_DAYS * DAY_MS).toISOString().slice(0, 10);
    const to = new Date(centre + MANUAL_MATCH_DAYS * DAY_MS).toISOString().slice(0, 10);
    const q = (c.req.query("q") ?? "").trim();
    const needle = q.toLowerCase();
    const lines = (await d.fa.listBankLines(c.env, from))
      .filter((l) => l.datedOn >= from && l.datedOn <= to)
      .filter((l) => !needle || `${l.description} ${l.datedOn} ${money(l.amountMinor, null)}`.toLowerCase().includes(needle))
      .sort((a, b) => b.datedOn.localeCompare(a.datedOn));
    return page(c, <MatchPage r={r} lines={lines} q={q} own={r.pinnedLine} held={await usedLines(c.env.DB)} />);
  });

  app.post("/receipts/:id/match", async (c) => {
    const r = await guard(c, "match");
    if (r instanceof Response) return r;
    const raw = (await c.req.parseBody()).line;
    const url = typeof raw === "string" ? ownLine(c.env, raw) : null;
    if (!url || !(await d.fa.getBankLine(c.env, url))) return message(c, 400, "That is not a bank transaction in FreeAgent.");
    if (!(await pin(c.env.DB, r.id, url, "manual"))) return message(c, 409, "Another receipt already holds that bank line.");
    if (r.state === "failed") await releaseClaim(c.env.DB, r.id); // an unconfirmed attach keeps it held; Josh has checked FreeAgent
    await updateReceipt(c.env.DB, r.id, { state: "waiting_payment", reason: null }); // the matcher acts on a pinned receipt in this state
    await addEvent(c.env.DB, r.id, `Matched by hand to bank line ${url}`);
    await d.runMatcher(c.env, r.id);
    return c.redirect(`/receipts/${r.id}`, 303);
  });

  app.post("/receipts/:id/retry", async (c) => {
    const r = await guard(c, "retry");
    if (r instanceof Response) return r;
    if (r.pinnedBy === "auto") await unpin(c.env.DB, r.id); // a manual pin stays
    if (r.state === "failed") await releaseClaim(c.env.DB, r.id); // an unconfirmed attach keeps it held; Josh has checked FreeAgent
    await updateReceipt(c.env.DB, r.id, { state: "reading", reason: null, supplier: null, totalMinor: null, currency: null, receiptDate: null, confidence: null, inputKind: null });
    await addEvent(c.env.DB, r.id, "Retry requested");
    await d.read(c.env, r.id);
    await d.runMatcher(c.env, r.id);
    return c.redirect(`/receipts/${r.id}`, 303);
  });

  app.post("/receipts/:id/delete", async (c) => {
    const r = await guard(c, "delete");
    if (r instanceof Response) return r;
    const files = await deleteReceipt(c.env.DB, r.id);
    try {
      if (files.length) await c.env.FILES.delete(files.map((f) => f.r2Key)); // filed receipts have none left; FreeAgent is not touched
    } catch (e) {
      console.error("R2 delete failed", r.id, e);
    }
    return c.redirect("/", 303);
  });

  return app;
}
