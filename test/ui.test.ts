import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { addFile, createReceipt, getReceipt, getSetting, listEvents, listFiles, pin, setSetting, updateReceipt, type Receipt } from "../src/db";
import type { Env } from "../src/env";
import { FreeAgentUnavailable, pickExplanation, type BankLine } from "../src/freeagent/client";
import { runMatcher } from "../src/match/run";
import type { ListResponse, MatchResponse, ReceiptResponse, SettingsResponse } from "../src/ui/api-types";
import { createApp, type AppDeps } from "../src/ui/app";

const OWNER = "owner@example.com";
const BASE = "https://api.sandbox.freeagent.com/v2";
const NOW = new Date("2026-11-15T10:00:00Z");
const ASSETS = { fetch: async (req: Request) => new Response(`<!DOCTYPE html><title>ui ${new URL(req.url).pathname}</title>`, { headers: { "Content-Type": "text/html" } }) };
// defineProperty, not assignment: assigning through the prototype would write to the shared env.
const withVars = (vars: Record<string, unknown>) => Object.create(env, Object.fromEntries(Object.entries(vars).map(([k, value]) => [k, { value }]))) as Env;
const E = withVars({ ASSETS: ASSETS as never, OWNER_EMAIL: OWNER, FORWARD_ADDRESS: "receipts-k3v9x2@example.com", APP_URL: "https://receipts.example.com" });
const line = (n: number, o: Partial<BankLine> = {}): BankLine => ({ url: `${BASE}/bank_transactions/${n}`, datedOn: "2026-11-14", amountMinor: -2400, description: "ACME LTD", explanations: [{ url: `${BASE}/bank_transaction_explanations/${n}`, grossMinor: -2400 }], ...o });

// Fakes only: no FreeAgent, rate, AI or email call is made.
function setup(lines: BankLine[] = [line(1)]) {
  const calls: string[] = [];
  const f = { lines, listError: null as Error | null, attached: [] as string[] };
  const fa = {
    listBankLines: async (_e: Env, from: string, gbpOnly = true) => { calls.push(`list ${from}${gbpOnly ? "" : " all currencies"}`); if (f.listError) throw f.listError; return f.lines; },
    getBankLine: async (_e: Env, url: string) => { calls.push(`get ${url}`); if (f.listError) throw f.listError; return f.lines.find((l) => l.url === url) ?? null; },
    attach: async (_e: Env, url: string, files: unknown[]) => { calls.push(`attach ${url}`); f.attached.push(url); return files.map((_x, i) => `${url}/attachments/${i + 1}`); },
    pickExplanation,
    authoriseUrl: (_e: Env, state: string, redirect: string) => `https://fa.example.com/approve?state=${state}&redirect=${encodeURIComponent(redirect)}`,
    exchangeCode: vi.fn(async (_e: Env, _code: string, _redirect: string) => { calls.push("exchange"); await setSetting(env.DB, "freeagent_tokens", "{}"); }),
    isConnected: async () => (await getSetting(env.DB, "freeagent_tokens")) !== null,
  };
  const read = vi.fn(async (_e: Env, id: string) => { await updateReceipt(env.DB, id, { state: "waiting_payment", reason: null, supplier: "Acme", totalMinor: 2400, currency: "GBP", receiptDate: "2026-11-13", confidence: 0.9, inputKind: "text" }); });
  const match = (e: Env, id: string) => runMatcher(e, { fa, rate: async () => 1, notify: vi.fn(async () => {}), now: () => NOW, read: read as never, convert: async (_e, x) => x }, id);
  const deps: AppDeps = { fa, read, runMatcher: match, rate: async () => 1 };
  const app = createApp(deps);
  const ctx = (email: string | null | undefined) => ({ waitUntil() {}, passThroughOnException() {}, ...(email === undefined ? {} : { access: { aud: "aud", getIdentity: async () => (email === null ? undefined : { email }) } }) }) as unknown as ExecutionContext;
  const call = (path: string, o: { method?: string; email?: string | null; noAccess?: boolean; origin?: string | null; json?: unknown; e?: Env } = {}) => {
    const method = o.method ?? "GET";
    const headers: Record<string, string> = {};
    if (method !== "GET" && o.origin !== null) headers.Origin = o.origin ?? "http://localhost";
    if (o.json !== undefined) headers["Content-Type"] = "application/json";
    return app.request(path, { method, headers, ...(o.json !== undefined ? { body: JSON.stringify(o.json) } : {}), redirect: "manual" }, o.e ?? E, ctx(o.noAccess ? undefined : (o.email === undefined ? OWNER : o.email)));
  };
  const json = async <T = any>(path: string, o?: Parameters<typeof call>[1]) => (await (await call(path, o)).json()) as T;
  const matchLine = (id: string, url: string) => call(`/api/receipts/${id}/match`, { method: "POST", json: { line: url } });
  return { call, json, matchLine, f, fa, read, calls };
}

async function make(o: Partial<Receipt> = {}, fileCount = 1) {
  const r = await createReceipt(env.DB, { messageId: crypto.randomUUID(), emailDate: "2026-11-13T09:00:00Z", sender: "shop@example.com", subject: "Your receipt", body: "the body", bodyIsHtml: false, state: "waiting_payment", reason: null });
  await updateReceipt(env.DB, r.id, { supplier: "Acme", totalMinor: 2400, currency: "GBP", receiptDate: "2026-11-13", confidence: 0.9, inputKind: "text", ...o });
  for (let i = 0; i < fileCount; i++) {
    const key = `receipts/${r.id}/${i}`;
    await env.FILES.put(key, new Uint8Array([1, 2, 3, i]));
    await addFile(env.DB, { receiptId: r.id, r2Key: key, filename: `r${i}.pdf`, contentType: "application/pdf", size: 4, sha256: crypto.randomUUID() });
  }
  return (await getReceipt(env.DB, r.id))!;
}
const get = async (id: string) => (await getReceipt(env.DB, id))!;

beforeEach(async () => {
  for (const t of ["receipts", "files", "events", "settings"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

it("refuses a request with no Access identity or another person's identity", async () => {
  const { call } = setup();
  for (const path of ["/", "/api/receipts", "/assets/index.js", "/health"]) {
    expect((await call(path, { noAccess: true })).status, path).toBe(403);
    expect((await call(path, { email: null })).status, path).toBe(403);
    expect((await call(path, { email: "someone-else@example.com" })).status, path).toBe(403);
    expect((await call(path)).status, path).toBe(200);
  }
  expect((await call("/", { email: " Owner@Example.com " })).status).toBe(200);
});

it("fails closed when OWNER_EMAIL is blank", async () => {
  const { call } = setup();
  const blank = withVars({ ASSETS, OWNER_EMAIL: " " });
  expect((await call("/", { e: blank, email: "" })).status).toBe(403);
  expect((await call("/api/receipts", { e: blank })).status).toBe(403);
});

it("refuses a change from another origin", async () => {
  const { call } = setup();
  const r = await make({ state: "could_not_read" });
  expect((await call(`/api/receipts/${r.id}`, { method: "DELETE", origin: "https://evil.example.com" })).status).toBe(403);
  expect((await call(`/api/receipts/${r.id}`, { method: "DELETE", origin: null })).status).toBe(403);
  expect((await call(`/api/receipts/${r.id}/retry`, { method: "POST", origin: "https://evil.example.com" })).status).toBe(403);
  expect(await get(r.id)).toBeTruthy();
  expect((await call(`/api/receipts/${r.id}`, { method: "DELETE" })).status).toBe(200);
});

it("serves the UI for client routes with a script policy that allows only its own bundle", async () => {
  const { call } = setup();
  const res = await call("/receipts/abc/match");
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("ui /receipts/abc/match");
  const csp = res.headers.get("content-security-policy")!;
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toMatch(/script-src[^;]*unsafe/);
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  const api = await call("/api/nope");
  expect(api.status).toBe(404);
  expect(await api.json()).toEqual({ error: "No such API route." });
});

it("lists open receipts before filed ones with their actions", async () => {
  const { json } = setup();
  const filed = await make({ state: "filed", supplier: "Filed Co" });
  await env.DB.prepare("UPDATE receipts SET received_at = '2026-11-20T00:00:00Z' WHERE id = ?").bind(filed.id).run();
  const open = await make({ state: "waiting_payment", supplier: "Open Co" });
  const { receipts } = await json<ListResponse>("/api/receipts");
  expect(receipts.map((r) => r.title)).toEqual(["Open Co", "Filed Co"]);
  expect(receipts[1]).toMatchObject({ id: filed.id, actions: ["delete"], stateLabel: "Filed", tone: "ok" });
  expect(receipts[0]).toMatchObject({ id: open.id, actions: ["match", "retry", "delete"], amount: "GBP 24.00", stateLabel: "Waiting for payment" });
  expect(receipts[0]).toMatchObject({ totalMinor: 2400, currency: "GBP", filedAt: null, pinnedBy: null, duplicateOf: null });
  await updateReceipt(env.DB, open.id, { totalMinor: 1234567890 });
  expect((await json<ListResponse>("/api/receipts")).receipts[0].amount).toBe("GBP 12,345,678.90"); // thousands grouped
});

// The UI groups and filters by stage only, so every state must land in the right one.
const STAGES: Record<string, string> = {
  reading: "reading", could_not_read: "needs_you", needs_choice: "needs_you", failed: "needs_you",
  waiting_payment: "waiting", waiting_explanation: "waiting", filed: "filed", duplicate: "duplicate",
};

it("names one guided action for each state that needs one, from the actions it allows", async () => {
  const { json } = setup();
  const expected: Record<string, [string, string] | null> = {
    reading: null, could_not_read: ["match", "Match by hand"], duplicate: ["delete", "Delete"], waiting_payment: null,
    needs_choice: ["match", "Choose bank line"], waiting_explanation: null, filed: null, failed: ["retry", "Retry"],
  };
  for (const [state, want] of Object.entries(expected)) {
    const r = await make({ state: state as never });
    const { receipt } = await json<ReceiptResponse>(`/api/receipts/${r.id}`);
    expect(receipt.primary && [receipt.primary.action, receipt.primary.label], state).toEqual(want);
    expect(receipt.matchLabel, state).toBe(state === "waiting_explanation" ? "Change bank line" : "Match by hand");
    expect(receipt.stage, state).toBe(STAGES[state]);
  }
});

it("offers only the actions the state allows", async () => {
  const { call, json } = setup();
  const table: Record<string, string[]> = {
    reading: ["delete"], could_not_read: ["match", "retry", "delete"], duplicate: ["delete"], waiting_payment: ["match", "retry", "delete"],
    needs_choice: ["match", "delete"], waiting_explanation: ["match", "delete"], filed: ["delete"], failed: ["match", "retry", "delete"],
  };
  for (const [state, allowed] of Object.entries(table)) {
    const r = await make({ state: state as never });
    const { receipt } = await json<ReceiptResponse>(`/api/receipts/${r.id}`);
    expect(receipt.actions, state).toEqual(allowed);
    if (receipt.primary) expect(allowed, `${state} primary`).toContain(receipt.primary.action);
    expect((await call(`/api/receipts/${r.id}/match`)).status, `${state} GET match`).toBe(allowed.includes("match") ? 200 : 409);
    if (!allowed.includes("retry")) expect((await call(`/api/receipts/${r.id}/retry`, { method: "POST" })).status, `${state} retry`).toBe(409);
    if (!allowed.includes("delete")) expect((await call(`/api/receipts/${r.id}`, { method: "DELETE" })).status, `${state} delete`).toBe(409);
  }
});

it("returns receipt details with fields, history and file links", async () => {
  const { call, json } = setup();
  const r = await make({ state: "waiting_explanation", reason: null }, 2);
  await pin(env.DB, r.id, line(1).url, "manual");
  await env.DB.prepare("INSERT INTO events (receipt_id, at, message) VALUES (?,?,?)").bind(r.id, "2026-11-14T10:00:00Z", "Read GBP 24.00").run();
  const files = await listFiles(env.DB, r.id);
  const body = await json<ReceiptResponse>(`/api/receipts/${r.id}`);
  expect(body.receipt).toMatchObject({ supplier: "Acme", amount: "GBP 24.00", confidence: "0.90 (text)", pinnedLine: line(1).url, pinnedBy: "manual", filed: false });
  expect(body.events.map((e) => e.message)).toContain("Read GBP 24.00");
  expect(body.email).toEqual({ from: "shop@example.com", subject: "Your receipt", date: "2026-11-13T09:00:00Z", bodyUrl: `/api/receipts/${r.id}/body` });
  expect(body.files.map((f) => [f.url, f.preview])).toEqual(files.map((f) => [`/api/receipts/${r.id}/files/${f.id}`, "pdf"]));
  expect((await call("/api/receipts/nope")).status).toBe(404);
});

it("gives a filed receipt's files no link: the stored copies are gone", async () => {
  const { json } = setup();
  const r = await make({ state: "filed" }, 1);
  expect((await json<ReceiptResponse>(`/api/receipts/${r.id}`)).files.map((f) => [f.url, f.preview])).toEqual([[null, null]]);
});

it("serves a stored file inline and 404s once it is gone", async () => {
  const { call } = setup();
  const r = await make({}, 1);
  const [f] = await listFiles(env.DB, r.id);
  const res = await call(`/api/receipts/${r.id}/files/${f.id}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/pdf");
  expect(res.headers.get("content-disposition")).toBe("inline");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 0]));
  await env.FILES.delete(f.r2Key);
  expect((await call(`/api/receipts/${r.id}/files/${f.id}`)).status).toBe(404);
  const other = await make({}, 1);
  expect((await call(`/api/receipts/${other.id}/files/${f.id}`)).status).toBe(404);
});

it("never serves a stored type that a browser could run", async () => {
  const { call } = setup();
  const r = await make({}, 1);
  const [f] = await listFiles(env.DB, r.id);
  await env.DB.prepare("UPDATE files SET content_type = 'text/html' WHERE id = ?").bind(f.id).run();
  const res = await call(`/api/receipts/${r.id}/files/${f.id}`);
  expect(res.headers.get("content-type")).toBe("application/octet-stream");
  expect(res.headers.get("content-disposition")).toBe("attachment");
});

it("lists bank lines near the receipt date with explained and held flags", async () => {
  const { json, calls } = setup([
    line(1, { description: "ACME LTD" }),
    line(2, { description: "OTHER SHOP", explanations: [] }),
    line(3, { description: "ACME LATE", datedOn: "2026-12-30" }),
    line(4, { description: "ACME HELD" }),
  ]);
  const r = await make({ state: "needs_choice", receiptDate: "2026-11-13" });
  const holder = await make({ state: "waiting_explanation" });
  await pin(env.DB, holder.id, line(4).url, "auto");
  const body = await json<MatchResponse>(`/api/receipts/${r.id}/match`);
  expect(calls).toContain("list 2026-10-14 all currencies"); // a non-GBP payment is matched by hand
  const by = Object.fromEntries(body.lines.map((l) => [l.description, l]));
  expect(Object.keys(by).sort()).toEqual(["ACME HELD", "ACME LTD", "OTHER SHOP"]); // ACME LATE is more than 30 days after
  expect(by["ACME HELD"].heldByOther).toBe(true);
  expect(by["OTHER SHOP"]).toMatchObject({ explained: false, heldByOther: false, amount: "-24.00" });
  expect(body).toMatchObject({ receiptDay: "2026-11-13", windowDays: 30 });
});

it("manual match pins the line and files when it is explained", async () => {
  const { call, f } = setup();
  const r = await make({ state: "needs_choice" });
  const res = await call(`/api/receipts/${r.id}/match`, { method: "POST", json: { line: line(1).url } });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { receipt: { state: string } }).receipt.state).toBe("filed");
  const after = await get(r.id);
  expect(after.state).toBe("filed");
  expect(after.pinnedBy).toBe("manual");
  expect(after.pinnedLine).toBe(line(1).url);
  expect(f.attached).toEqual([`${BASE}/bank_transaction_explanations/1`]);
});

it("manual match works from a failed or could-not-read receipt", async () => {
  for (const state of ["failed", "could_not_read"] as const) {
    const { call } = setup();
    const r = await make({ state, reason: "x", ...(state === "could_not_read" ? { totalMinor: null, currency: null } : {}) });
    expect((await call(`/api/receipts/${r.id}/match`, { method: "POST", json: { line: line(1).url } })).status).toBe(200);
    const after = await get(r.id);
    expect(after.pinnedBy, state).toBe("manual");
    expect(["filed", "waiting_explanation"], state).toContain(after.state);
    await env.DB.prepare("DELETE FROM receipts").run();
  }
});

it("manual match files a could-not-read receipt that has no total", async () => {
  const { call, f } = setup();
  const r = await make({ state: "could_not_read", reason: "no_total", totalMinor: null, currency: null, confidence: null }, 2);
  expect((await call(`/api/receipts/${r.id}/match`, { method: "POST", json: { line: line(1).url } })).status).toBe(200);
  const after = await get(r.id);
  expect([after.state, after.pinnedBy]).toEqual(["filed", "manual"]);
  expect(f.attached).toEqual([`${BASE}/bank_transaction_explanations/1`]);
  expect(after.attachmentUrls).toHaveLength(2);
});

it("manual match on an unexplained line waits", async () => {
  const { call, f } = setup([line(1, { explanations: [] })]);
  const r = await make({ state: "waiting_payment" });
  expect((await call(`/api/receipts/${r.id}/match`, { method: "POST", json: { line: line(1).url } })).status).toBe(200);
  const after = await get(r.id);
  expect(after.state).toBe("waiting_explanation");
  expect(after.pinnedLine).toBe(line(1).url);
  expect(f.attached).toEqual([]);
});

it("manual match replaces an auto pin", async () => {
  const { call } = setup([line(1, { explanations: [] }), line(2, { explanations: [] })]);
  const r = await make({ state: "waiting_explanation" });
  await pin(env.DB, r.id, line(1).url, "auto");
  expect((await call(`/api/receipts/${r.id}/match`, { method: "POST", json: { line: line(2).url } })).status).toBe(200);
  const after = await get(r.id);
  expect([after.pinnedLine, after.pinnedBy]).toEqual([line(2).url, "manual"]);
});

it("refuses a manual match to a line another receipt holds", async () => {
  const { call } = setup([line(1, { explanations: [] }), line(2, { explanations: [] })]);
  const holder = await make({ state: "waiting_explanation" });
  await pin(env.DB, holder.id, line(1).url, "auto");
  const r = await make({ state: "needs_choice" });
  await pin(env.DB, r.id, line(2).url, "auto");
  const before = await get(r.id);
  const res = await call(`/api/receipts/${r.id}/match`, { method: "POST", json: { line: line(1).url } });
  expect(res.status).toBe(409);
  const after = await get(r.id);
  expect({ ...after, updatedAt: "" }).toEqual({ ...before, updatedAt: "" });
});

it("refuses a manual match to a line outside FreeAgent or one that does not exist", async () => {
  const { call, calls } = setup();
  const r = await make({ state: "needs_choice" });
  for (const bad of ["", "not a url", "https://evil.example.com/v2/bank_transactions/1", `${BASE}/../../evil/bank_transactions/1`, `${BASE}evil/bank_transactions/1`, `${BASE}/bank_transactions/1?x=1`, `${BASE}/bank_transactions/999`, `http://api.sandbox.freeagent.com/v2/bank_transactions/1`]) {
    const res = await call(`/api/receipts/${r.id}/match`, { method: "POST", json: { line: bad } });
    expect(res.status, bad).toBe(400);
  }
  expect(calls.filter((c) => c.startsWith("get ")).every((c) => c.startsWith(`get ${BASE}/`))).toBe(true);
  const after = await get(r.id);
  expect(after.pinnedLine).toBeNull();
  expect(after.state).toBe("needs_choice");
});

it("refuses an action the state does not allow", async () => {
  const { call, read } = setup();
  const r = await make({ state: "filed" });
  expect((await call(`/api/receipts/${r.id}/retry`, { method: "POST" })).status).toBe(409);
  expect((await call(`/api/receipts/${r.id}/match`, { method: "POST", json: { line: line(1).url } })).status).toBe(409);
  expect(read).not.toHaveBeenCalled();
  expect((await get(r.id)).state).toBe("filed");
});

it("delete removes the receipt and its files and makes no FreeAgent call", async () => {
  const { call, calls } = setup();
  const r = await make({ state: "filed" }, 2);
  const keys = (await listFiles(env.DB, r.id)).map((f) => f.r2Key);
  const res = await call(`/api/receipts/${r.id}`, { method: "DELETE" });
  expect(res.status).toBe(200);
  expect(await getReceipt(env.DB, r.id)).toBeNull();
  expect(await listFiles(env.DB, r.id)).toEqual([]);
  for (const k of keys) expect(await env.FILES.get(k)).toBeNull();
  expect(calls).toEqual([]);
  expect((await call(`/api/receipts/${r.id}`, { method: "DELETE" })).status).toBe(404);
});

it("retry keeps a manual pin and clears an auto pin", async () => {
  for (const by of ["manual", "auto"] as const) {
    const { call, read } = setup([line(1, { explanations: [], amountMinor: -999 })]); // fits no re-match, so a cleared auto pin stays cleared
    const r = await make({ state: "failed", reason: "boom", supplier: "Old", totalMinor: 999, confidence: 0.2 });
    await pin(env.DB, r.id, line(1).url, by);
    let seen: Receipt | null = null;
    read.mockImplementationOnce(async (_e: Env, id: string) => {
      seen = await get(id);
      await updateReceipt(env.DB, id, { state: "waiting_payment", reason: null, supplier: "Acme", totalMinor: 2400, currency: "GBP", receiptDate: "2026-11-13", confidence: 0.9, inputKind: "text" });
    });
    const res = await call(`/api/receipts/${r.id}/retry`, { method: "POST" });
    expect(res.status, by).toBe(200);
    expect(seen!.state).toBe("reading");
    expect([seen!.supplier, seen!.totalMinor, seen!.confidence, seen!.reason], by).toEqual([null, null, null, null]);
    expect(seen!.pinnedLine).toBe(by === "manual" ? line(1).url : null);
    const after = await get(r.id);
    expect(after.supplier).toBe("Acme");
    if (by === "manual") expect([after.pinnedBy, after.state]).toEqual(["manual", "waiting_explanation"]);
    else expect([after.pinnedLine, after.state]).toEqual([null, "waiting_payment"]);
    expect((await listEvents(env.DB, r.id)).some((e) => /retry/i.test(e.message))).toBe(true);
    await env.DB.prepare("DELETE FROM receipts").run();
  }
});

it("shows a plain message when FreeAgent is down or not connected", async () => {
  const { call, f } = setup();
  f.listError = new FreeAgentUnavailable("boom with secret details");
  const r = await make({ state: "needs_choice" });
  const res = await call(`/api/receipts/${r.id}/match`);
  expect(res.status).toBe(503);
  const { error } = (await res.json()) as { error: string };
  expect(error).toContain("FreeAgent");
  expect(error).not.toContain("secret details");
  const post = await call(`/api/receipts/${r.id}/match`, { method: "POST", json: { line: line(1).url } });
  expect(post.status).toBe(503);
  expect((await get(r.id)).pinnedLine).toBeNull();
});

it("settings shows the forwarding address and the connection status", async () => {
  const { json } = setup();
  expect(await json<SettingsResponse>("/api/settings")).toEqual({ forwardAddress: "receipts-k3v9x2@example.com", connected: false, baseUrl: BASE });
  await setSetting(env.DB, "freeagent_tokens", "{}");
  expect((await json<SettingsResponse>("/api/settings")).connected).toBe(true);
});

it("the OAuth start stores a state and the callback exchanges the code once", async () => {
  const { call, fa } = setup();
  const start = await call("/oauth/start");
  expect(start.status).toBe(302);
  const loc = new URL(start.headers.get("location")!);
  const state = loc.searchParams.get("state")!;
  expect(state.length).toBeGreaterThanOrEqual(32);
  expect(loc.searchParams.get("redirect")).toBe("http://localhost/oauth/callback");
  const ok = await call(`/oauth/callback?code=abc&state=${state}`);
  expect(ok.status).toBe(303);
  expect(ok.headers.get("location")).toBe("/settings?oauth=connected");
  expect(fa.exchangeCode).toHaveBeenCalledWith(expect.anything(), "abc", "http://localhost/oauth/callback");
  expect((await call(`/oauth/callback?code=abc&state=${state}`)).headers.get("location")).toBe("/settings?oauth=invalid"); // state is single use
  expect(fa.exchangeCode).toHaveBeenCalledTimes(1);
});

it("the OAuth state is used once even when two callbacks race", async () => {
  const { call, fa } = setup();
  const state = new URL((await call("/oauth/start")).headers.get("location")!).searchParams.get("state")!;
  const [a, b] = await Promise.all([call(`/oauth/callback?code=one&state=${state}`), call(`/oauth/callback?code=two&state=${state}`)]);
  expect([a.headers.get("location"), b.headers.get("location")].sort()).toEqual(["/settings?oauth=connected", "/settings?oauth=invalid"]);
  expect(fa.exchangeCode).toHaveBeenCalledTimes(1);
});

it("an old OAuth callback cannot use up a newer sign-in's state", async () => {
  const { call, fa } = setup();
  const first = new URL((await call("/oauth/start")).headers.get("location")!).searchParams.get("state")!;
  const second = new URL((await call("/oauth/start")).headers.get("location")!).searchParams.get("state")!;
  expect((await call(`/oauth/callback?code=old&state=${first}`)).headers.get("location")).toBe("/settings?oauth=invalid");
  expect((await call(`/oauth/callback?code=new&state=${second}`)).headers.get("location")).toBe("/settings?oauth=connected");
  expect(fa.exchangeCode).toHaveBeenCalledTimes(1);
});

it("the OAuth callback rejects a wrong state", async () => {
  const { call, fa } = setup();
  await call("/oauth/start");
  for (const q of ["code=abc&state=wrong", "code=abc"]) expect((await call(`/oauth/callback?${q}`)).headers.get("location"), q).toBe("/settings?oauth=invalid");
  expect(fa.exchangeCode).not.toHaveBeenCalled();
  expect(await getSetting(env.DB, "freeagent_tokens")).toBeNull();
  const { call: fresh } = setup();
  await env.DB.prepare("DELETE FROM settings").run();
  expect((await fresh("/oauth/callback?code=abc&state=")).headers.get("location")).toBe("/settings?oauth=invalid"); // nothing stored to match
  expect(await getSetting(env.DB, "freeagent_tokens")).toBeNull();
});

it("retry and match on a failed receipt release a held claim, and the page shows the reason", async () => {
  const reason = "FreeAgent did not confirm the attachment. Check the transaction in FreeAgent before you press Retry.";
  const { call, f } = setup([line(1)]);
  for (const action of ["retry", "match"] as const) {
    const r = await make({ state: "failed", reason });
    await env.DB.prepare("UPDATE receipts SET attach_claimed_at = ? WHERE id = ?").bind(NOW.toISOString(), r.id).run();
    if (action === "retry") await pin(env.DB, r.id, line(1).url, "auto");
    expect(((await (await call(`/api/receipts/${r.id}`)).json()) as ReceiptResponse).receipt.reason).toBe(reason);
    const res = await call(`/api/receipts/${r.id}/${action}`, { method: "POST", ...(action === "match" ? { json: { line: line(1).url } } : {}) });
    expect(res.status).toBe(200);
    expect((await get(r.id)).state).toBe("filed");
    await env.DB.prepare("DELETE FROM receipts").run(); // frees line 1 for the next action
  }
  expect(f.attached).toHaveLength(2);
});

it("lists the lines that fit first, marked Fits, then the others", async () => {
  const { call } = setup([
    line(3, { description: "NEWEST OTHER", amountMinor: -999, datedOn: "2026-11-15" }),
    line(1, { description: "FIT ONE", datedOn: "2026-11-13" }),
    line(2, { description: "FIT TWO", datedOn: "2026-11-14" }),
  ]);
  const r = await make({ state: "needs_choice", receiptDate: "2026-11-13" });
  const { lines } = (await (await call(`/api/receipts/${r.id}/match`)).json()) as MatchResponse;
  expect(lines.map((l) => [l.description, l.fits])).toEqual([["FIT TWO", true], ["FIT ONE", true], ["NEWEST OTHER", false]]);
});

it("the match view carries the receipt's files and email, so it can be read while matching", async () => {
  const { json } = setup();
  const r = await make({ state: "could_not_read", reason: "no_total", totalMinor: null, currency: null }, 1);
  const [f] = await listFiles(env.DB, r.id);
  const body = await json<MatchResponse>(`/api/receipts/${r.id}/match`);
  expect(body.files.map((x) => [x.url, x.preview])).toEqual([[`/api/receipts/${r.id}/files/${f.id}`, "pdf"]]);
  expect(body.email).toEqual({ from: "shop@example.com", subject: "Your receipt", date: "2026-11-13T09:00:00Z", bodyUrl: `/api/receipts/${r.id}/body` });
});

it("serves the email body sandboxed: no script, no network, framed only by the app", async () => {
  const { call } = setup();
  const r = await make({ state: "could_not_read" }, 0);
  await updateReceipt(env.DB, r.id, { body: "<p>Total £9.99</p><script>alert(1)</script>", bodyIsHtml: true });
  const res = await call(`/api/receipts/${r.id}/body`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  const csp = res.headers.get("content-security-policy")!;
  for (const part of ["sandbox", "default-src 'none'", "frame-ancestors 'self'"]) expect(csp).toContain(part);
  expect(csp).not.toMatch(/script-src|allow-/);
  await updateReceipt(env.DB, r.id, { body: "plain text", bodyIsHtml: false });
  expect((await call(`/api/receipts/${r.id}/body`)).headers.get("content-type")).toBe("text/plain; charset=utf-8");
  await updateReceipt(env.DB, r.id, { body: null });
  expect((await call(`/api/receipts/${r.id}/body`)).status).toBe(404);
  expect((await call(`/api/receipts/${r.id}/body`, { noAccess: true })).status).toBe(403);
});
