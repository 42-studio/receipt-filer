import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { addFile, createReceipt, getReceipt, listEvents, listFiles, pin, updateReceipt, type Receipt } from "../src/db";
import type { Env } from "../src/env";
import { AttachUnconfirmed, FreeAgentAuthError, FreeAgentUnavailable, pickExplanation, type BankLine } from "../src/freeagent/client";
import { runMatcher } from "../src/match/run";

const E = env as unknown as Env;
const DAY = 86_400_000;
const NOW = new Date("2026-11-15T10:00:00Z");
const line = (n: number, o: Partial<BankLine> = {}): BankLine => ({ url: `https://fa.test/bank_transactions/${n}`, datedOn: "2026-11-14", amountMinor: -2400, description: "ACME", explanations: [{ url: `https://fa.test/explanations/${n}`, grossMinor: -2400 }], ...o });

// Fakes only: no FreeAgent, rates or email call is ever made.
function fakes(lines: BankLine[] = [line(1)]) {
  const f = {
    lines,
    attachCalls: [] as { url: string; files: { filename: string; contentType: string; data: Uint8Array }[] }[],
    listFrom: [] as string[],
    listError: null as Error | null,
    attachError: null as Error | null,
    getError: null as Error | null,
    attachDelay: 0,
  };
  const fa = {
    listBankLines: async (_e: Env, from: string) => { f.listFrom.push(from); if (f.listError) throw f.listError; return f.lines; },
    getBankLine: async (_e: Env, url: string) => { if (f.getError) throw f.getError; return f.lines.find((l) => l.url === url) ?? null; },
    attach: async (_e: Env, url: string, files: any[]) => {
      f.attachCalls.push({ url, files });
      if (f.attachDelay) await new Promise((r) => setTimeout(r, f.attachDelay));
      if (f.attachError) throw f.attachError;
      return files.map((_x, i) => `${url}/attachments/${i + 1}`);
    },
    pickExplanation,
  };
  const notify = vi.fn(async () => {});
  const read = vi.fn(async () => {});
  return { f, deps: { fa, rate: async () => 0.8, notify, read, now: () => NOW }, notify, read };
}

async function make(o: Partial<Receipt> = {}, fileCount = 1) {
  const r = await createReceipt(env.DB, { messageId: crypto.randomUUID(), emailDate: null, sender: "a@b.c", subject: "Receipt", body: "the body", bodyIsHtml: false, state: "waiting_payment", reason: null });
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

it("retries receipts still in reading", async () => {
  const r = await make({ state: "reading" });
  const { deps, read } = fakes();
  await runMatcher(E, deps);
  expect(read).toHaveBeenCalledWith(env, r.id, deps.now, deps.notify);
});

it("pins and files a receipt whose line is explained", async () => {
  const r = await make({}, 2);
  const { f, deps } = fakes();
  await runMatcher(E, deps);
  expect(f.attachCalls).toHaveLength(1);
  expect(f.attachCalls[0].url).toBe("https://fa.test/explanations/1");
  expect(f.attachCalls[0].files.map((x) => x.filename)).toEqual(["r0.pdf", "r1.pdf"]);
  const after = await get(r.id);
  expect(after).toMatchObject({ state: "filed", pinnedLine: line(1).url, pinnedBy: "auto", explanationUrl: "https://fa.test/explanations/1", body: null, filedAt: NOW.toISOString() });
  expect(after.attachmentUrls).toHaveLength(2);
  const files = await listFiles(env.DB, r.id);
  expect(files).toHaveLength(2);
  for (const x of files) expect(await env.FILES.get(x.r2Key)).toBeNull();
  expect((await listEvents(env.DB, r.id)).length).toBeGreaterThan(1);
});

it("waits when the pinned line has no explanation, then files on a later run", async () => {
  const r = await make();
  const { f, deps } = fakes([line(1, { explanations: [] })]);
  await runMatcher(E, deps);
  expect(await get(r.id)).toMatchObject({ state: "waiting_explanation", pinnedLine: line(1).url });
  expect(f.attachCalls).toHaveLength(0);
  f.lines = [line(1)];
  await runMatcher(E, deps);
  expect((await get(r.id)).state).toBe("filed");
  expect(f.attachCalls).toHaveLength(1);
});

it("does not run the fitting rules again for a pinned receipt", async () => {
  const r = await make();
  const { f, deps } = fakes([line(1, { explanations: [] })]);
  await runMatcher(E, deps);
  f.lines = [line(1), line(2, { datedOn: "2026-11-13" })];
  await runMatcher(E, deps);
  expect(f.attachCalls).toHaveLength(1);
  expect(f.attachCalls[0].url).toBe("https://fa.test/explanations/1");
  expect((await get(r.id)).pinnedLine).toBe(line(1).url);
});

it("puts a low-confidence or ambiguous receipt in needs_choice without pinning", async () => {
  const low = await make({ confidence: 0.5 });
  const { deps, notify } = fakes([line(1)]);
  await runMatcher(E, deps);
  expect(await get(low.id)).toMatchObject({ state: "needs_choice", pinnedLine: null });
  expect(notify).toHaveBeenCalledWith(env, "needs_choice", expect.objectContaining({ id: low.id }), deps.now);
  await runMatcher(E, deps);
  expect(notify).toHaveBeenCalledTimes(1);

  const amb = await make();
  const two = fakes([line(1), line(2)]);
  await runMatcher(E, two.deps);
  expect(await get(amb.id)).toMatchObject({ state: "needs_choice", pinnedLine: null });
});

it("returns a receipt to waiting_payment when its pinned line is gone", async () => {
  const r = await make({ state: "waiting_explanation" });
  await pin(env.DB, r.id, "https://fa.test/bank_transactions/9", "auto");
  const { deps } = fakes([]);
  await runMatcher(E, deps);
  expect(await get(r.id)).toMatchObject({ state: "waiting_payment", pinnedLine: null, pinnedBy: null });
});

it("attaches once when two runs overlap", async () => {
  const r = await make();
  const { f, deps } = fakes();
  f.attachDelay = 20;
  await Promise.all([runMatcher(E, deps), runMatcher(E, deps)]);
  expect(f.attachCalls).toHaveLength(1);
  expect((await get(r.id)).state).toBe("filed");
});

it("changes nothing when FreeAgent is unavailable", async () => {
  const r = await make();
  const { f, deps, notify } = fakes();
  f.listError = new FreeAgentUnavailable("down");
  await runMatcher(E, deps);
  expect(await get(r.id)).toMatchObject({ state: "waiting_payment", pinnedLine: null });
  expect(notify).not.toHaveBeenCalled();
  expect((await listFiles(env.DB, r.id))).toHaveLength(1);
});

it("leaves a claimed receipt unchanged and unclaimed when the attach is unavailable", async () => {
  const r = await make();
  const { f, deps, notify } = fakes();
  f.attachError = new FreeAgentUnavailable("down");
  await runMatcher(E, deps);
  expect((await get(r.id)).state).toBe("waiting_payment");
  expect(notify).not.toHaveBeenCalled();
  f.attachError = null;
  await runMatcher(E, deps);
  expect((await get(r.id)).state).toBe("filed");
});

it("marks failed with the error when FreeAgent refuses the attach, and releases the claim", async () => {
  const r = await make();
  const { f, deps, notify } = fakes();
  f.attachError = new Error("file type not allowed");
  await runMatcher(E, deps);
  expect(await get(r.id)).toMatchObject({ state: "failed", reason: "file type not allowed" });
  expect(notify).toHaveBeenCalledWith(env, "failed", expect.objectContaining({ id: r.id }), deps.now);
  const claim = await env.DB.prepare("SELECT attach_claimed_at FROM receipts WHERE id = ?").bind(r.id).first<{ attach_claimed_at: string | null }>();
  expect(claim!.attach_claimed_at).toBeNull();
});

it("asks Josh to reconnect on FreeAgentAuthError", async () => {
  const r = await make();
  const { f, deps, notify } = fakes();
  f.listError = new FreeAgentAuthError("expired");
  await runMatcher(E, deps);
  expect(notify).toHaveBeenCalledOnce();
  expect(notify).toHaveBeenCalledWith(env, "reconnect", undefined, deps.now);
  expect((await get(r.id)).state).toBe("waiting_payment");
});

it("lists bank lines from 5 days before the oldest open receipt", async () => {
  await make({ receiptDate: "2026-11-13" });
  await make({ receiptDate: "2026-11-02" });
  const { f, deps } = fakes([]);
  await runMatcher(E, deps);
  expect(f.listFrom).toEqual(["2026-10-28"]);
});

it("sends one stuck notice after 14 days and keeps the receipt", async () => {
  const r = await make({ receiptDate: "2026-10-30" });
  await env.DB.prepare("UPDATE receipts SET received_at = ? WHERE id = ?").bind(new Date(NOW.getTime() - 15 * DAY).toISOString(), r.id).run();
  const { deps, notify } = fakes([]);
  await runMatcher(E, deps);
  await runMatcher(E, deps);
  const stuck = notify.mock.calls.filter((c: any[]) => c[1] === "stuck");
  expect(stuck.length).toBeGreaterThanOrEqual(1);
  expect((await get(r.id)).state).toBe("waiting_payment");
});

it("runs for one receipt when given its id", async () => {
  const a = await make();
  const b = await make({ totalMinor: 3000, confidence: 0.5 }); // would go to needs_choice if it were run
  const { f, deps } = fakes([line(1), line(2, { amountMinor: -3000 })]);
  await runMatcher(E, deps, a.id);
  expect((await get(a.id)).state).toBe("filed");
  expect(await get(b.id)).toMatchObject({ state: "waiting_payment", pinnedLine: null });
  expect(f.attachCalls).toHaveLength(1);
});

it("pins neither of two same-amount receipts that fit one line", async () => {
  const older = await make({ receiptDate: "2026-11-12" });
  const newer = await make({ receiptDate: "2026-11-13" });
  const { f, deps, notify } = fakes([line(1)]);
  await runMatcher(E, deps);
  for (const r of [older, newer]) {
    expect(await get(r.id)).toMatchObject({ state: "needs_choice", pinnedLine: null });
    expect((await listEvents(env.DB, r.id)).map((e) => e.message).join("\n")).toContain("Another receipt also fits this bank line");
  }
  expect(f.attachCalls).toHaveLength(0);
  expect(notify.mock.calls.filter((c: any[]) => c[1] === "needs_choice")).toHaveLength(2);
});

it("files two same-amount receipts when each fits only its own line", async () => {
  const a = await make({ receiptDate: "2026-10-20" });
  const b = await make({ receiptDate: "2026-11-14" });
  const { f, deps } = fakes([line(1, { datedOn: "2026-10-21" }), line(2, { datedOn: "2026-11-14" })]);
  await runMatcher(E, deps);
  expect(await get(a.id)).toMatchObject({ state: "filed", pinnedLine: line(1).url });
  expect(await get(b.id)).toMatchObject({ state: "filed", pinnedLine: line(2).url });
  expect(f.attachCalls).toHaveLength(2);
});

it("a run for one receipt sees another receipt's claim on the line and changes only its own receipt", async () => {
  const a = await make();
  const b = await make();
  const { f, deps } = fakes([line(1)]);
  await runMatcher(E, deps, a.id);
  expect(await get(a.id)).toMatchObject({ state: "needs_choice", pinnedLine: null });
  expect(await get(b.id)).toMatchObject({ state: "waiting_payment", pinnedLine: null });
  expect(f.attachCalls).toHaveLength(0);
});

it("carries on with the other receipts when one throws", async () => {
  await make({ currency: "USD" });
  const ok = await make();
  const { deps } = fakes([line(1)]);
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  await runMatcher(E, { ...deps, rate: async () => { throw new Error("rate boom"); } });
  spy.mockRestore();
  expect((await get(ok.id)).state).toBe("filed");
});

it("converts a WebP file to JPEG before attaching, and passes other types through", async () => {
  const r = await make({}, 0);
  for (const [name, type] of [["a.webp", "image/webp"], ["b.png", "image/png"]]) {
    const key = `receipts/${r.id}/${name}`;
    await env.FILES.put(key, new Uint8Array([9, 9]));
    await addFile(env.DB, { receiptId: r.id, r2Key: key, filename: name, contentType: type, size: 2, sha256: crypto.randomUUID() });
  }
  const images = { input: () => ({ output: async () => ({ image: () => new Response(new Uint8Array([0xff, 0xd8])).body! }) }) };
  const { f, deps } = fakes();
  await runMatcher({ ...env, IMAGES: images } as unknown as Env, deps);
  expect(f.attachCalls[0].files.map((x) => [x.filename, x.contentType])).toEqual([["a.jpg", "image/jpeg"], ["b.png", "image/png"]]);
  expect([...f.attachCalls[0].files[0].data]).toEqual([0xff, 0xd8]);
});

it("keeps the claim and does not fail the receipt when the write after a successful attach throws", async () => {
  const r = await make();
  const { f, deps, notify } = fakes();
  await env.DB.prepare("CREATE TRIGGER no_filed BEFORE UPDATE ON receipts WHEN NEW.state = 'filed' BEGIN SELECT RAISE(ABORT, 'boom'); END").run();
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await runMatcher(E, deps);
    await runMatcher(E, deps);
  } finally {
    spy.mockRestore();
    await env.DB.prepare("DROP TRIGGER no_filed").run();
  }
  expect(f.attachCalls).toHaveLength(1);
  expect((await get(r.id)).state).not.toBe("failed");
  expect(notify.mock.calls.filter((c: any[]) => c[1] === "failed")).toHaveLength(0);
  const claim = await env.DB.prepare("SELECT attach_claimed_at FROM receipts WHERE id = ?").bind(r.id).first<{ attach_claimed_at: string | null }>();
  expect(claim!.attach_claimed_at).not.toBeNull();
});

const UNCONFIRMED = "FreeAgent did not confirm the attachment. Check the transaction in FreeAgent before you press Retry.";
const claimOf = async (id: string) => (await env.DB.prepare("SELECT attach_claimed_at FROM receipts WHERE id = ?").bind(id).first<{ attach_claimed_at: string | null }>())!.attach_claimed_at;

it("marks failed, keeps the claim and never retries on its own when an attach is unconfirmed", async () => {
  const r = await make();
  const { f, deps, notify } = fakes();
  f.attachError = new AttachUnconfirmed("FreeAgent 502", []);
  await runMatcher(E, deps);
  await runMatcher(E, deps);
  expect(f.attachCalls).toHaveLength(1);
  expect(await get(r.id)).toMatchObject({ state: "failed", reason: UNCONFIRMED, attachmentUrls: null });
  expect(await claimOf(r.id)).not.toBeNull();
  expect(notify).toHaveBeenCalledWith(env, "failed", expect.objectContaining({ id: r.id, reason: UNCONFIRMED }), deps.now);
});

it("records the URLs of a batch that was saved before the failure and does not upload it again", async () => {
  const r = await make({}, 12);
  const { f, deps } = fakes();
  f.attachError = new AttachUnconfirmed("FreeAgent 502", ["https://fa.test/attachments/1", "https://fa.test/attachments/2"]);
  await runMatcher(E, deps);
  await runMatcher(E, deps);
  expect(f.attachCalls).toHaveLength(1);
  expect((await listEvents(env.DB, r.id)).map((e) => e.message).join("\n")).toContain("https://fa.test/attachments/2");
});
