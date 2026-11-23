// Local UI playground: the real UI with fake FreeAgent, AI and email, seeded with test receipts.
// Run: npm run dev:ui. Dev-only routes (this worker never ships):
//   GET /__scenarios           the data scenarios and which one is showing (JSON)
//   GET /__scenario?name=<id>  wipe and seed that scenario (JSON)
//   GET /__reset               reseed the scenario that is showing, then go to /
//   GET /__new                 email in a fresh receipt that finishes reading ~8 s later
import { addEvent, addFile, createReceipt, getSetting, pin, setSetting, updateReceipt } from "../src/db";
import type { Env } from "../src/env";
import { pickExplanation, type BankLine } from "../src/freeagent/client";
import { runMatcher } from "../src/match/run";
import { createApp } from "../src/ui/app";
import { receiptPdf } from "./receipt-pdf";
import { ago, BASE, filesOf, printed, SCENARIOS } from "./scenarios";

const explained = (n: number, gross: number) => [{ url: `${BASE}/bank_transaction_explanations/${n}`, grossMinor: gross }];
const line = (n: number, datedOn: string, amountMinor: number, description: string, isExplained = true): BankLine =>
  ({ url: `${BASE}/bank_transactions/${n}`, datedOn, amountMinor, description, explanations: isExplained ? explained(n, amountMinor) : [] });

// A function, not a constant: Date.now() is frozen at 0 while a Worker module loads.
const lines = (): BankLine[] => [
  line(1, ago(1), -2400, "ACME LTD LONDON"),
  line(2, ago(2), -645, "PRET A MANGER 0231"),
  line(3, ago(3), -7810, "STRIPE* USD 99.00"),
  line(4, ago(4), -999, "OTHER SHOP", false),
  line(5, ago(1), -2400, "AMAZON MKTPLACE"),
  line(6, ago(6), -1250, "CARD PAYMENT TESCO"),
  line(7, ago(9), -1500, "NOTION LABS INC"),
  line(8, ago(12), -3600, "TRAINLINE"),
  line(9, ago(4), -2185, "UBER *TRIP HELP.UBER.COM"),
  line(10, ago(6), -1120, "UBER *EATS"),
];

const fa = {
  listBankLines: async () => lines(),
  getBankLine: async (_e: Env, url: string) => lines().find((l) => l.url === url) ?? null,
  attach: async (_e: Env, url: string, files: unknown[]) => files.map((_x, i) => `${url}/attachments/${i + 1}`),
  pickExplanation,
  // FreeAgent "approves" at once: the callback on this origin completes the real state check.
  authoriseUrl: (_e: Env, state: string, redirect: string) => `${redirect}?state=${state}&code=dev`,
  exchangeCode: async (e: Env) => setSetting(e.DB, "freeagent_tokens", "{}"),
  isConnected: async (e: Env) => (await getSetting(e.DB, "freeagent_tokens")) !== null,
};
// A retry "reads" the receipt again as a plain GBP receipt dated today.
const read = async (e: Env, id: string) =>
  updateReceipt(e.DB, id, { state: "waiting_payment", reason: null, supplier: "Re-read Ltd", totalMinor: 1250, currency: "GBP", receiptDate: ago(6), confidence: 0.92, inputKind: "text" });
const match = (e: Env, id: string) =>
  runMatcher(e, { fa, rate: async () => 0.789, notify: async () => {}, now: () => new Date(), read: read as never, convert: async (_e, f) => f }, id);
const app = createApp({ fa, read, runMatcher: match, rate: async () => 0.789 });

const SCENARIO_KEY = "dev_scenario";

/** Wipes the data, then seeds the named scenario's receipts and remembers which one is showing. */
async function seedScenario(env: Env, id: string) {
  const scenario = SCENARIOS.find((x) => x.id === id) ?? SCENARIOS[0];
  for (const t of ["events", "files", "receipts", "settings"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  for (let page = await env.FILES.list({ prefix: "receipts/" }); page.objects.length; page = await env.FILES.list({ prefix: "receipts/" })) {
    await env.FILES.delete(page.objects.map((o) => o.key));
  }
  const ids: string[] = [];
  for (const s of scenario.build()) {
    const { subject, sender, days, doc: _doc, files: _files, noFile: _noFile, events = [], pinTo, dupOf, ...patch } = s;
    const r = await createReceipt(env.DB, { messageId: crypto.randomUUID(), emailDate: new Date(Date.now() - days * 86_400_000).toISOString(), sender, subject, body: "Thanks for your order.", bodyIsHtml: false, state: patch.state ?? "reading", reason: patch.reason ?? null });
    await updateReceipt(env.DB, r.id, { ...patch, ...(dupOf !== undefined ? { duplicateOf: ids[dupOf] } : {}), receivedAt: new Date(Date.now() - days * 86_400_000).toISOString() });
    for (const [filename, contentType, data] of filesOf(s)) {
      const key = `receipts/${r.id}/${filename}`;
      await env.FILES.put(key, data);
      await addFile(env.DB, { receiptId: r.id, r2Key: key, filename, contentType, size: data.byteLength, sha256: crypto.randomUUID() });
    }
    for (const e of events) await addEvent(env.DB, r.id, e);
    if (pinTo) await pin(env.DB, r.id, lines()[pinTo - 1].url, "auto");
    ids.push(r.id);
  }
  await setSetting(env.DB, SCENARIO_KEY, scenario.id);
  return scenario.id;
}

/** First request after start: seed the default scenario unless one is already showing (an empty one included). */
async function seed(env: Env) {
  if (!(await getSetting(env.DB, SCENARIO_KEY))) await seedScenario(env, SCENARIOS[0].id);
}

// A receipt from /__new finishes reading ~8 s after it arrives, as the real reader would. Seeded ones stay reading.
async function finishReading(env: Env) {
  const due = new Date(Date.now() - 8000).toISOString();
  const { results } = await env.DB.prepare("SELECT id FROM receipts WHERE state = 'reading' AND message_id LIKE 'dev-new-%' AND updated_at < ?").bind(due).all<{ id: string }>();
  for (const { id } of results) {
    await read(env, id);
    await addEvent(env.DB, id, "Read GBP 12.50 from Re-read Ltd");
    await match(env, id);
  }
}

async function arrive(env: Env) {
  const n = Math.floor(Math.random() * 900) + 100;
  const r = await createReceipt(env.DB, { messageId: `dev-new-${crypto.randomUUID()}`, emailDate: new Date().toISOString(), sender: "orders@shop.example", subject: `Order #${n} receipt`, body: "Thanks.", bodyIsHtml: false, state: "reading", reason: null });
  const pdf = receiptPdf({ supplier: "Re-read Ltd", address: ["Online order"], kind: "Receipt", number: `#${n}`, date: printed(0), currency: "GBP", items: [["Order " + n, 1250]] });
  await env.FILES.put(`receipts/${r.id}/order-${n}.pdf`, pdf);
  await addFile(env.DB, { receiptId: r.id, r2Key: `receipts/${r.id}/order-${n}.pdf`, filename: `order-${n}.pdf`, contentType: "application/pdf", size: pdf.byteLength, sha256: crypto.randomUUID() });
  await addEvent(env.DB, r.id, "Received");
}

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

let seeded: Promise<void> | undefined;
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);
    await (seeded ??= seed(env).catch((e) => { seeded = undefined; throw e; }));
    switch (url.pathname) {
      case "/__scenarios":
        return json({ current: await getSetting(env.DB, SCENARIO_KEY), scenarios: SCENARIOS.map(({ id, label, description }) => ({ id, label, description })) });
      case "/__scenario":
        return json({ current: await seedScenario(env, url.searchParams.get("name") ?? "") });
      case "/__reset":
        await seedScenario(env, (await getSetting(env.DB, SCENARIO_KEY)) ?? SCENARIOS[0].id);
        return Response.redirect(new URL("/", req.url).href, 303);
      case "/__new":
        await arrive(env);
        return req.headers.get("Accept")?.includes("application/json") ? json({ ok: true }) : Response.redirect(new URL("/", req.url).href, 303);
      case "/api/receipts":
        await finishReading(env);
    }
    return app.fetch(req, env, ctx);
  },
};
