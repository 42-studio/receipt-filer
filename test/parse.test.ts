import { expect, it } from "vitest";
import { chooseBody, parseEmail, selectReceiptFiles, stripQuoted, type Attachment } from "../src/email/parse";
import forwarded from "./fixtures/forwarded.eml?raw";
import oversize from "./fixtures/oversize.eml?raw";
import pdfAttached from "./fixtures/pdf-attached.eml?raw";
import photo from "./fixtures/photo.eml?raw";
import plainStub from "./fixtures/plain-stub.eml?raw";

const raw = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const file = (contentType: string, size: number, filename = "f"): Attachment => ({ filename, contentType, data: new Uint8Array(size) });
const pdf = (n: number) => file("application/pdf", n, "a.pdf");
const png = (n: number) => file("image/png", n, "a.png");
const jpeg = (n: number) => file("image/jpeg", n, "a.jpg");
const gif = (n: number) => file("image/gif", n, "a.gif");

it("uses the HTML part when the plain part is short", () => {
  expect(chooseBody("Your email client does not support HTML.", "<p>Total £9.20</p>").kind).toBe("html");
  expect(chooseBody("x".repeat(200), "<p>y</p>").kind).toBe("plain");
  expect(chooseBody(null, "<p>y</p>").kind).toBe("html");
  expect(chooseBody("short", null).kind).toBe("plain");
});
it("cuts a signature and older quoted messages", () => {
  const out = stripQuoted("Receipt #8841\nTotal paid: £14.00\n\n--\nJosh Pollard\nStudio 42\n\nOn Mon, 12 Oct 2026 Pixelgrove wrote:\n> Total paid: £12.00");
  expect(out).toContain("£14.00");
  expect(out).not.toContain("£12.00");
  expect(out).not.toContain("Studio 42");
});
it("keeps the forwarded message itself", () => {
  const out = stripQuoted("---------- Forwarded message ---------\nFrom: Pixelgrove\n\nReceipt #8841\nTotal paid: £14.00");
  expect(out).toContain("Receipt #8841");
  expect(out).toContain("£14.00");
});
it("keeps every PDF and only images of 50,000 bytes or more", () => {
  const { files } = selectReceiptFiles([pdf(1_000), png(3_000), jpeg(300_000), gif(60_000)]);
  expect(files.map((f) => f.contentType)).toEqual(["application/pdf", "image/jpeg", "image/gif"]);
});
it("reports files over 5 MB instead of dropping them silently", () => {
  const r = selectReceiptFiles([pdf(5_000_001), pdf(1_000)]);
  expect(r.files).toHaveLength(1);
  expect(r.tooLarge).toHaveLength(1);
});
it("treats application/octet-stream with a .pdf name as a PDF", () => {
  const { files } = selectReceiptFiles([file("application/octet-stream", 2_000, "Invoice.PDF"), file("application/octet-stream", 2_000, "x.bin")]);
  expect(files).toHaveLength(1);
  expect(files[0].contentType).toBe("application/pdf");
});
it("parses the fixtures", async () => {
  const a = await parseEmail(raw(pdfAttached));
  expect(a.messageId).toBeTruthy();
  expect(a.from).toContain("billing@pixelgrove.example");
  expect(a.subject).toBe("Your receipt from Pixelgrove");
  expect(a.attachments).toHaveLength(2);
  expect(selectReceiptFiles(a.attachments).files).toHaveLength(1);
  expect(a.body).toContain("£14.00");
  expect(a.bodyIsHtml).toBe(false);

  const s = await parseEmail(raw(plainStub));
  expect(s.bodyIsHtml).toBe(true);
  expect(s.body).toContain("£14.00");

  const f = await parseEmail(raw(forwarded));
  expect(f.body).toContain("£14.00");
  expect(f.body).not.toContain("£12.00");
  expect(f.body).not.toContain("Studio 42");

  const p = selectReceiptFiles((await parseEmail(raw(photo))).attachments);
  expect(p.files.map((x) => x.contentType)).toEqual(["image/jpeg"]);

  const o = selectReceiptFiles((await parseEmail(raw(oversize))).attachments);
  expect(o.files).toHaveLength(1);
  expect(o.tooLarge).toHaveLength(1);
});
