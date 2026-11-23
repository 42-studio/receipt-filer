// Builds a small, real-looking receipt or invoice PDF for the dev playground. Test data only.
// One A5 page, Helvetica in WinAnsi encoding (so "£" is one byte), built by hand: no dependency.

export interface ReceiptDoc {
  supplier: string;
  address: string[];
  kind: "Receipt" | "Invoice" | "Tax invoice";
  number: string;
  date: string; // as printed, e.g. "13 Nov 2026"
  currency: "GBP" | "USD";
  items: [string, number][]; // description, minor units
  vatRate?: number; // e.g. 0.2: the VAT line is worked out from the items
  totalLabel?: string; // "Total" unless a supplier prints something else
  footer?: string[];
}

const W = 420, H = 595, L = 36, R = W - 36;
// Helvetica advance widths (1/1000 em) for the characters an amount uses; others count as 556.
const ADV: Record<string, number> = { ".": 278, ",": 278, " ": 278, "-": 333, "(": 333, ")": 333, "%": 889, "$": 556, "£": 556 };
const width = (s: string, size: number) => [...s].reduce((w, c) => w + (ADV[c] ?? 556), 0) * size / 1000;
const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);

export function receiptPdf(d: ReceiptDoc): Uint8Array {
  const sym = d.currency === "GBP" ? "£" : "$";
  const money = (m: number) => `${sym}${(m / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
  const ops: string[] = [];
  const text = (s: string, x: number, y: number, size = 9, bold = false, grey = false) =>
    ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${grey ? "0.42 0.45 0.5" : "0.07 0.08 0.1"} rg ${x.toFixed(1)} ${y.toFixed(1)} Td (${esc(s)}) Tj ET`);
  const right = (s: string, y: number, size = 9, bold = false) => text(s, R - width(s, size), y, size, bold);
  const rule = (y: number, h = 0.6) => ops.push(`0.82 0.84 0.87 rg ${L} ${y} ${R - L} ${h} re f`);

  ops.push(`0.12 0.16 0.24 rg ${L} ${H - 48} 6 22 re f`); // a small brand mark beside the name
  text(d.supplier, L + 14, H - 44, 17, true);
  d.address.forEach((a, i) => text(a, L + 14, H - 60 - i * 11, 8, false, true));
  right(d.kind.toUpperCase(), H - 44, 11, true);

  let y = H - 60 - d.address.length * 11 - 24;
  text(`${d.kind} number`, L, y, 8, false, true); text(d.number, L + 90, y, 9);
  text("Date", L, y - 13, 8, false, true); text(d.date, L + 90, y - 13, 9);
  y -= 40;

  text("Description", L, y, 8, true); right("Amount", y, 8, true);
  rule(y - 6);
  y -= 22;
  const net = d.items.reduce((t, [, m]) => t + m, 0);
  for (const [desc, m] of d.items) { text(desc, L, y, 9); right(money(m), y); y -= 16; }
  const vat = d.vatRate ? Math.round(net * d.vatRate) : 0;
  rule(y + 6);
  y -= 8;
  if (vat) {
    text("Subtotal", L + 180, y, 9, false, true); right(money(net), y); y -= 15;
    text(`VAT ${Math.round(d.vatRate! * 100)}%`, L + 180, y, 9, false, true); right(money(vat), y); y -= 15;
  }
  rule(y + 4, 1.2);
  y -= 14;
  text(d.totalLabel ?? "Total", L + 180, y, 12, true); right(money(net + vat), y, 12, true);
  y -= 34;
  (d.footer ?? []).forEach((f, i) => text(f, L, y - i * 11, 8, false, true));

  const stream = ops.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((o, i) => { const at = pdf.length; pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(pdf, (c) => c.charCodeAt(0)); // every character is Latin-1, as WinAnsi needs
}
