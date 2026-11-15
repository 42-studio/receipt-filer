import { env as workerEnv } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getSetting, setSetting } from "../src/db";
import type { Env } from "../src/env";
import {
  FreeAgentAuthError, FreeAgentUnavailable, attach, authoriseUrl, exchangeCode, getBankLine, isConnected, listBankLines, pickExplanation,
  type BankLine,
} from "../src/freeagent/client";

const BASE = "https://fa.test/v2";
const env = { ...workerEnv, FREEAGENT_BASE_URL: BASE, FREEAGENT_CLIENT_ID: "cid", FREEAGENT_CLIENT_SECRET: "sec" } as unknown as Env;
const TOKEN_URL = `${BASE}/token_endpoint`;

interface Seen { url: string; method: string; headers: Headers; body: string }
let seen: Seen[];
let handler: (r: Seen) => Response | Promise<Response>;
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const seedTokens = (t: Partial<{ access_token: string; refresh_token: string; expires_at: number }> = {}) =>
  setSetting(env.DB, "freeagent_tokens", JSON.stringify({ access_token: "a1", refresh_token: "r1", expires_at: Date.now() + 3_600_000, ...t }));
const tx = (n: number, amount = "-1.00") => ({ url: `${BASE}/bank_transactions/${n}`, amount, dated_on: "2026-11-01", description: `d${n}`, bank_transaction_explanations: [] });

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM settings").run();
  seen = [];
  handler = () => json({}, 404);
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    const req = new Request(input, init);
    const s = { url: req.url, method: req.method, headers: req.headers, body: new TextDecoder().decode(await req.arrayBuffer()) };
    seen.push(s);
    return handler(s);
  });
});
afterEach(() => vi.unstubAllGlobals());

it("builds the authorise URL", () => {
  const u = new URL(authoriseUrl(env, "st", "https://w/cb"));
  expect(u.origin + u.pathname).toBe(`${BASE}/approve_app`);
  expect(Object.fromEntries(u.searchParams)).toEqual({ client_id: "cid", response_type: "code", redirect_uri: "https://w/cb", state: "st" });
});

it("exchanges a code and stores the tokens", async () => {
  handler = () => json({ access_token: "a", refresh_token: "r", expires_in: 3600 });
  expect(await isConnected(env)).toBe(false);
  await exchangeCode(env, "code1", "https://w/cb");
  expect(seen[0].url).toBe(TOKEN_URL);
  expect(seen[0].headers.get("authorization")).toBe(`Basic ${btoa("cid:sec")}`);
  expect(new URLSearchParams(seen[0].body).get("grant_type")).toBe("authorization_code");
  const t = JSON.parse((await getSetting(env.DB, "freeagent_tokens"))!);
  expect(t).toMatchObject({ access_token: "a", refresh_token: "r" });
  expect(t.expires_at).toBeGreaterThan(Date.now() + 3_000_000);
  expect(await isConnected(env)).toBe(true);
});

it("sends the API version and a bearer token on every call", async () => {
  await seedTokens();
  handler = () => json({ bank_transaction: tx(1) });
  await getBankLine(env, `${BASE}/bank_transactions/1`);
  expect(seen[0].headers.get("x-api-version")).toBe("2026-09-01");
  expect(seen[0].headers.get("authorization")).toBe("Bearer a1");
  expect(seen[0].headers.get("accept")).toBe("application/json");
  expect(seen[0].headers.get("user-agent")).toBeTruthy();
});

it("refreshes an expired token once and stores the new refresh token before using it", async () => {
  await seedTokens({ expires_at: Date.now() + 10_000 });
  let storedAtApiCall: string | null = null;
  handler = async (r) => {
    if (r.url === TOKEN_URL) {
      expect(new URLSearchParams(r.body).get("refresh_token")).toBe("r1");
      return json({ access_token: "a2", refresh_token: "r2", expires_in: 3600 });
    }
    storedAtApiCall = await getSetting(env.DB, "freeagent_tokens");
    return json({ bank_transaction: tx(1) });
  };
  await getBankLine(env, `${BASE}/bank_transactions/1`);
  expect(seen.map((s) => s.url)).toEqual([TOKEN_URL, `${BASE}/bank_transactions/1`]);
  expect(seen[1].headers.get("authorization")).toBe("Bearer a2");
  expect(JSON.parse(storedAtApiCall!).refresh_token).toBe("r2");
});

it("uses tokens another isolate already refreshed instead of refreshing again", async () => {
  await seedTokens();
  handler = async (r) => {
    if (r.headers.get("authorization") !== "Bearer a1") return json({ bank_transaction: tx(1) });
    await seedTokens({ access_token: "a9", refresh_token: "r9" }); // another isolate refreshes while our call is in flight
    return json({}, 401);
  };
  await getBankLine(env, `${BASE}/bank_transactions/1`);
  expect(seen.some((s) => s.url === TOKEN_URL)).toBe(false);
  expect(seen[1].headers.get("authorization")).toBe("Bearer a9");
});

it("runs one refresh for two calls made at the same time", async () => {
  await seedTokens({ expires_at: 0 });
  handler = async (r) => {
    if (r.url === TOKEN_URL) {
      await new Promise((res) => setTimeout(res, 20));
      return json({ access_token: "a2", refresh_token: "r2", expires_in: 3600 });
    }
    return json({ bank_transaction: tx(1) });
  };
  await Promise.all([getBankLine(env, `${BASE}/bank_transactions/1`), getBankLine(env, `${BASE}/bank_transactions/2`)]);
  expect(seen.filter((s) => s.url === TOKEN_URL)).toHaveLength(1);
});

it("refreshes once and retries on a 401, then gives up with FreeAgentAuthError", async () => {
  await seedTokens();
  let n = 0;
  handler = (r) => {
    if (r.url === TOKEN_URL) return json({ access_token: "a2", refresh_token: "r2", expires_in: 3600 });
    return n++ === 0 ? json({}, 401) : json({ bank_transaction: tx(1) });
  };
  expect(await getBankLine(env, `${BASE}/bank_transactions/1`)).not.toBeNull();
  expect(seen.map((s) => s.headers.get("authorization"))).toEqual(["Bearer a1", `Basic ${btoa("cid:sec")}`, "Bearer a2"]);

  handler = (r) => (r.url === TOKEN_URL ? json({ access_token: "a3", refresh_token: "r3", expires_in: 3600 }) : json({}, 401));
  await expect(getBankLine(env, `${BASE}/bank_transactions/1`)).rejects.toBeInstanceOf(FreeAgentAuthError);
});

it("throws FreeAgentAuthError when the refresh is refused and keeps the stored tokens", async () => {
  await seedTokens({ expires_at: 0 });
  const before = await getSetting(env.DB, "freeagent_tokens");
  handler = () => json({ error: "invalid_grant" }, 400);
  await expect(getBankLine(env, `${BASE}/bank_transactions/1`)).rejects.toBeInstanceOf(FreeAgentAuthError);
  expect(await getSetting(env.DB, "freeagent_tokens")).toBe(before);
});

it("throws FreeAgentAuthError when not connected", async () => {
  await expect(listBankLines(env, "2026-11-01")).rejects.toBeInstanceOf(FreeAgentAuthError);
});

it.each([["429", () => json({}, 429)], ["500", () => json({}, 500)], ["network failure", () => { throw new TypeError("boom"); }]])(
  "throws FreeAgentUnavailable on %s", async (_n, h) => {
    await seedTokens();
    handler = h as typeof handler;
    await expect(getBankLine(env, `${BASE}/bank_transactions/1`)).rejects.toBeInstanceOf(FreeAgentUnavailable);
  });

it("reads every page of every active account", async () => {
  await seedTokens();
  const page = (n: number, count: number) => Array.from({ length: count }, (_, i) => tx(n * 1000 + i));
  handler = (r) => {
    const u = new URL(r.url);
    if (u.pathname.endsWith("/bank_accounts"))
      return json({ bank_accounts: [{ url: `${BASE}/bank_accounts/1`, status: "active" }, { url: `${BASE}/bank_accounts/2`, status: "active" }, { url: `${BASE}/bank_accounts/3`, status: "hidden" }] });
    const acct = u.searchParams.get("bank_account")!.endsWith("/1") ? 1 : 2;
    expect(u.searchParams.get("from_date")).toBe("2026-10-01");
    expect(u.searchParams.get("per_page")).toBe("100");
    return json({ bank_transactions: u.searchParams.get("page") === "1" ? page(acct, 100) : page(acct, 3) });
  };
  const lines = await listBankLines(env, "2026-10-01");
  expect(seen.filter((s) => s.url.includes("/bank_transactions"))).toHaveLength(4);
  expect(lines).toHaveLength(206);
});

it("converts amounts to minor units and maps explanations", async () => {
  await seedTokens();
  handler = (r) =>
    r.url.endsWith("/bank_accounts")
      ? json({ bank_accounts: [{ url: `${BASE}/bank_accounts/1`, status: "active" }] })
      : json({ bank_transactions: [
          { ...tx(1, "-730.0"), bank_transaction_explanations: [{ url: "e1", gross_value: "-730.0" }] },
          tx(2, "5.69"), tx(3, "-0.29"),
        ] });
  const lines = await listBankLines(env, "2026-11-01");
  expect(lines.map((l) => l.amountMinor)).toEqual([-73000, 569, -29]);
  expect(lines[0]).toEqual({ url: `${BASE}/bank_transactions/1`, datedOn: "2026-11-01", amountMinor: -73000, description: "d1", explanations: [{ url: "e1", grossMinor: -73000 }] });
});

it("returns null for a bank line that no longer exists", async () => {
  await seedTokens();
  handler = () => json({}, 404);
  expect(await getBankLine(env, `${BASE}/bank_transactions/9`)).toBeNull();
});

const files = (n: number) => Array.from({ length: n }, (_, i) => ({ filename: `f${i}.pdf`, contentType: "application/pdf", data: new Uint8Array([i, 1, 2]) }));

it("attaches in batches of ten and returns every attachment URL", async () => {
  await seedTokens();
  let k = 0;
  handler = (r) => json({ attachments: JSON.parse(r.body).attachments.map(() => ({ url: `${BASE}/attachments/${k++}` })) }, 201);
  const urls = await attach(env, `${BASE}/bank_transactions/7`, files(12));
  const posts = seen.map((s) => ({ url: s.url, body: JSON.parse(s.body) }));
  expect(posts.map((p) => p.body.attachments.length)).toEqual([10, 2]);
  expect(urls).toHaveLength(12);
  expect(posts[0].url).toBe(`${BASE}/bank_transactions/7/attachments`);
  expect(posts[0].body.attachments[1]).toMatchObject({ data: btoa("\x01\x01\x02"), file_name: "f1.pdf", content_type: "application/pdf" });
});

it("throws an Error carrying the status and FreeAgent's message when attach is refused", async () => {
  await seedTokens();
  handler = () => json({ errors: { error: { message: "File too large" } } }, 422);
  await expect(attach(env, `${BASE}/bank_transactions/7`, files(1))).rejects.toThrow(/422.*File too large/);
});

it("never sends anything but attachments in a write", async () => {
  await seedTokens({ expires_at: 0 });
  handler = (r) =>
    r.url === TOKEN_URL ? json({ access_token: "a2", refresh_token: "r2", expires_in: 3600 })
    : r.method === "POST" ? json({ attachments: [{ url: "u" }] }, 201) : json({ bank_accounts: [], bank_transaction: tx(1) });
  await listBankLines(env, "2026-11-01");
  await getBankLine(env, `${BASE}/bank_transactions/1`);
  await attach(env, `${BASE}/bank_transactions/7`, files(1));
  const writes = seen.filter((s) => s.method !== "GET");
  expect(writes.length).toBeGreaterThan(0);
  for (const w of writes) expect(w.url === TOKEN_URL || w.url.endsWith("/attachments")).toBe(true);
});

const line: BankLine = { url: "u", datedOn: "2026-11-01", amountMinor: -2000, description: "", explanations: [] };
it.each([
  [[{ url: "a", grossMinor: -500 }, { url: "b", grossMinor: -2000 }], 2000, "b"],
  [[{ url: "a", grossMinor: -500 }, { url: "b", grossMinor: -900 }], 2000, "b"],
  [[{ url: "a", grossMinor: -2000 }, { url: "b", grossMinor: -3000 }], 2000, "a"],
  [[], 2000, null],
])("picks the explanation", (ex, total, want) => expect(pickExplanation({ ...line, explanations: ex }, total)).toBe(want));

it("fails loudly when a list call returns 404", async () => {
  await seedTokens();
  handler = () => json({}, 404);
  await expect(listBankLines(env, "2026-11-01")).rejects.toThrow(/404/);
  handler = (r) => (r.url.endsWith("/bank_accounts") ? json({ bank_accounts: [{ url: `${BASE}/bank_accounts/1`, status: "active" }] }) : json({}, 404));
  await expect(listBankLines(env, "2026-11-01")).rejects.toThrow(/404/);
});

it("uses the stored tokens when a refused refresh was only a rotation by another isolate", async () => {
  await seedTokens({ expires_at: 0 });
  handler = async (r) => {
    if (r.url !== TOKEN_URL) return json({ bank_transaction: tx(1) });
    await seedTokens({ access_token: "a9", refresh_token: "r9" });
    return json({ error: "invalid_grant" }, 400);
  };
  expect(await getBankLine(env, `${BASE}/bank_transactions/1`)).not.toBeNull();
  expect(seen[seen.length - 1].headers.get("authorization")).toBe("Bearer a9");
});

it("refuses URLs outside the FreeAgent base URL without sending a request", async () => {
  await seedTokens();
  await expect(getBankLine(env, "https://evil.test/v2/bank_transactions/1")).rejects.toThrow(/outside/);
  await expect(getBankLine(env, `${BASE}.evil.test/x`)).rejects.toThrow(/outside/);
  await expect(attach(env, "https://evil.test/v2/x", files(1))).rejects.toThrow(/outside/);
  expect(seen).toHaveLength(0);
});
