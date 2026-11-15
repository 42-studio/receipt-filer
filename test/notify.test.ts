import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { createReceipt, getReceipt, getSetting } from "../src/db";
import type { Env } from "../src/env";
import { notify, shouldNotify } from "../src/notify";

// A fake EMAIL binding: no real email is ever sent.
function fakeEnv(send = vi.fn(async () => ({ messageId: "m" }))) {
  const e = { ...env, EMAIL: { send }, NOTIFY_TO: "owner@example.com", FORWARD_ADDRESS: "receipts@example.org", APP_URL: "https://receipts.example.com" } as unknown as Env;
  return { e, send };
}
const make = (o: { state?: any; reason?: string | null; supplier?: string | null; subject?: string | null } = {}) =>
  createReceipt(env.DB, { messageId: crypto.randomUUID(), emailDate: null, sender: "a@b.c", subject: o.subject ?? "Your receipt", body: "secret body £99.99", bodyIsHtml: false, state: o.state ?? "could_not_read", reason: o.reason ?? "no_attachment" });

beforeEach(async () => {
  for (const t of ["receipts", "files", "events", "settings"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

it("sends one email per receipt and kind", async () => {
  const { e, send } = fakeEnv();
  const r = await make();
  await notify(e, "could_not_read", r);
  await notify(e, "could_not_read", (await getReceipt(env.DB, r.id))!);
  expect(send).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "owner@example.com", from: "receipts@example.org" }));
  expect((await getReceipt(env.DB, r.id))!.notified).toEqual(["could_not_read"]);
});
it("emails for no_attachment, file_too_large and unreadable_file", async () => {
  for (const reason of ["no_attachment", "file_too_large", "unreadable_file"]) expect(shouldNotify("could_not_read", await make({ reason }))).toBe(true);
  for (const k of ["stuck", "needs_choice", "failed", "reconnect"] as const) expect(shouldNotify(k, await make())).toBe(true);
});
it("stays quiet for no_total and zero_total", async () => {
  const { e, send } = fakeEnv();
  for (const reason of ["no_total", "zero_total"]) {
    const r = await make({ reason });
    expect(shouldNotify("could_not_read", r)).toBe(false);
    await notify(e, "could_not_read", r);
  }
  expect(send).not.toHaveBeenCalled();
});
it("sends the reconnect notice at most once a day", async () => {
  const { e, send } = fakeEnv();
  const t = new Date("2026-11-15T10:00:00Z");
  await notify(e, "reconnect", undefined, () => t);
  await notify(e, "reconnect", undefined, () => new Date(t.getTime() + 23 * 3_600_000));
  expect(send).toHaveBeenCalledOnce();
  expect(await getSetting(env.DB, "reconnect_notified_at")).toBe(t.toISOString());
  await notify(e, "reconnect", undefined, () => new Date(t.getTime() + 25 * 3_600_000));
  expect(send).toHaveBeenCalledTimes(2);
});
it("names the receipt and links to it, without the email body", async () => {
  const { e, send } = fakeEnv();
  const r = await make({ reason: "unreadable_file", subject: "Invoice 42" });
  await notify(e, "could_not_read", r);
  const m = (send.mock.calls[0] as any)[0];
  expect(m.subject).toContain("Invoice 42");
  expect(m.text).toContain(`https://receipts.example.com/receipts/${r.id}`);
  expect(m.text).not.toContain("99.99");
  expect(m.html).toBeUndefined();
  const named = await make({ reason: "no_attachment" });
  await notify(e, "could_not_read", { ...named, supplier: "Saltmarsh" });
  expect((send.mock.calls[1] as any)[0].subject).toContain("Saltmarsh");
});
it("never throws and does not mark the kind sent when the send fails", async () => {
  const { e, send } = fakeEnv(vi.fn(async () => { throw new Error("down"); }));
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const r = await make();
  await expect(notify(e, "could_not_read", r)).resolves.toBeUndefined();
  expect((await getReceipt(env.DB, r.id))!.notified).toEqual([]);
  await expect(notify(e, "reconnect")).resolves.toBeUndefined();
  expect(await getSetting(env.DB, "reconnect_notified_at")).toBeNull();
  expect(send).toHaveBeenCalledTimes(2);
  err.mockRestore();
});
it("keeps every kind when called with the same stale receipt copy", async () => {
  const { e, send } = fakeEnv();
  const r = await make();
  await notify(e, "stuck", r);
  await notify(e, "failed", r);
  expect([...(await getReceipt(env.DB, r.id))!.notified].sort()).toEqual(["failed", "stuck"]);
  await notify(e, "stuck", r);
  expect(send).toHaveBeenCalledTimes(2);
});
