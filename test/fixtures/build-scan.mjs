// Builds scan.pdf (two JPEG pages, DCTDecode) and text.pdf (no image). Needs macOS sips. Run: node test/fixtures/build-scan.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "scan-"));

// 24-bit BMP with a diagonal gradient, converted to JPEG by sips.
function jpeg(w, h, shift) {
  const row = Math.ceil((w * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + row * h);
  buf.write("BM"); buf.writeUInt32LE(buf.length, 2); buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14); buf.writeInt32LE(w, 18); buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) buf.fill((x * 4 + y * 3 + shift) & 255, 54 + y * row + x * 3, 54 + y * row + x * 3 + 3);
  const bmp = join(tmp, `p${shift}.bmp`), out = join(tmp, `p${shift}.jpg`);
  writeFileSync(bmp, buf);
  execFileSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "40", bmp, "--out", out], { stdio: "ignore" });
  return readFileSync(out);
}

function jpegSize(b) {
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1], len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5), b[i + 9]];
    i += 2 + len;
  }
  throw new Error("no size found");
}

function pdf(objs) {
  let out = Buffer.from("%PDF-1.4\n");
  const offsets = {};
  for (const [num, body] of [...objs].sort((a, b) => a[0] - b[0])) {
    offsets[num] = out.length;
    out = Buffer.concat([out, Buffer.from(`${num} 0 obj\n`), body, Buffer.from("\nendobj\n")]);
  }
  const nums = Object.keys(offsets).map(Number).sort((a, b) => a - b);
  const xref = out.length;
  let tail = `xref\n0 ${nums.length + 1}\n0000000000 65535 f \n`;
  for (const n of nums) tail += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  tail += `trailer\n<< /Size ${nums.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.concat([out, Buffer.from(tail)]);
}

const stream = (dict, data) => Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, Buffer.from("\nendstream")]);

function scanPdf(jpegs) {
  const objs = [], kids = [];
  jpegs.forEach((jpg, n) => {
    const [w, h, comps] = jpegSize(jpg);
    const page = 3 + n * 3, img = 4 + n * 3, content = 5 + n * 3;
    kids.push(`${page} 0 R`);
    const cs = comps === 1 ? "/DeviceGray" : "/DeviceRGB";
    objs.push([page, Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${img} 0 R >> >> /Contents ${content} 0 R >>`)]);
    objs.push([img, stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode`, jpg)]);
    objs.push([content, stream("", Buffer.from(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`))]);
  });
  objs.push([1, Buffer.from("<< /Type /Catalog /Pages 2 0 R >>")]);
  objs.push([2, Buffer.from(`<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`)]);
  return pdf(objs);
}

writeFileSync(join(dir, "scan.pdf"), scanPdf([jpeg(64, 64, 0), jpeg(48, 48, 90)]));

const textStream = Buffer.from("BT /F1 12 Tf 20 100 Td (Receipt 8841 Total 14.00) Tj ET");
writeFileSync(join(dir, "text.pdf"), pdf([
  [1, Buffer.from("<< /Type /Catalog /Pages 2 0 R >>")],
  [2, Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>")],
  [3, Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>")],
  [4, Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")],
  [5, stream("", textStream)],
]));
