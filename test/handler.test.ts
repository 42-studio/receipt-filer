import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { listEvents, listFiles, listReceipts } from "../src/db";
import { handleEmail, isAllowedSender, isGmailForwardingConfirmation } from "../src/email/handler";
import type { Env } from "../src/env";
import oversize from "./fixtures/oversize.eml?raw";
import pdfAttached from "./fixtures/pdf-attached.eml?raw";
import plainStub from "./fixtures/plain-stub.eml?raw";

const ME = "josh@example.com";
const FORWARD = "receipts-k3v9x2@example.org";
const testEnv = { ...env, ALLOWED_SENDERS: `${ME}, other@example.com`, NOTIFY_TO: "owner@example.com", FORWARD_ADDRESS: FORWARD, EMAIL: { send: vi.fn(async () => ({ messageId: "x" })) } } as unknown as Env;
const ctx = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} } as unknown as ExecutionContext;

function fake(rawText: string, from = ME) {
  const bytes = new TextEncoder().encode(rawText);
  return {
    from, to: "receipts@example.org", raw: new Blob([bytes]).stream(), rawSize: bytes.length,
    forward: vi.fn(async () => ({ messageId: "x" })), setReject: vi.fn(), headers: new Headers(),
  } as unknown as ForwardableEmailMessage & { forward: ReturnType<typeof vi.fn>; setReject: ReturnType<typeof vi.fn> };
}
const withId = (eml: string, id: string) => eml.replace(/^Message-ID:.*$/im, `Message-ID: <${id}>`);
const r2Count = async () => (await env.FILES.list()).objects.length;
// Minimal email carrying one PDF of the given decoded size (base64 of zero bytes).
const withPdf = (bytes: number) =>
  `From: x@y.example\r\nMessage-ID: <big-${bytes}@y.example>\r\nSubject: Big\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nhi\r\n--B\r\nContent-Type: application/pdf; name="big.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${"A".repeat(Math.ceil(bytes / 3) * 4).replace(/(.{76})/g, "$1\r\n")}\r\n--B--\r\n`;

beforeEach(async () => {
  for (const t of ["receipts", "files", "events", "settings"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  for (const o of (await env.FILES.list()).objects) await env.FILES.delete(o.key);
});

it("allows the address itself and Gmail's auto-forward form of it", () => {
  const allowed = ["josh@example.com"];
  expect(isAllowedSender("josh@example.com", allowed)).toBe(true);
  expect(isAllowedSender("Josh@Example.com", allowed)).toBe(true);
  expect(isAllowedSender("josh+caf_=receipts=example.org@example.com", allowed)).toBe(true);
  expect(isAllowedSender("someone@else.com", allowed)).toBe(false);
  expect(isAllowedSender("evil+caf_=a=b@else.com", allowed)).toBe(false);
});
it("fails closed on blank allowlist entries and a blank sender", () => {
  expect(isAllowedSender("", [""])).toBe(false);
  expect(isAllowedSender("  ", ["a@x.com", ""])).toBe(false);
  expect(isAllowedSender("b@x.com", [""])).toBe(false);
});
it("rejects everything when ALLOWED_SENDERS is empty or has a trailing comma", async () => {
  for (const [list, from] of [["", ""], ["a@x.com,", ""]] as const) {
    const m = fake(pdfAttached, from);
    await handleEmail(m, { ...testEnv, ALLOWED_SENDERS: list } as unknown as Env, ctx);
    expect(m.setReject).toHaveBeenCalledOnce();
  }
  expect(await listReceipts(env.DB)).toHaveLength(0);
});
it("stores an unreadable receipt when the raw email cannot be read", async () => {
  const next = vi.fn(async () => {});
  const m = fake(pdfAttached);
  (m as any).raw = new ReadableStream({ start: (c) => c.error(new Error("boom raw")) });
  await handleEmail(m, testEnv, ctx, next);
  const [r] = await listReceipts(env.DB);
  expect(r).toMatchObject({ state: "could_not_read", reason: "unreadable_file" });
  expect((await listEvents(env.DB, r.id)).some((e) => e.message.includes("boom raw"))).toBe(true);
  expect(next).not.toHaveBeenCalled();
});
it("marks the receipt could_not_read when storing a file throws, and a redelivery is still dropped", async () => {
  const next = vi.fn(async () => {});
  const bad = { ...testEnv, FILES: { put: async () => { throw new Error("boom r2"); } } } as unknown as Env;
  await handleEmail(fake(pdfAttached), bad, ctx, next);
  const [r] = await listReceipts(env.DB);
  expect(r).toMatchObject({ state: "could_not_read", reason: "unreadable_file" });
  expect((await listEvents(env.DB, r.id)).some((e) => e.message.includes("boom r2"))).toBe(true);
  expect(next).not.toHaveBeenCalled();
});
it("recognises the Gmail forwarding confirmation sender", () => {
  expect(isGmailForwardingConfirmation("forwarding-noreply@google.com")).toBe(true);
  expect(isGmailForwardingConfirmation("x@google.com")).toBe(false);
});
it("rejects other senders and stores nothing", async () => {
  const m = fake(pdfAttached, "spam@else.com");
  await handleEmail(m, testEnv, ctx);
  expect(m.setReject).toHaveBeenCalledOnce();
  expect(await listReceipts(env.DB)).toHaveLength(0);
});
it("forwards a Gmail forwarding confirmation to NOTIFY_TO and stores nothing", async () => {
  const m = fake(pdfAttached, "forwarding-noreply@google.com");
  await handleEmail(m, testEnv, ctx);
  expect(m.forward).toHaveBeenCalledWith("owner@example.com");
  expect(m.setReject).not.toHaveBeenCalled();
  expect(await listReceipts(env.DB)).toHaveLength(0);
});
it("drops a repeated Message-ID", async () => {
  const next = vi.fn(async () => {});
  await handleEmail(fake(pdfAttached), testEnv, ctx, next);
  await handleEmail(fake(pdfAttached), testEnv, ctx, next);
  expect(await listReceipts(env.DB)).toHaveLength(1);
  expect(next).toHaveBeenCalledOnce();
});
it("marks an email with no receipt file as could_not_read / no_attachment without reading it", async () => {
  const next = vi.fn(async () => {});
  await handleEmail(fake(plainStub), testEnv, ctx, next);
  const [r] = await listReceipts(env.DB);
  expect(r).toMatchObject({ state: "could_not_read", reason: "no_attachment" });
  expect(next).not.toHaveBeenCalled();
  expect(await r2Count()).toBe(0);
  expect((await listEvents(env.DB, r.id)).length).toBeGreaterThan(0);
});
it("marks an email whose only file is over 5 MB as could_not_read / file_too_large", async () => {
  const next = vi.fn(async () => {});
  await handleEmail(fake(withPdf(5_100_000)), testEnv, ctx, next);
  const [r] = await listReceipts(env.DB);
  expect(r).toMatchObject({ state: "could_not_read", reason: "file_too_large" });
  expect(next).not.toHaveBeenCalled();
  expect(await listFiles(env.DB, r.id)).toHaveLength(0);
  expect(await r2Count()).toBe(0);
});
it("stores the files, then hands the receipt to the reader", async () => {
  const next = vi.fn(async () => {});
  await handleEmail(fake(pdfAttached), testEnv, ctx, next);
  const [r] = await listReceipts(env.DB);
  expect(r).toMatchObject({ state: "reading", sender: "billing@pixelgrove.example", subject: "Your receipt from Pixelgrove", bodyIsHtml: false });
  expect(r.body).toContain("£14.00");
  const files = await listFiles(env.DB, r.id);
  expect(files).toHaveLength(1);
  expect(files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(files[0].r2Key).toBe(`receipts/${r.id}/${files[0].id}`);
  expect(await r2Count()).toBe(1);
  expect(await env.FILES.head(files[0].r2Key)).not.toBeNull();
  expect(next).toHaveBeenCalledExactlyOnceWith(r.id);
});
it("accepts the usable files and records an event for each file over 5 MB", async () => {
  const next = vi.fn(async () => {});
  await handleEmail(fake(oversize), testEnv, ctx, next);
  const [r] = await listReceipts(env.DB);
  expect(r.state).toBe("reading");
  expect(await listFiles(env.DB, r.id)).toHaveLength(1);
  expect((await listEvents(env.DB, r.id)).some((e) => e.message.includes("big.pdf"))).toBe(true);
  expect(next).toHaveBeenCalledOnce();
});
it("marks a receipt whose file hash exists in another receipt as duplicate", async () => {
  const next = vi.fn(async () => {});
  await handleEmail(fake(pdfAttached), testEnv, ctx, next);
  await handleEmail(fake(withId(pdfAttached, "second@pixelgrove.example")), testEnv, ctx, next);
  const all = await listReceipts(env.DB);
  const second = all.find((r) => r.messageId?.includes("second@pixelgrove.example"))!;
  const first = all.find((r) => r !== second)!;
  expect(second).toMatchObject({ state: "duplicate", duplicateOf: first.id });
  expect(await listFiles(env.DB, second.id)).toHaveLength(0);
  expect(await r2Count()).toBe(1);
  expect(next).toHaveBeenCalledOnce();
});

it("requests a could_not_read notification for no_attachment and unreadable_file", async () => {
  const notifyFn = vi.fn(async () => {});
  await handleEmail(fake(plainStub), testEnv, ctx, undefined, notifyFn);
  expect(notifyFn).toHaveBeenLastCalledWith(testEnv, "could_not_read", expect.objectContaining({ reason: "no_attachment" }));
  const m = fake(pdfAttached);
  (m as any).raw = new ReadableStream({ start: (c) => c.error(new Error("boom raw")) });
  await handleEmail(m, testEnv, ctx, undefined, notifyFn);
  expect(notifyFn).toHaveBeenLastCalledWith(testEnv, "could_not_read", expect.objectContaining({ reason: "unreadable_file" }));
  expect(notifyFn).toHaveBeenCalledTimes(2);
});
it("does not request a notification for a receipt that goes on to be read", async () => {
  const notifyFn = vi.fn(async () => {});
  await handleEmail(fake(pdfAttached), testEnv, ctx, async () => {}, notifyFn);
  expect(notifyFn).not.toHaveBeenCalled();
});
it("requests a notification for file_too_large and for a failed file store", async () => {
  const notifyFn = vi.fn(async () => {});
  await handleEmail(fake(withPdf(5_100_000)), testEnv, ctx, undefined, notifyFn);
  expect(notifyFn).toHaveBeenLastCalledWith(testEnv, "could_not_read", expect.objectContaining({ reason: "file_too_large" }));
  const broken = { ...testEnv, FILES: { put: async () => { throw new Error("r2 down"); } } } as unknown as Env;
  await handleEmail(fake(pdfAttached), broken, ctx, undefined, notifyFn);
  expect(notifyFn).toHaveBeenLastCalledWith(broken, "could_not_read", expect.objectContaining({ state: "could_not_read", reason: "unreadable_file" }));
  expect(notifyFn).toHaveBeenCalledTimes(2);
});

// A notification the tool sent, forwarded back by a wide Gmail rule.
const notice = (from: string, subject: string) =>
  `From: Receipt filer <${from}>\r\nTo: owner@example.com\r\nSubject: ${subject}\r\nMessage-ID: <${crypto.randomUUID()}@example.org>\r\nContent-Type: text/plain\r\n\r\nThe receipt could not be read.\r\n`;
it("drops the tool's own notifications forwarded back, with no row and no notification", async () => {
  const notifyFn = vi.fn(async () => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  for (const raw of [
    notice(` ${FORWARD.toUpperCase()} `.trim(), "Receipt filer: Could not read - Acme"),
    notice("someone@example.com", "Fwd: Re: FW: Receipt filer: Choose a match - Acme"),
  ]) {
    const m = fake(raw, "josh+caf_=receipts=example.org@example.com");
    await handleEmail(m, testEnv, ctx, undefined, notifyFn);
    expect(m.setReject).not.toHaveBeenCalled();
  }
  expect(log).toHaveBeenCalledTimes(2);
  log.mockRestore();
  expect(await listReceipts(env.DB)).toHaveLength(0);
  expect(notifyFn).not.toHaveBeenCalled();
});
it("still stores an email whose subject merely contains the word receipt", async () => {
  const notifyFn = vi.fn(async () => {});
  await handleEmail(fake(notice("shop@example.com", "Your receipt filer order receipt")), testEnv, ctx, undefined, notifyFn);
  expect(await listReceipts(env.DB)).toHaveLength(1);
  expect(notifyFn).toHaveBeenCalledOnce();
});
