import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import {
  addEvent, addFile, claimForAttach, createReceipt, deleteReceipt, findByMessageId, findDuplicateFile, getReceipt,
  getSetting, listEvents, listFiles, listOpen, listReceipts, pin, releaseClaim, setSetting, unpin, updateReceipt, usedLines,
} from "../src/db";

const db = env.DB;
const base = { messageId: "m1", emailDate: "2026-11-01", sender: "a@b.c", subject: "Receipt", body: "hi", bodyIsHtml: false, state: "reading" as const, reason: null };
const file = (receiptId: string, sha256 = "h1") => ({ receiptId, r2Key: `k/${receiptId}/${sha256}`, filename: "r.pdf", contentType: "application/pdf", size: 10, sha256 });

beforeEach(async () => {
  for (const t of ["receipts", "files", "events", "settings"]) await db.prepare(`DELETE FROM ${t}`).run();
});

it("creates and reads back a receipt with typed fields", async () => {
  const r = await createReceipt(db, { ...base, bodyIsHtml: true });
  expect(r).toMatchObject({ messageId: "m1", bodyIsHtml: true, state: "reading", notified: [], attachmentUrls: null, pinnedLine: null });
  expect(await getReceipt(db, r.id)).toEqual(r);
  expect((await findByMessageId(db, "m1"))?.id).toBe(r.id);
  expect(await findByMessageId(db, "nope")).toBeNull();
  expect(await getReceipt(db, "nope")).toBeNull();
});

it("updates fields and always sets updatedAt", async () => {
  const r = await createReceipt(db, base);
  await db.prepare("UPDATE receipts SET updated_at='2000-01-01T00:00:00.000Z' WHERE id=?").bind(r.id).run();
  await updateReceipt(db, r.id, { state: "filed", notified: ["a"], totalMinor: 1234, attachmentUrls: ["u1"] });
  const u = (await getReceipt(db, r.id))!;
  expect(u).toMatchObject({ state: "filed", notified: ["a"], totalMinor: 1234, attachmentUrls: ["u1"] });
  expect(u.updatedAt > "2000-01-01").toBe(true);
});

it("skips undefined patch values but writes explicit null", async () => {
  const r = await createReceipt(db, base);
  await updateReceipt(db, r.id, { attachmentUrls: ["u1"], supplier: "S" });
  await updateReceipt(db, r.id, { attachmentUrls: undefined, supplier: null });
  expect(await getReceipt(db, r.id)).toMatchObject({ attachmentUrls: ["u1"], supplier: null });
  expect(await claimForAttach(db, r.id)).toBe(false);
});

it("pins one receipt per bank line", async () => {
  const a = await createReceipt(db, base), b = await createReceipt(db, { ...base, messageId: "m2" });
  expect(await pin(db, a.id, "https://fa/bt/1", "auto")).toBe(true);
  expect(await pin(db, b.id, "https://fa/bt/1", "auto")).toBe(false);
  expect(await usedLines(db)).toEqual(new Set(["https://fa/bt/1"]));
  expect((await getReceipt(db, a.id))).toMatchObject({ pinnedLine: "https://fa/bt/1", pinnedBy: "auto" });
  await unpin(db, a.id);
  expect(await usedLines(db)).toEqual(new Set());
  expect(await pin(db, b.id, "https://fa/bt/1", "manual")).toBe(true);
});

it("lets only one caller claim a receipt for attaching", async () => {
  const r = await createReceipt(db, base);
  expect([await claimForAttach(db, r.id), await claimForAttach(db, r.id)]).toEqual([true, false]);
  await releaseClaim(db, r.id);
  expect(await claimForAttach(db, r.id)).toBe(true);
});

it("never claims a receipt that already has attachment URLs", async () => {
  const r = await createReceipt(db, base);
  await updateReceipt(db, r.id, { attachmentUrls: ["https://fa/att/9"] });
  expect(await claimForAttach(db, r.id)).toBe(false);
});

it("finds a file with the same hash in another receipt only", async () => {
  const a = await createReceipt(db, base), b = await createReceipt(db, { ...base, messageId: "m2" });
  const f = await addFile(db, file(a.id));
  expect(await findDuplicateFile(db, "h1", a.id)).toBeNull();
  expect(await findDuplicateFile(db, "h1", b.id)).toEqual(f);
  expect(await listFiles(db, a.id)).toEqual([f]);
});

it("deleteReceipt removes rows and returns its files", async () => {
  const a = await createReceipt(db, base);
  const f = await addFile(db, file(a.id));
  await addEvent(db, a.id, "hello");
  expect(await deleteReceipt(db, a.id)).toEqual([f]);
  for (const t of ["receipts", "files", "events"]) expect((await db.prepare(`SELECT COUNT(*) n FROM ${t}`).first<{ n: number }>())!.n).toBe(0);
});

it("lists events in order", async () => {
  const a = await createReceipt(db, base);
  await addEvent(db, a.id, "one");
  await addEvent(db, a.id, "two");
  expect((await listEvents(db, a.id)).map((e) => e.message)).toEqual(["one", "two"]);
});

it("lists open receipts before filed ones", async () => {
  const f = await createReceipt(db, { ...base, messageId: "f", state: "filed" });
  const w = await createReceipt(db, { ...base, messageId: "w", state: "waiting_payment" });
  expect((await listReceipts(db)).map((r) => r.id)).toEqual([w.id, f.id]);
  expect((await listOpen(db)).map((r) => r.id)).toEqual([w.id]);
});

it("stores settings", async () => {
  expect(await getSetting(db, "k")).toBeNull();
  await setSetting(db, "k", "v1");
  await setSetting(db, "k", "v2");
  expect(await getSetting(db, "k")).toBe("v2");
});
