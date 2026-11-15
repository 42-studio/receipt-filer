import { env as workerEnv } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { rateToGbp } from "../src/match/fx";

const env = workerEnv as unknown as Env;
let urls: string[];
let reply: () => Response;
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
const ok = (rate: unknown, date = "2026-11-09") => () => json({ amount: 1, base: "USD", date, rates: { GBP: rate } });
const stored = () => env.DB.prepare("SELECT day, currency, to_gbp FROM rates").all();

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM rates").run();
  urls = [];
  reply = ok(0.74538);
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    const req = new Request(input, init);
    urls.push(req.url);
    if (!req.headers.get("user-agent")) throw new Error("no user-agent");
    return reply();
  });
});
afterEach(() => vi.unstubAllGlobals());

it("fetches the rate, stores it and returns it", async () => {
  expect(await rateToGbp(env, "2026-11-09", "usd")).toBe(0.74538);
  expect(urls).toEqual(["https://api.frankfurter.dev/v1/2026-11-09?base=USD&symbols=GBP"]);
  expect((await stored()).results).toEqual([{ day: "2026-11-09", currency: "USD", to_gbp: 0.74538 }]);
});

it("serves a second call from the cache", async () => {
  await rateToGbp(env, "2026-11-09", "USD");
  expect(await rateToGbp(env, "2026-11-09", "USD")).toBe(0.74538);
  expect(urls).toHaveLength(1);
});

it("caches a weekend date under the requested day", async () => {
  reply = ok(0.86, "2026-11-06");
  expect(await rateToGbp(env, "2026-11-08", "EUR")).toBe(0.86);
  expect((await stored()).results).toEqual([{ day: "2026-11-08", currency: "EUR", to_gbp: 0.86 }]);
  await rateToGbp(env, "2026-11-08", "EUR");
  expect(urls).toHaveLength(1);
});

it("returns 1 for GBP and null for a bad code, with no request", async () => {
  expect(await rateToGbp(env, "2026-11-09", "gbp")).toBe(1);
  expect(await rateToGbp(env, "2026-11-09", "US")).toBeNull();
  expect(await rateToGbp(env, "2026-11-09", "US1")).toBeNull();
  expect(urls).toHaveLength(0);
});

it("returns null and stores nothing on failure", async () => {
  const bad: Array<() => Response> = [
    () => json({}, 500), () => json({ rates: {} }), ok(0), ok(-1), ok("0.7"), ok(null), () => new Response("not json"),
  ];
  for (const r of bad) { reply = r; expect(await rateToGbp(env, "2026-11-09", "USD")).toBeNull(); }
  vi.stubGlobal("fetch", async () => { throw new Error("offline"); });
  expect(await rateToGbp(env, "2026-11-09", "USD")).toBeNull();
  expect((await stored()).results).toEqual([]);
});
