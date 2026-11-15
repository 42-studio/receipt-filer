import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { addFile, createReceipt, getReceipt, getSetting, listEvents, listFiles, pin, setSetting, updateReceipt, type Receipt } from "../src/db";
import type { Env } from "../src/env";
import { FreeAgentUnavailable, pickExplanation, type BankLine } from "../src/freeagent/client";
import { runMatcher } from "../src/match/run";
import { createApp, type AppDeps } from "../src/ui/app";

const OWNER = "owner@example.com";
const BASE = "https://api.sandbox.freeagent.com/v2";
const NOW = new Date("2026-11-15T10:00:00Z");
// defineProperty, not assignment: assigning through the prototype would write to the shared env.
const withVars = (vars: Record<string, string>) => Object.create(env, Object.fromEntries(Object.entries(vars).map(([k, value]) => [k, { value }]))) as Env;
const E = withVars({ OWNER_EMAIL: OWNER, FORWARD_ADDRESS: "receipts-k3v9x2@example.com", APP_URL: "https://receipts.example.com" });
const line = (n: number, o: Partial<BankLine> = {}): BankLine => ({ url: `${BASE}/bank_transactions/${n}`, datedOn: "2026-11-14", amountMinor: -2400, description: "ACME LTD", explanations: [{ url: `${BASE}/bank_transaction_explanations/${n}`, grossMinor: -2400 }], ...o });

// Fakes only: no FreeAgent, rate, AI or email call is made.
function setup(lines: BankLine[] = [line(1)]) {
  const calls: string[] = [];
  const f = { lines, listError: null as Error | null, attached: [] as string[] };
  const fa = {
    listBankLines: async (_e: Env, from: string) => { calls.push(`list ${from}`); if (f.listError) throw f.listError; return f.lines; },
    getBankLine: async (_e: Env, url: string) => { calls.push(`get ${url}`); if (f.listError) throw f.listError; return f.lines.find((l) => l.url === url) ?? null; },
    attach: async (_e: Env, url: string, files: unknown[]) => { calls.push(`attach ${url}`); f.attached.push(url); return files.map((_x, i) => `${url}/attachments/${i + 1}`); },
    pickExplanation,
    authoriseUrl: (_e: Env, state: string, redirect: string) => `https://fa.example.com/approve?state=${state}&redirect=${encodeURIComponent(redirect)}`,
    exchangeCode: vi.fn(async (_e: Env, _code: string, _redirect: string) => { calls.push("exchange"); await setSetting(env.DB, "freeagent_tokens", "{}"); }),
    isConnected: async () => (await getSetting(env.DB, "freeagent_tokens")) !== null,
  };
  const read = vi.fn(async (_e: Env, id: string) => { await updateReceipt(env.DB, id, { state: "waiting_payment", reason: null, supplier: "Acme", totalMinor: 2400, currency: "GBP", receiptDate: "2026-11-13", confidence: 0.9, inputKind: "text" }); });
  const match = (e: Env, id: string) => runMatcher(e, { fa, rate: async () => 1, notify: vi.fn(async () => {}), now: () => NOW, read: read as never, convert: async (_e, x) => x }, id);
  const deps: AppDeps = { fa, read, runMatcher: match };
  const app = createApp(deps);
  const ctx = (email: string | null | undefined) => ({ waitUntil() {}, passThroughOnException() {}, ...(email === undefined ? {} : { access: { aud: "aud", getIdentity: async () => (email === null ? undefined : { email }) } }) }) as unknown as ExecutionContext;
  const call = (path: string, o: { method?: string; email?: string | null; noAccess?: boolean; origin?: string | null; form?: Record<string, string>; e?: Env } = {}) => {
    const method = o.method ?? "GET";
    const headers: Record<string, string> = {};
    if (method === "POST" && o.origin !== null) headers.Origin = o.origin ?? "http://localhost";
    return app.request(path, { method, headers, ...(o.form ? { body: new URLSearchParams(o.form) } : {}), redirect: "manual" }, o.e ?? E, ctx(o.noAccess ? undefined : (o.email === undefined ? OWNER : o.email)));
  };
  return { call, f, fa, read, calls };
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
  expect((await call("/", { noAccess: true })).status).toBe(403);
  expect((await call("/", { email: null })).status).toBe(403);
  expect((await call("/", { email: "someone-else@example.com" })).status).toBe(403);
  expect((await call("/health", { noAccess: true })).status).toBe(403);
  expect((await call("/")).status).toBe(200);
  expect((await call("/", { email: " Owner@Example.com " })).status).toBe(200);
  expect((await call("/health")).status).toBe(200);
});

it("fails closed when OWNER_EMAIL is blank", async () => {
  const { call } = setup();
  const blank = withVars({ OWNER_EMAIL: " " });
  expect((await call("/", { e: blank, email: "" })).status).toBe(403);
  expect((await call("/", { e: blank })).status).toBe(403);
});

it("refuses a POST from another origin", async () => {
  const { call } = setup();
  const r = await make({ state: "could_not_read" });
  expect((await call(`/receipts/${r.id}/delete`, { method: "POST", origin: "https://evil.example.com" })).status).toBe(403);
  expect((await call(`/receipts/${r.id}/delete`, { method: "POST", origin: null })).status).toBe(403);
  expect(await get(r.id)).toBeTruthy();
  expect((await call(`/receipts/${r.id}/delete`, { method: "POST" })).status).toBe(303);
});

it("lists open receipts before filed ones with their actions", async () => {
  const { call } = setup();
  const filed = await make({ state: "filed", supplier: "Filed Co" });
  await env.DB.prepare("UPDATE receipts SET received_at = '2026-11-20T00:00:00Z' WHERE id = ?").bind(filed.id).run();
  const open = await make({ state: "waiting_payment", supplier: "Open Co" });
  const html = await (await call("/")).text();
  expect(html.indexOf("Open Co")).toBeGreaterThan(-1);
  expect(html.indexOf("Open Co")).toBeLessThan(html.indexOf("Filed Co"));
  const rowOf = (name: string) => html.slice(html.indexOf(name), html.indexOf("</tr>", html.indexOf(name)));
  expect(rowOf("Filed Co")).toContain(`/receipts/${filed.id}/delete`);
  expect(rowOf("Filed Co")).not.toContain("/match");
  expect(rowOf("Filed Co")).not.toContain("/retry");
  for (const a of ["match", "retry", "delete"]) expect(rowOf("Open Co")).toContain(`/receipts/${open.id}/${a}`);
  expect(rowOf("Open Co")).toContain("GBP 24.00");
  expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
});

it("shows only the actions the state allows", async () => {
  const { call } = setup();
  const table: Record<string, string[]> = {
    reading: ["delete"], could_not_read: ["match", "retry", "delete"], duplicate: ["delete"], waiting_payment: ["match", "retry", "delete"],
    needs_choice: ["match", "delete"], waiting_explanation: ["match", "delete"], filed: ["delete"], failed: ["match", "retry", "delete"],
  };
  for (const [state, allowed] of Object.entries(table)) {
    const r = await make({ state: state as never });
    const html = await (await call(`/receipts/${r.id}`)).text();
    for (const a of ["match", "retry", "delete"]) expect(html.includes(`/receipts/${r.id}/${a}`), `${state} ${a}`).toBe(allowed.includes(a));
    for (const a of ["match", "retry", "delete"]) {
      const res = await call(`/receipts/${r.id}/${a}`, { method: a === "match" ? "GET" : "POST" });
      if (a === "match") expect(res.status, `${state} GET match`).toBe(allowed.includes(a) ? 200 : 409);
      else expect(res.status, `${state} ${a}`).toBe(allowed.includes(a) ? 303 : 409);
    }
  }
});

it("never renders an email-derived value unescaped", async () => {
  const { call } = setup([line(1, { description: "<img src=x onerror=alert(1)>" })]);
  const r = await make({ subject: "<script>alert(1)</script>", supplier: "<b>Evil</b>", reason: "<i>why</i>", state: "failed", receiptDate: "2026-11-14" } as never);
  await updateReceipt(env.DB, r.id, { subject: "<script>alert(1)</script>" });
  for (const path of ["/", `/receipts/${r.id}`, `/receipts/${r.id}/match`]) {
    const html = await (await call(path)).text();
    expect(html, path).not.toMatch(/<script|<b>Evil|<img src=x|<i>why/);
    expect(html, path).toContain("&lt;");
  }
});

it("shows the receipt page with fields, history and file links", async () => {
  const { call } = setup();
  const r = await make({ state: "waiting_explanation", reason: null }, 2);
  await pin(env.DB, r.id, line(1).url, "manual");
  await env.DB.prepare("INSERT INTO events (receipt_id, at, message) VALUES (?,?,?)").bind(r.id, "2026-11-14T10:00:00Z", "Read GBP 24.00").run();
  const files = await listFiles(env.DB, r.id);
  const html = await (await call(`/receipts/${r.id}`)).text();
  expect(html).toContain("Acme");
  expect(html).toContain("GBP 24.00");
  expect(html).toContain("0.90");
  expect(html).toContain(line(1).url);
  expect(html).toContain("Read GBP 24.00");
  for (const f of files) expect(html).toContain(`/receipts/${r.id}/files/${f.id}`);
  expect((await call("/receipts/nope")).status).toBe(404);
});

it("serves a stored file inline and 404s once it is gone", async () => {
  const { call } = setup();
  const r = await make({}, 1);
  const [f] = await listFiles(env.DB, r.id);
  const res = await call(`/receipts/${r.id}/files/${f.id}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/pdf");
  expect(res.headers.get("content-disposition")).toBe("inline");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 0]));
  await env.FILES.delete(f.r2Key);
  expect((await call(`/receipts/${r.id}/files/${f.id}`)).status).toBe(404);
  const other = await make({}, 1);
  expect((await call(`/receipts/${other.id}/files/${f.id}`)).status).toBe(404);
});

it("never serves a stored type that a browser could run", async () => {
  const { call } = setup();
  const r = await make({}, 1);
  const [f] = await listFiles(env.DB, r.id);
  await env.DB.prepare("UPDATE files SET content_type = 'text/html' WHERE id = ?").bind(f.id).run();
  const res = await call(`/receipts/${r.id}/files/${f.id}`);
  expect(res.headers.get("content-type")).toBe("application/octet-stream");
  expect(res.headers.get("content-disposition")).toBe("attachment");
});

it("lists bank lines near the receipt date, filtered, with explained and held flags", async () => {
  const { call, calls } = setup([
    line(1, { description: "ACME LTD" }),
    line(2, { description: "OTHER SHOP", explanations: [] }),
    line(3, { description: "ACME LATE", datedOn: "2026-12-30" }),
    line(4, { description: "ACME HELD" }),
  ]);
  const r = await make({ state: "needs_choice", receiptDate: "2026-11-13" });
  const holder = await make({ state: "waiting_explanation" });
  await pin(env.DB, holder.id, line(4).url, "auto");
  const html = await (await call(`/receipts/${r.id}/match`)).text();
  expect(calls).toContain("list 2026-10-14");
  expect(html).toContain("ACME LTD");
  expect(html).toContain("OTHER SHOP");
  expect(html).not.toContain("ACME LATE"); // more than 30 days after
  expect(html).toContain("held by another receipt");
  expect(html).toContain("not explained");
  const filtered = await (await call(`/receipts/${r.id}/match?q=other`)).text();
  expect(filtered).toContain("OTHER SHOP");
  expect(filtered).not.toContain("ACME LTD");
});

it("manual match pins the line and files when it is explained", async () => {
  const { call, f } = setup();
  const r = await make({ state: "needs_choice" });
  const res = await call(`/receipts/${r.id}/match`, { method: "POST", form: { line: line(1).url } });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe(`/receipts/${r.id}`);
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
    expect((await call(`/receipts/${r.id}/match`, { method: "POST", form: { line: line(1).url } })).status).toBe(303);
    const after = await get(r.id);
    expect(after.pinnedBy, state).toBe("manual");
    expect(["filed", "waiting_explanation"], state).toContain(after.state);
    await env.DB.prepare("DELETE FROM receipts").run();
  }
});

it("manual match files a could-not-read receipt that has no total", async () => {
  const { call, f } = setup();
  const r = await make({ state: "could_not_read", reason: "no_total", totalMinor: null, currency: null, confidence: null }, 2);
  expect((await call(`/receipts/${r.id}/match`, { method: "POST", form: { line: line(1).url } })).status).toBe(303);
  const after = await get(r.id);
  expect([after.state, after.pinnedBy]).toEqual(["filed", "manual"]);
  expect(f.attached).toEqual([`${BASE}/bank_transaction_explanations/1`]);
  expect(after.attachmentUrls).toHaveLength(2);
});

it("manual match on an unexplained line waits", async () => {
  const { call, f } = setup([line(1, { explanations: [] })]);
  const r = await make({ state: "waiting_payment" });
  expect((await call(`/receipts/${r.id}/match`, { method: "POST", form: { line: line(1).url } })).status).toBe(303);
  const after = await get(r.id);
  expect(after.state).toBe("waiting_explanation");
  expect(after.pinnedLine).toBe(line(1).url);
  expect(f.attached).toEqual([]);
});

it("manual match replaces an auto pin", async () => {
  const { call } = setup([line(1, { explanations: [] }), line(2, { explanations: [] })]);
  const r = await make({ state: "waiting_explanation" });
  await pin(env.DB, r.id, line(1).url, "auto");
  expect((await call(`/receipts/${r.id}/match`, { method: "POST", form: { line: line(2).url } })).status).toBe(303);
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
  const res = await call(`/receipts/${r.id}/match`, { method: "POST", form: { line: line(1).url } });
  expect(res.status).toBe(409);
  const after = await get(r.id);
  expect({ ...after, updatedAt: "" }).toEqual({ ...before, updatedAt: "" });
});

it("refuses a manual match to a line outside FreeAgent or one that does not exist", async () => {
  const { call, calls } = setup();
  const r = await make({ state: "needs_choice" });
  for (const bad of ["", "not a url", "https://evil.example.com/v2/bank_transactions/1", `${BASE}/../../evil/bank_transactions/1`, `${BASE}evil/bank_transactions/1`, `${BASE}/bank_transactions/1?x=1`, `${BASE}/bank_transactions/999`, `http://api.sandbox.freeagent.com/v2/bank_transactions/1`]) {
    const res = await call(`/receipts/${r.id}/match`, { method: "POST", form: { line: bad } });
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
  expect((await call(`/receipts/${r.id}/retry`, { method: "POST" })).status).toBe(409);
  expect((await call(`/receipts/${r.id}/match`, { method: "POST", form: { line: line(1).url } })).status).toBe(409);
  expect(read).not.toHaveBeenCalled();
  expect((await get(r.id)).state).toBe("filed");
});

it("delete removes the receipt and its files and makes no FreeAgent call", async () => {
  const { call, calls } = setup();
  const r = await make({ state: "filed" }, 2);
  const keys = (await listFiles(env.DB, r.id)).map((f) => f.r2Key);
  const res = await call(`/receipts/${r.id}/delete`, { method: "POST" });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/");
  expect(await getReceipt(env.DB, r.id)).toBeNull();
  expect(await listFiles(env.DB, r.id)).toEqual([]);
  for (const k of keys) expect(await env.FILES.get(k)).toBeNull();
  expect(calls).toEqual([]);
  expect((await call(`/receipts/${r.id}/delete`, { method: "POST" })).status).toBe(404);
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
    const res = await call(`/receipts/${r.id}/retry`, { method: "POST" });
    expect(res.status, by).toBe(303);
    expect(res.headers.get("location")).toBe(`/receipts/${r.id}`);
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
  const res = await call(`/receipts/${r.id}/match`);
  expect(res.status).toBe(503);
  const text = await res.text();
  expect(text).toContain("FreeAgent");
  expect(text).not.toContain("secret details");
  const post = await call(`/receipts/${r.id}/match`, { method: "POST", form: { line: line(1).url } });
  expect(post.status).toBe(503);
  expect((await get(r.id)).pinnedLine).toBeNull();
});

it("settings shows the forwarding address and the connection status", async () => {
  const { call } = setup();
  let html = await (await call("/settings")).text();
  expect(html).toContain("receipts-k3v9x2@example.com");
  expect(html).toContain("Not connected");
  expect(html).toContain("/oauth/start");
  await setSetting(env.DB, "freeagent_tokens", "{}");
  html = await (await call("/settings")).text();
  expect(html).toContain("Connected");
  expect(html).not.toContain("Not connected");
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
  expect(ok.headers.get("location")).toBe("/settings");
  expect(fa.exchangeCode).toHaveBeenCalledWith(expect.anything(), "abc", "http://localhost/oauth/callback");
  expect((await call(`/oauth/callback?code=abc&state=${state}`)).status).toBe(400); // state is single use
  expect(fa.exchangeCode).toHaveBeenCalledTimes(1);
});

it("the OAuth callback rejects a wrong state", async () => {
  const { call, fa } = setup();
  await call("/oauth/start");
  expect((await call("/oauth/callback?code=abc&state=wrong")).status).toBe(400);
  expect((await call("/oauth/callback?code=abc")).status).toBe(400);
  expect(fa.exchangeCode).not.toHaveBeenCalled();
  expect(await getSetting(env.DB, "freeagent_tokens")).toBeNull();
  const { call: fresh } = setup();
  await env.DB.prepare("DELETE FROM settings").run();
  expect((await fresh("/oauth/callback?code=abc&state=")).status).toBe(400); // nothing stored to match
  expect(await getSetting(env.DB, "freeagent_tokens")).toBeNull();
});
