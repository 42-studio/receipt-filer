import { Hono, type Context } from "hono";
import { addEvent, deleteReceipt, getReceipt, getSetting, listEvents, listFiles, listReceipts, pin, releaseClaim, unpin, updateReceipt, usedLines, type Receipt, type State, type StoredFile } from "../db";
import { MANUAL_MATCH_DAYS, type Env } from "../env";
import * as freeagent from "../freeagent/client";
import { FreeAgentAuthError, FreeAgentUnavailable } from "../freeagent/client";
import { rateToGbp } from "../match/fx";
import { decide } from "../match/matcher";
import { runMatcher } from "../match/run";
import { readReceipt } from "../read/reader";
import type { Action, EmailInfo, FileInfo, ListResponse, MatchResponse, ReceiptDetail, ReceiptResponse, ReceiptRow, SettingsResponse, Tone } from "./api-types";

export interface AppDeps {
  fa: Pick<typeof freeagent, "listBankLines" | "getBankLine" | "authoriseUrl" | "exchangeCode" | "isConnected">;
  read: (env: Env, receiptId: string) => Promise<void>;
  runMatcher: (env: Env, receiptId: string) => Promise<void>;
  rate: typeof rateToGbp;
}

const defaults: AppDeps = { fa: freeagent, read: (env, id) => readReceipt(env, id), runMatcher: (env, id) => runMatcher(env, {}, id), rate: rateToGbp };

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
const STATE_TONE: Record<State, Tone> = {
  reading: "info", could_not_read: "warn", duplicate: "neutral", waiting_payment: "info",
  needs_choice: "warn", waiting_explanation: "info", filed: "ok", failed: "bad",
};
const REASON_LABEL: Record<string, string> = {
  no_attachment: "no receipt file", file_too_large: "file too large", unreadable_file: "file could not be read", no_total: "no total found", zero_total: "zero total",
};
const SAFE_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "image/heic", "image/heif"]);
const DAY_MS = 86_400_000;
const STATE_TTL_MS = 600_000;
// script-src 'self' runs only the built bundle; style-src keeps 'unsafe-inline' for the style attributes Radix sets.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; frame-src 'self'; connect-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const money = (minor: number | null, currency: string | null) => {
  if (minor === null) return "–";
  const abs = Math.abs(minor);
  const units = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); // 12,345,678
  return `${currency ? `${currency} ` : ""}${minor < 0 ? "-" : ""}${units}.${String(abs % 100).padStart(2, "0")}`;
};
const receiptDay = (r: Receipt) => r.receiptDate ?? r.emailDate?.slice(0, 10) ?? r.receivedAt.slice(0, 10);

const row = (r: Receipt): ReceiptRow => ({
  id: r.id, title: r.supplier || r.subject || "(no subject)", subject: r.subject, supplier: r.supplier,
  amount: money(r.totalMinor, r.currency), received: r.receivedAt.slice(0, 10),
  state: r.state, stateLabel: STATE_LABEL[r.state], tone: STATE_TONE[r.state],
  reason: r.reason ? (REASON_LABEL[r.reason] ?? r.reason) : null, actions: ACTIONS[r.state], duplicateOf: r.duplicateOf,
  totalMinor: r.totalMinor, currency: r.currency, filedAt: r.filedAt, pinnedBy: r.pinnedBy,
});
const detail = (r: Receipt): ReceiptDetail => ({
  ...row(r), receiptDate: r.receiptDate, confidence: r.confidence === null ? null : `${r.confidence.toFixed(2)} (${r.inputKind ?? "?"})`,
  sender: r.sender, pinnedLine: r.pinnedLine, filed: r.state === "filed",
});

const fileInfos = (r: Receipt, files: StoredFile[]): FileInfo[] => {
  const filed = r.state === "filed"; // the stored copies are removed after filing
  return files.map((f) => ({
    id: f.id, filename: f.filename, contentType: f.contentType, size: f.size,
    url: filed ? null : `/api/receipts/${r.id}/files/${f.id}`,
    preview: filed ? null : f.contentType === "application/pdf" ? "pdf" : f.contentType.startsWith("image/") && !f.contentType.includes("hei") ? "image" : null,
  }));
};
const emailInfo = (r: Receipt): EmailInfo => ({ from: r.sender, subject: r.subject, date: r.emailDate, bodyUrl: r.body ? `/api/receipts/${r.id}/body` : null });
// The email body is untrusted: no script, no same origin, no network (remote images stay blank), framed only by this app.
const BODY_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'";

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
  type Status = 400 | 404 | 409 | 503 | 500;
  const fail = (c: C, status: Status, error: string) => c.json({ error }, status);

  // Access puts the signed-in person on the execution context. No context identity means Access did not authenticate this request.
  // This runs before everything, the UI's static files included (run_worker_first).
  app.use("*", async (c, next) => {
    const owner = c.env.OWNER_EMAIL?.trim().toLowerCase();
    let email: string | undefined;
    try {
      email = (await (c.executionCtx as ExecutionContext).access?.getIdentity())?.email?.trim().toLowerCase();
    } catch {
      email = undefined;
    }
    if (!owner || email !== owner) return c.text("Forbidden", 403);
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.header("Origin") !== new URL(c.req.url).origin) return c.text("Forbidden", 403);
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
  });

  app.onError((e, c) => {
    if (e instanceof FreeAgentAuthError) return fail(c, 503, "FreeAgent needs a new sign-in. Connect it again on the Settings page.");
    if (e instanceof FreeAgentUnavailable) return fail(c, 503, "FreeAgent could not be reached. Try again in a few minutes.");
    console.error("request failed", e);
    return fail(c, 500, "Something went wrong. The error is in the Worker log.");
  });

  app.get("/health", (c) => c.text("ok"));

  app.get("/api/receipts", async (c) => c.json({ receipts: (await listReceipts(c.env.DB)).map(row) } satisfies ListResponse));

  app.get("/api/settings", async (c) =>
    c.json({ forwardAddress: c.env.FORWARD_ADDRESS || null, connected: await d.fa.isConnected(c.env), baseUrl: c.env.FREEAGENT_BASE_URL } satisfies SettingsResponse));

  const redirectUri = (c: C) => `${new URL(c.req.url).origin}/oauth/callback`;

  // A full-page link, not fetch: the browser must follow the redirect to FreeAgent.
  app.get("/oauth/start", async (c) => {
    const state = hex(24);
    await c.env.DB.prepare("INSERT INTO settings (key, value) VALUES ('oauth_state', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(`${state}.${Date.now()}`).run();
    return c.redirect(d.fa.authoriseUrl(c.env, state, redirectUri(c)), 302);
  });

  // Errors go back to Settings as a fixed code, never free text, so a crafted link cannot put words on the page.
  app.get("/oauth/callback", async (c) => {
    const [state, at] = ((await getSetting(c.env.DB, "oauth_state")) ?? "").split(".");
    const given = c.req.query("state");
    const code = c.req.query("code");
    if (!state || !given || given !== state || Date.now() - Number(at) > STATE_TTL_MS) return c.redirect("/settings?oauth=invalid", 303);
    await c.env.DB.prepare("DELETE FROM settings WHERE key = 'oauth_state'").run(); // single use
    if (!code) return c.redirect("/settings?oauth=no_code", 303);
    await d.fa.exchangeCode(c.env, code, redirectUri(c));
    return c.redirect("/settings?oauth=connected", 303);
  });

  // Loads the receipt and checks the action fits its state; a Response means stop.
  const guard = async (c: C, action: Action): Promise<Receipt | Response> => {
    const r = await getReceipt(c.env.DB, c.req.param("id")!);
    if (!r) return fail(c, 404, "No such receipt.");
    if (!ACTIONS[r.state].includes(action)) return fail(c, 409, `${STATE_LABEL[r.state]} receipts cannot be ${action === "match" ? "matched" : action === "retry" ? "retried" : "deleted"}.`);
    return r;
  };

  app.get("/api/receipts/:id", async (c) => {
    const r = await getReceipt(c.env.DB, c.req.param("id"));
    if (!r) return fail(c, 404, "No such receipt.");
    return c.json({ receipt: detail(r), files: fileInfos(r, await listFiles(c.env.DB, r.id)), events: await listEvents(c.env.DB, r.id), email: emailInfo(r) } satisfies ReceiptResponse);
  });

  app.get("/api/receipts/:id/body", async (c) => {
    const r = await getReceipt(c.env.DB, c.req.param("id"));
    if (!r?.body) return c.text("Not found", 404);
    return new Response(r.body, {
      headers: {
        "Content-Type": `${r.bodyIsHtml ? "text/html" : "text/plain"}; charset=utf-8`,
        "Content-Security-Policy": BODY_CSP,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  });

  app.get("/api/receipts/:id/files/:fileId", async (c) => {
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

  app.get("/api/receipts/:id/match", async (c) => {
    const r = await guard(c, "match");
    if (r instanceof Response) return r;
    const centre = Date.parse(receiptDay(r)) || Date.parse(r.receivedAt);
    const from = new Date(centre - MANUAL_MATCH_DAYS * DAY_MS).toISOString().slice(0, 10);
    const to = new Date(centre + MANUAL_MATCH_DAYS * DAY_MS).toISOString().slice(0, 10);
    const near = (await d.fa.listBankLines(c.env, from, false)) // every currency: a non-GBP payment is matched here by hand
      .filter((l) => l.datedOn >= from && l.datedOn <= to);
    const held = await usedLines(c.env.DB);
    // The lines the matcher's rules accept for this receipt go first, marked fits.
    let fits = new Set<string>();
    if (r.totalMinor !== null && r.currency) {
      const others = new Set([...held].filter((u) => u !== r.pinnedLine));
      const rate = r.currency === "GBP" ? 1 : await d.rate(c.env, receiptDay(r), r.currency);
      const dec = decide({ totalMinor: r.totalMinor, currency: r.currency, date: receiptDay(r), supplier: r.supplier, confidence: r.confidence ?? 0, inputKind: r.inputKind ?? "text" }, near, others, rate);
      fits = new Set((dec.kind === "match" ? [dec.line] : dec.kind === "choice" ? dec.lines : []).map((l) => l.url));
    }
    const lines = near
      .sort((a, b) => Number(fits.has(b.url)) - Number(fits.has(a.url)) || b.datedOn.localeCompare(a.datedOn))
      .map((l) => ({
        url: l.url, datedOn: l.datedOn, amount: money(l.amountMinor, null), description: l.description, explained: l.explanations.length > 0,
        fits: fits.has(l.url), heldByOther: held.has(l.url) && l.url !== r.pinnedLine, current: l.url === r.pinnedLine,
      }));
    const files = fileInfos(r, await listFiles(c.env.DB, r.id));
    return c.json({ receipt: row(r), receiptDay: receiptDay(r), windowDays: MANUAL_MATCH_DAYS, lines, files, email: emailInfo(r) } satisfies MatchResponse);
  });

  app.post("/api/receipts/:id/match", async (c) => {
    const r = await guard(c, "match");
    if (r instanceof Response) return r;
    const raw = ((await c.req.json().catch(() => ({}))) as { line?: unknown }).line;
    const url = typeof raw === "string" ? ownLine(c.env, raw) : null;
    if (!url || !(await d.fa.getBankLine(c.env, url))) return fail(c, 400, "That is not a bank transaction in FreeAgent.");
    if (!(await pin(c.env.DB, r.id, url, "manual"))) return fail(c, 409, "Another receipt already holds that bank line.");
    if (r.state === "failed") await releaseClaim(c.env.DB, r.id); // an unconfirmed attach keeps it held; Josh has checked FreeAgent
    await updateReceipt(c.env.DB, r.id, { state: "waiting_payment", reason: null }); // the matcher acts on a pinned receipt in this state
    await addEvent(c.env.DB, r.id, `Matched by hand to bank line ${url}`);
    await d.runMatcher(c.env, r.id);
    return c.json({ receipt: detail((await getReceipt(c.env.DB, r.id))!) });
  });

  app.post("/api/receipts/:id/retry", async (c) => {
    const r = await guard(c, "retry");
    if (r instanceof Response) return r;
    if (r.pinnedBy === "auto") await unpin(c.env.DB, r.id); // a manual pin stays
    if (r.state === "failed") await releaseClaim(c.env.DB, r.id); // an unconfirmed attach keeps it held; Josh has checked FreeAgent
    await updateReceipt(c.env.DB, r.id, { state: "reading", reason: null, supplier: null, totalMinor: null, currency: null, receiptDate: null, confidence: null, inputKind: null });
    await addEvent(c.env.DB, r.id, "Retry requested");
    await d.read(c.env, r.id);
    await d.runMatcher(c.env, r.id);
    return c.json({ receipt: detail((await getReceipt(c.env.DB, r.id))!) });
  });

  app.delete("/api/receipts/:id", async (c) => {
    const r = await guard(c, "delete");
    if (r instanceof Response) return r;
    const files = await deleteReceipt(c.env.DB, r.id);
    try {
      if (files.length) await c.env.FILES.delete(files.map((f) => f.r2Key)); // filed receipts have none left; FreeAgent is not touched
    } catch (e) {
      console.error("R2 delete failed", r.id, e);
    }
    return c.json({ ok: true });
  });

  app.all("/api/*", (c) => fail(c, 404, "No such API route."));

  // Everything else is the UI: a built file, or index.html for a client route (not_found_handling).
  app.get("*", async (c) => {
    const res = await c.env.ASSETS.fetch(c.req.raw);
    const out = new Response(res.body, res);
    if (out.headers.get("Content-Type")?.startsWith("text/html")) {
      out.headers.set("Content-Security-Policy", CSP);
      out.headers.set("Cache-Control", "no-cache"); // the hashed bundle files can cache; the page that names them cannot
    }
    return out;
  });

  return app;
}
