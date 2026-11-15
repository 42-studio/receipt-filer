// Builds synthetic .eml fixtures. Run: node test/fixtures/build.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const b64 = (buf) => buf.toString("base64").replace(/.{1,76}/g, "$&\r\n");
const head = (subject, extra = "") =>
  `From: Pixelgrove <billing@pixelgrove.example>\r\nTo: receipts@studio42.example\r\nSubject: ${subject}\r\nDate: Thu, 12 Nov 2026 09:14:00 +0000\r\nMessage-ID: <${subject.replace(/\W+/g, "-")}@pixelgrove.example>\r\nMIME-Version: 1.0\r\n${extra}`;
const pdfBytes = (n) => Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(n - 9, 0x20)]);
const filler = (n, magic) => Buffer.concat([Buffer.from(magic), Buffer.alloc(n - magic.length, 7)]);
const png = (n) => filler(n, [0x89, 0x50, 0x4e, 0x47]);
const jpeg = (n) => filler(n, [0xff, 0xd8, 0xff, 0xe0]);
const B = "BOUNDARY42";
const text = (t) => `--${B}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${t}\r\n`;
const html = (h) => `--${B}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${h}\r\n`;
const att = (type, name, buf, disp = "attachment", cid = "") =>
  `--${B}\r\nContent-Type: ${type}; name="${name}"\r\nContent-Disposition: ${disp}; filename="${name}"\r\n${cid}Content-Transfer-Encoding: base64\r\n\r\n${b64(buf)}`;
const mixed = (subject, ...parts) =>
  head(subject, `Content-Type: multipart/mixed; boundary="${B}"\r\n`) + `\r\n${parts.join("")}--${B}--\r\n`;
const write = (name, s) => writeFileSync(join(dir, name), s);

write("pdf-attached.eml", mixed("Your receipt from Pixelgrove",
  text("Receipt #8841\nTotal paid: £14.00\n"),
  att("application/pdf", "receipt-8841.pdf", pdfBytes(1_000)),
  att("image/png", "logo.png", png(3_000), "inline", "Content-ID: <logo>\r\n")));

write("plain-stub.eml", head("Your receipt from Pixelgrove", `Content-Type: multipart/alternative; boundary="${B}"\r\n`) +
  `\r\n${text("Your email client does not support HTML")}${html("<p>Receipt #8841</p><p>Total paid: £14.00</p>")}--${B}--\r\n`);

write("forwarded.eml", head("Fwd: Your receipt from Pixelgrove", "Content-Type: text/plain; charset=utf-8\r\n") +
  `\r\n${[
    "---------- Forwarded message ---------",
    "From: Pixelgrove <billing@pixelgrove.example>",
    "Date: Thu, 12 Nov 2026 at 09:14",
    "Subject: Your receipt from Pixelgrove",
    "",
    "Receipt #8841",
    "Design plan, November 2026",
    "Total paid: £14.00",
    "",
    "--",
    "Josh Pollard",
    "Studio 42",
    "",
    "On Mon, 12 Oct 2026 Pixelgrove wrote:",
    "> Receipt #8102",
    "> Design plan, October 2026",
    "> Total paid: £12.00",
  ].join("\r\n")}\r\n`);

write("photo.eml", mixed("Photo receipt", text("Photo attached."), att("image/jpeg", "IMG_0001.jpg", jpeg(300_000))));
write("oversize.eml", mixed("Big receipt", text("Two PDFs."),
  att("application/pdf", "big.pdf", pdfBytes(5_000_001)), att("application/pdf", "small.pdf", pdfBytes(1_000))));
