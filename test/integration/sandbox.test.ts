// The only test that calls FreeAgent (sandbox). Skipped unless FREEAGENT_SANDBOX_TOKENS is set to the
// stored-tokens JSON ({"access_token","refresh_token","expires_at"}). Needs a sandbox bank account.
import { env as workerEnv } from "cloudflare:workers";
import { expect, it } from "vitest";
import { setSetting } from "../../src/db";
import type { Env } from "../../src/env";
import { attach, listBankLines } from "../../src/freeagent/client";

const tokens = (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.FREEAGENT_SANDBOX_TOKENS;
const env = workerEnv as unknown as Env;

it.skipIf(!tokens)("uploads a bank line, lists it with one explanation and attaches a file", async () => {
  await setSetting(env.DB, "freeagent_tokens", tokens!);
  const { access_token } = JSON.parse(tokens!);
  const base = env.FREEAGENT_BASE_URL;
  const call = async (path: string, method = "GET", body?: unknown) => {
    const r = await fetch(path.startsWith("http") ? path : base + path, {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: { Authorization: `Bearer ${access_token}`, "X-Api-Version": "2026-09-01", Accept: "application/json", "Content-Type": "application/json", "User-Agent": "receipt-filer-test" },
    });
    expect(r.status, await r.clone().text()).toBeLessThan(300);
    return r.json() as Promise<any>;
  };

  const account = (await call("/bank_accounts")).bank_accounts.find((a: any) => a.status === "active").url;
  const category = (await call("/categories")).admin_expenses_categories[0].url;
  const today = new Date().toISOString().slice(0, 10);
  const run = crypto.randomUUID().slice(0, 6);
  await call(`/bank_transactions/statement?bank_account=${encodeURIComponent(account)}`, "POST", {
    statement: [{ dated_on: today, description: `RF-TEST ${run}`, amount: -12.34, fitid: `rf-${run}` }],
  });

  let line;
  for (let i = 0; i < 10 && !line; i++) {
    line = (await listBankLines(env, today)).find((l) => l.description.includes(`RF-TEST ${run}`));
    if (!line) await new Promise((r) => setTimeout(r, 2000));
  }
  expect(line).toBeTruthy();
  await call("/bank_transaction_explanations", "POST", {
    bank_transaction_explanation: { bank_transaction: line!.url, dated_on: today, gross_value: "-12.34", category, description: "rf test", marked_for_review: true },
  });

  const explained = (await listBankLines(env, today)).find((l) => l.url === line!.url)!;
  expect(explained.explanations).toHaveLength(1);
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
  const urls = await attach(env, explained.explanations[0].url, [{ filename: "receipt.png", contentType: "image/png", data: png }]);
  expect(urls).toHaveLength(1);
}, 60_000);
