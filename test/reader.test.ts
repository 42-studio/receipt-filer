import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { addFile, createReceipt, getReceipt, listEvents } from "../src/db";
import type { Env } from "../src/env";
import { readInput, readReceipt } from "../src/read/reader";
import scanUrl from "./fixtures/scan.pdf?inline";
import textUrl from "./fixtures/text.pdf?inline";

const bytes = (dataUrl: string) => Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (c) => c.charCodeAt(0));
const textPdf = { contentType: "application/pdf", data: bytes(textUrl) };
const scanPdf = { contentType: "application/pdf", data: bytes(scanUrl) };
const jpeg = (n = 300_000) => ({ contentType: "image/jpeg", data: Uint8Array.from({ length: n }, (_, i) => (i === 0 ? 0xff : i === 1 ? 0xd8 : 7)) });
const textEmail = { subject: "Receipt", body: "Thanks", bodyIsHtml: false, emailDate: "2026-11-13" };
const LONG = "Total paid 424.70 GBP, thanks for your order, jumbled text that is long enough to count";

type Answers = Record<string, { value: unknown; confidence: number }>;
const answers = (o: { total?: number | null; date?: string | null; date_text?: string | null; supplier?: string | null; currency?: string | null; conf?: number }): Answers => ({
  total: { value: o.total === undefined ? 45 : o.total, confidence: o.conf ?? 0.9 },
  date: { value: o.date ?? null, confidence: 0.9 },
  date_text: { value: o.date_text ?? null, confidence: 0.5 },
  supplier: { value: o.supplier ?? null, confidence: 0.9 },
  currency: { value: o.currency ?? null, confidence: 0.4 },
});

// Fakes only: the real AI and IMAGES bindings are remote and cost money.
function fakes() {
  const f = {
    runs: [] as { model: string; input: any }[],
    mdCalls: [] as string[],
    mdText: LONG as string | ((name: string) => string),
    runAnswers: answers({}),
    throwOn: null as null | "run" | "markdown",
    imageDims: { width: 1000, height: 800 },
    imagesUsed: 0,
    resizedOut: new Uint8Array(1000),
  };
  const ai = {
    async run(model: string, input: unknown) {
      if (f.throwOn === "run") throw new Error("boom");
      f.runs.push({ model, input });
      return { answers: f.runAnswers, truncated: false, usage: {} };
    },
    async toMarkdown(doc: { name: string; blob: Blob }) {
      if (f.throwOn === "markdown") throw new Error("boom");
      f.mdCalls.push(doc.name);
      return { id: "x", name: doc.name, mimeType: doc.blob.type, format: "text", tokens: 1, data: typeof f.mdText === "function" ? f.mdText(doc.name) : f.mdText };
    },
  };
  const images = {
    async info() { return { format: "image/jpeg", fileSize: 1, ...f.imageDims }; },
    input() {
      f.imagesUsed++;
      const t = { transform: () => t, output: async () => ({ image: () => new Response(f.resizedOut).body!, contentType: () => "image/jpeg" }) };
      return t;
    },
  };
  return { f, env: { ...env, AI: ai, IMAGES: images, EMAIL: { send: async () => ({ messageId: "x" }) } } as unknown as Env };
}

let h: ReturnType<typeof fakes>;
beforeEach(() => { h = fakes(); });
const lastInput = () => h.f.runs.at(-1)!.input;

it("sends subject, body and PDF text together, with the email date as reference_date", async () => {
  await readInput(h.env, { subject: "Your receipt", body: "Total paid: £424.70", bodyIsHtml: false, emailDate: "2026-11-13" }, [textPdf]);
  const req = h.f.runs.at(-1)!;
  expect(req.model).toBe("@cf/cloudflare/clairic");
  expect(req.input.state).toContain("Your receipt");
  expect(req.input.state).toContain("Total paid: £424.70");
  expect(req.input.state).toContain("jumbled");
  expect(req.input.reference_date).toBe("2026-11-13");
  expect(req.input.images ?? []).toHaveLength(0);
  expect(Object.keys(req.input.fields)).toEqual(["total", "date", "date_text", "supplier", "currency"]);
});

it("sends a plain reference day when the email date is a timestamp, and none when it is not a day", async () => {
  await readInput(h.env, { ...textEmail, emailDate: "2026-11-13T09:00:00.000Z" }, [textPdf]);
  expect(lastInput().reference_date).toBe("2026-11-13");
  await readInput(h.env, { ...textEmail, emailDate: "Thu, 12 Nov 2026" }, [textPdf]);
  expect(lastInput()).not.toHaveProperty("reference_date");
});

it("converts an HTML body to text with toMarkdown", async () => {
  h.f.mdText = (n) => (n.endsWith(".html") ? "converted body text" : LONG);
  await readInput(h.env, { ...textEmail, body: "<p>hi</p>", bodyIsHtml: true }, [textPdf]);
  expect(lastInput().state).toContain("converted body text");
  expect(lastInput().state).not.toContain("<p>");
});

it("sends an image when there is no usable text", async () => {
  const r = await readInput(h.env, textEmail, [{ contentType: "image/jpeg", data: jpeg().data }]);
  expect(lastInput().images).toHaveLength(1);
  expect(lastInput().images[0]).toMatchObject({ content_type: "image/jpeg" });
  expect(typeof lastInput().images[0].base64).toBe("string");
  expect(r).toMatchObject({ ok: true, reading: { inputKind: "image" } });
});

it("copies the JPEG out of a scanned PDF", async () => {
  h.f.mdText = "";
  await readInput(h.env, textEmail, [scanPdf]);
  expect(lastInput().images.length).toBeGreaterThan(0);
  expect(lastInput().state).toContain("Receipt");
  expect(lastInput().state).not.toContain("jumbled");
});

it("returns unreadable_file for a GIF-only receipt and for a scan with no JPEG inside", async () => {
  expect(await readInput(h.env, textEmail, [{ contentType: "image/gif", data: jpeg().data }])).toEqual({ ok: false, reason: "unreadable_file" });
  h.f.mdText = "";
  expect(await readInput(h.env, textEmail, [textPdf])).toEqual({ ok: false, reason: "unreadable_file" });
  expect(h.f.runs).toHaveLength(0);
});

it("resizes an image over 1600 px or over 4 MiB before sending", async () => {
  h.f.imageDims = { width: 3000, height: 2000 };
  await readInput(h.env, textEmail, [jpeg()]);
  expect(h.f.imagesUsed).toBe(1);
  expect(atob(lastInput().images[0].base64)).toHaveLength(1000);

  h.f.imagesUsed = 0;
  h.f.imageDims = { width: 1000, height: 800 };
  await readInput(h.env, textEmail, [jpeg(4_194_305)]);
  expect(h.f.imagesUsed).toBe(1);
  await readInput(h.env, textEmail, [jpeg()]);
  expect(h.f.imagesUsed).toBe(1);
});

it("converts HEIC to JPEG through the Images binding", async () => {
  await readInput(h.env, textEmail, [{ contentType: "image/heic", data: jpeg().data }]);
  expect(h.f.imagesUsed).toBe(1);
  expect(lastInput().images[0].content_type).toBe("image/jpeg");
});

it("sends at most four images", async () => {
  await readInput(h.env, textEmail, Array.from({ length: 6 }, () => jpeg()));
  expect(lastInput().images).toHaveLength(4);
});

it("maps the answers", async () => {
  h.f.runAnswers = answers({ total: 45, date: "2026-07-11", date_text: "07/11/2026", supplier: "Saltmarsh Kitchen", currency: "£" });
  expect(await readInput(h.env, textEmail, [textPdf])).toEqual({
    ok: true,
    reading: { totalMinor: 4500, confidence: 0.9, date: "2026-11-07", supplier: "Saltmarsh Kitchen", currency: "GBP", inputKind: "text" },
  });
});

it("keeps a negative total for a refund", async () => {
  h.f.runAnswers = answers({ total: -45 });
  expect(await readInput(h.env, textEmail, [textPdf])).toMatchObject({ ok: true, reading: { totalMinor: -4500 } });
});

it("drops the supplier for image input", async () => {
  h.f.runAnswers = answers({ supplier: "Saltmarsh Kitchen" });
  expect(await readInput(h.env, textEmail, [jpeg()])).toMatchObject({ ok: true, reading: { supplier: null, inputKind: "image" } });
});

it("returns no_total when Clairic gives no total, and zero_total for 0.00", async () => {
  h.f.runAnswers = answers({ total: null });
  expect(await readInput(h.env, textEmail, [textPdf])).toEqual({ ok: false, reason: "no_total" });
  h.f.runAnswers = answers({ total: 0 });
  expect(await readInput(h.env, textEmail, [textPdf])).toEqual({ ok: false, reason: "zero_total" });
});

it("returns a low-confidence reading instead of rejecting it", async () => {
  h.f.runAnswers = answers({ conf: 0.35 });
  expect(await readInput(h.env, textEmail, [textPdf])).toMatchObject({ ok: true, reading: { confidence: 0.35 } });
});

it("asks for a retry when Clairic or toMarkdown throws", async () => {
  h.f.throwOn = "run";
  expect(await readInput(h.env, textEmail, [textPdf])).toEqual({ ok: false, retry: true, error: "boom" });
  h.f.throwOn = "markdown";
  expect(await readInput(h.env, textEmail, [textPdf])).toEqual({ ok: false, retry: true, error: "boom" });
});

it("treats a Clairic reply with no answers as a retry with an error text", async () => {
  h.f.runAnswers = undefined as never;
  expect(await readInput(h.env, textEmail, [textPdf])).toMatchObject({ ok: false, retry: true, error: expect.any(String) });
});

it("returns zero_total when the total rounds to zero minor units", async () => {
  h.f.runAnswers = answers({ total: 0.004 });
  expect(await readInput(h.env, textEmail, [textPdf])).toEqual({ ok: false, reason: "zero_total" });
});

it("readReceipt writes waiting_payment, or could_not_read with the reason, or leaves reading on retry", async () => {
  const make = async () => {
    const r = await createReceipt(env.DB, { messageId: crypto.randomUUID(), emailDate: "2026-11-13", sender: "a@b.c", subject: "Receipt", body: "Thanks", bodyIsHtml: false, state: "reading", reason: null });
    const r2Key = `test/${r.id}.pdf`;
    await env.FILES.put(r2Key, textPdf.data);
    await addFile(env.DB, { receiptId: r.id, r2Key, filename: "r.pdf", contentType: "application/pdf", size: textPdf.data.length, sha256: r.id });
    return r.id;
  };

  h.f.runAnswers = answers({ total: 45.5, supplier: "Saltmarsh", currency: "£", date: "2026-11-10" });
  let id = await make();
  await readReceipt(h.env, id);
  expect(await getReceipt(env.DB, id)).toMatchObject({ state: "waiting_payment", supplier: "Saltmarsh", totalMinor: 4550, currency: "GBP", receiptDate: "2026-11-10", confidence: 0.9, inputKind: "text" });
  expect((await listEvents(env.DB, id)).length).toBe(1);

  h.f.runAnswers = answers({ total: null });
  id = await make();
  await readReceipt(h.env, id);
  expect(await getReceipt(env.DB, id)).toMatchObject({ state: "could_not_read", reason: "no_total" });
  expect((await listEvents(env.DB, id)).length).toBe(1);

  h.f.throwOn = "run";
  id = await make();
  await readReceipt(h.env, id);
  expect(await getReceipt(env.DB, id)).toMatchObject({ state: "reading", reason: "retrying: boom" });
  expect((await listEvents(env.DB, id)).length).toBe(1);
});

it("readReceipt stores the receipt's own day when the email date is a postal-mime timestamp", async () => {
  const r = await createReceipt(env.DB, { messageId: crypto.randomUUID(), emailDate: "2026-11-13T09:00:00.000Z", sender: "a@b.c", subject: "Receipt", body: "Thanks", bodyIsHtml: false, state: "reading", reason: null });
  await env.FILES.put(`test/${r.id}.pdf`, textPdf.data);
  await addFile(env.DB, { receiptId: r.id, r2Key: `test/${r.id}.pdf`, filename: "r.pdf", contentType: "application/pdf", size: textPdf.data.length, sha256: r.id });
  h.f.runAnswers = answers({ total: 12, date: "2026-11-02", date_text: "02/11/2026" });
  await readReceipt(h.env, r.id);
  expect((await getReceipt(env.DB, r.id))!.receiptDate).toBe("2026-11-02");
});

async function makeReceipt(state: "reading" | "filed" = "reading") {
  const r = await createReceipt(env.DB, { messageId: crypto.randomUUID(), emailDate: "2026-11-13", sender: "a@b.c", subject: "Receipt", body: "Thanks", bodyIsHtml: false, state, reason: null });
  const r2Key = `test/${r.id}.pdf`;
  await env.FILES.put(r2Key, textPdf.data);
  await addFile(env.DB, { receiptId: r.id, r2Key, filename: "r.pdf", contentType: "application/pdf", size: textPdf.data.length, sha256: r.id });
  return r.id;
}

it("stores the retry reason and writes one event for two identical failures, a second for a changed error", async () => {
  h.f.throwOn = "run";
  const id = await makeReceipt();
  await readReceipt(h.env, id);
  await readReceipt(h.env, id);
  expect(await getReceipt(env.DB, id)).toMatchObject({ state: "reading", reason: "retrying: boom" });
  expect(await listEvents(env.DB, id)).toHaveLength(1);
  h.f.throwOn = "markdown";
  h.f.mdText = LONG;
  const orig = h.env.AI.toMarkdown;
  (h.env.AI as any).toMarkdown = async () => { throw new Error("different"); };
  await readReceipt(h.env, id);
  expect(await getReceipt(env.DB, id)).toMatchObject({ reason: "retrying: different" });
  expect(await listEvents(env.DB, id)).toHaveLength(2);
  (h.env.AI as any).toMarkdown = orig;
});

it("gives up on a retry outcome for a receipt received over 24 hours ago", async () => {
  h.f.throwOn = "run";
  const id = await makeReceipt();
  await readReceipt(h.env, id, () => new Date(Date.now() + 25 * 3_600_000));
  expect(await getReceipt(env.DB, id)).toMatchObject({ state: "could_not_read", reason: "unreadable_file" });
  const ev = await listEvents(env.DB, id);
  expect(ev).toHaveLength(1);
  expect(ev[0].message).toContain("boom");
});

it("leaves a receipt that is not reading untouched", async () => {
  const id = await makeReceipt("filed");
  await readReceipt(h.env, id);
  expect(await getReceipt(env.DB, id)).toMatchObject({ state: "filed", totalMinor: null });
  expect(await listEvents(env.DB, id)).toHaveLength(0);
  expect(h.f.runs).toHaveLength(0);
});

it("requests a could_not_read notification for unreadable_file but not for no_total or zero_total", async () => {
  const notifyFn = vi.fn(async () => {});
  h.f.runAnswers = answers({ total: null });
  let id = await makeReceipt();
  await readReceipt(h.env, id, undefined, notifyFn);
  h.f.runAnswers = answers({ total: 0 });
  await readReceipt(h.env, await makeReceipt(), undefined, notifyFn);
  expect(notifyFn).not.toHaveBeenCalled();
  h.f.throwOn = "run";
  id = await makeReceipt();
  await readReceipt(h.env, id, () => new Date(Date.now() + 25 * 3_600_000), notifyFn);
  expect(notifyFn).toHaveBeenLastCalledWith(h.env, "could_not_read", expect.objectContaining({ id, reason: "unreadable_file" }));
});

it("requests a notification when the read outcome is unreadable_file", async () => {
  const notifyFn = vi.fn(async () => {});
  h.f.mdText = ""; // no text layer and no embedded image: nothing Clairic can read
  const id = await makeReceipt();
  await readReceipt(h.env, id, undefined, notifyFn);
  expect(await getReceipt(env.DB, id)).toMatchObject({ state: "could_not_read", reason: "unreadable_file" });
  expect(notifyFn).toHaveBeenCalledExactlyOnceWith(h.env, "could_not_read", expect.objectContaining({ id, reason: "unreadable_file" }));
});
