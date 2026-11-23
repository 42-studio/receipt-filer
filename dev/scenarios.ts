// Named data states for the UI playground: each is the full set of receipts to seed. Test data only.
import type { Receipt } from "../src/db";
import { receiptPdf, type ReceiptDoc } from "./receipt-pdf";

export const BASE = "https://api.sandbox.freeagent.com/v2";
// Functions, not constants: Date.now() is frozen at 0 while a Worker module loads.
export const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const at = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
export const printed = (days: number) => new Date(Date.now() - days * 86_400_000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export type Seed = Partial<Receipt> & {
  subject: string; sender: string; days: number;
  doc?: ReceiptDoc & { file: string }; // a generated PDF
  files?: [string, string, Uint8Array][]; // or raw files: name, content type, bytes
  noFile?: boolean; // or nothing at all
  events?: string[]; pinTo?: number; // pinTo: a bank line from the fake FreeAgent, by number
  dupOf?: number; // index of the seed this one duplicates
};

/** The seed's files: its own, or a plain receipt built from its supplier and total; none for an email with no attachment. */
export function filesOf(s: Seed): [string, string, Uint8Array][] {
  if (s.files) return s.files;
  if (s.noFile) return [];
  if (s.doc) return [[s.doc.file, "application/pdf", receiptPdf(s.doc)]];
  if (!s.supplier || s.totalMinor == null || !s.currency) return [];
  const slug = s.supplier.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return [[`${slug}-receipt.pdf`, "application/pdf", receiptPdf({ supplier: s.supplier, address: ["Online order"], kind: "Receipt", number: `R-${s.totalMinor}-${s.days}`, date: printed(s.days), currency: s.currency === "USD" ? "USD" : "GBP", items: [[s.subject, s.totalMinor]] })]];
}

// An HTML receipt with no attachment, as Uber sends them. The remote logo stays blank: the body may not load anything.
const UBER_EMAIL = `<div style="font-family:Helvetica,Arial,sans-serif;max-width:480px;margin:24px auto;color:#111">
<img src="https://uber.example/logo.png" alt="Uber" width="80"><h1 style="font-size:28px;margin:16px 0 4px">Thanks for riding, Josh</h1>
<p style="color:#555;margin:0 0 20px">Tuesday evening trip · Shoreditch to Islington</p>
<table style="width:100%;border-collapse:collapse;font-size:15px">
<tr><td style="padding:6px 0">Trip fare</td><td style="text-align:right">£17.60</td></tr>
<tr><td style="padding:6px 0">Booking fee</td><td style="text-align:right">£2.25</td></tr>
<tr><td style="padding:6px 0">Tip</td><td style="text-align:right">£2.00</td></tr>
<tr style="border-top:2px solid #111;font-weight:bold;font-size:20px"><td style="padding:10px 0">Total</td><td style="text-align:right">£21.85</td></tr></table>
<p style="color:#555;font-size:13px">Paid with Visa ••••4242</p><script>document.body.innerHTML = "script ran"</script></div>`;

const ATTACH_FAILED = "FreeAgent did not confirm the attachment. Check the transaction in FreeAgent before you press Retry.";
const REASONS_FAILED = [
  ATTACH_FAILED,
  "FreeAgent refused the attachment: 422 Unprocessable Entity (attachment content type not allowed)",
  "The bank line was explained twice in FreeAgent, so the matcher could not choose an explanation.",
  "FreeAgent could not be reached for 24 hours.",
];

/** Builds seeds for one scenario. Each filed or matched receipt pins its own made-up bank line (they must be unique). */
function kit() {
  let line = 500;
  return (state: Receipt["state"], supplier: string, totalMinor: number, days: number, o: Partial<Seed> = {}): Seed => {
    const currency = o.currency ?? "GBP";
    const subject = o.subject ?? `${supplier} receipt`;
    const doc: Seed["doc"] = { file: `${supplier.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.pdf`, supplier, address: ["Online order"], kind: "Receipt", number: `R-${line}`, date: printed(days), currency: currency === "USD" ? "USD" : "GBP", items: [[subject, totalMinor]] };
    const unread = state === "reading" || state === "could_not_read";
    const pinned = state === "filed" || state === "waiting_explanation" ? { pinnedLine: `${BASE}/bank_transactions/${line++}`, pinnedBy: "auto" as const } : {};
    return {
      subject, sender: `billing@${supplier.toLowerCase().split(/[^a-z]+/)[0] || "shop"}.example`, days, state, doc, events: ["Received"],
      ...(unread ? {} : { supplier, totalMinor, currency, receiptDate: ago(days), confidence: 0.92, inputKind: "text" as const }),
      ...(state === "filed" ? { filedAt: at(Math.max(days - 1, 0)) } : {}),
      ...pinned,
      ...o,
    };
  };
}

const HISTORY: [string, number][] = [["Figma", 1200], ["Pret A Manger", 645], ["Uber", 1840], ["Trainline", 3000], ["Adobe", 1998], ["Notion Labs", 1500], ["GitHub", 400], ["Zoom", 1439], ["Amazon", 2599], ["Tesco", 1250]];
/** Filed receipts, a few a week from `from` days ago back; one in four was matched by hand. */
function history(n: number, from = 16, start = 300): Seed[] {
  return Array.from({ length: n }, (_, i) => {
    const [supplier, totalMinor] = HISTORY[i % HISTORY.length];
    const days = from + Math.round(i * 2.1 + (i % 3));
    return { subject: `${supplier} receipt`, sender: `billing@${supplier.toLowerCase().split(" ")[0]}.example`, days, state: "filed", supplier, totalMinor, currency: "GBP", receiptDate: ago(days), confidence: 0.93, inputKind: "text",
      filedAt: at(days - 1), pinnedLine: `${BASE}/bank_transactions/${start + i}`, pinnedBy: i % 4 === 0 ? "manual" : "auto", events: ["Received", "Filed in FreeAgent"] };
  });
}

const everyday = (): Seed[] => [
  { doc: { file: "acme-invoice-1234.pdf", supplier: "Acme Ltd", address: ["14 Cable Street", "London E1 8JG", "VAT GB 123 4567 89"], kind: "Tax invoice", number: "INV-1234", date: printed(1), currency: "GBP", items: [["Brass desk lamp", 2000]], vatRate: 0.2, footer: ["Paid by card ending 4242. Thank you for your order."] }, subject: "Your Acme order #1234", sender: "orders@acme.example", days: 1, state: "needs_choice", supplier: "Acme", totalMinor: 2400, currency: "GBP", receiptDate: ago(1), confidence: 0.94, inputKind: "text", events: ["Received", "Read GBP 24.00 from Acme", "Two bank lines fit: needs your choice"] },
  { doc: { file: "pret-receipt.pdf", supplier: "Pret A Manger", address: ["Shop 0231, Old Street", "London EC1V 9NR"], kind: "Receipt", number: "0231-58817", date: printed(2), currency: "GBP", items: [["Flat white", 325], ["Almond croissant", 320]], footer: ["Contactless Visa", "Thanks for visiting Pret"] }, subject: "Pret receipt", sender: "receipts@pret.example", days: 2, state: "waiting_payment", supplier: "Pret A Manger", totalMinor: 645, currency: "GBP", receiptDate: ago(2), confidence: 0.88, inputKind: "image", events: ["Received", "Read GBP 6.45 from Pret A Manger"] },
  { doc: { file: "stripe-receipt.pdf", supplier: "Stripe", address: ["510 Townsend Street", "San Francisco, CA 94103"], kind: "Receipt", number: "1832-4410", date: printed(3), currency: "USD", items: [["Atlas Pro plan, monthly", 9900]], footer: ["Charged to Visa ending 4242."] }, subject: "Your Stripe receipt", sender: "receipts@stripe.example", days: 3, state: "failed", reason: ATTACH_FAILED, supplier: "Stripe", totalMinor: 9900, currency: "USD", receiptDate: ago(3), confidence: 0.97, inputKind: "text", events: ["Received", "Read USD 99.00 from Stripe", "Matched to bank line 3", "Attach failed: no confirmation"] },
  { doc: { file: "notion-invoice.pdf", supplier: "Notion Labs, Inc.", address: ["2300 Harrison Street", "San Francisco, CA 94110"], kind: "Invoice", number: "NTN-88213", date: printed(9), currency: "GBP", items: [["Plus plan, 1 member, Nov 2026", 1250]], vatRate: 0.2, totalLabel: "Amount due", footer: ["Paid in full by card. Questions? team@makenotion.example"] }, subject: "Invoice from Notion", sender: "billing@notion.example", days: 9, state: "could_not_read", reason: "no_total", events: ["Received", "Could not read: no total found"] },
  { subject: "GitHub payment receipt", sender: "billing@github.example", days: 14, state: "filed", supplier: "GitHub", totalMinor: 400, currency: "USD", receiptDate: ago(14), confidence: 0.99, inputKind: "text", filedAt: at(13), pinnedLine: `${BASE}/bank_transactions/100`, pinnedBy: "auto", events: ["Received", "Read USD 4.00 from GitHub", "Filed in FreeAgent"] },
  { doc: { file: "other-shop-order.pdf", supplier: "Other Shop", address: ["Unit 4, Hackney Wick", "London E9 5LN"], kind: "Receipt", number: "OS-20417", date: printed(4), currency: "GBP", items: [["Phone case, clear", 999]] }, subject: "Order confirmation", sender: "shop@other.example", days: 4, state: "waiting_explanation", supplier: "Other Shop", totalMinor: 999, currency: "GBP", receiptDate: ago(4), confidence: 0.81, inputKind: "text", pinTo: 4, events: ["Received", "Matched to bank line 4", "Waiting for an explanation in FreeAgent"] },
  { doc: { file: "acme-invoice-1234.pdf", supplier: "Acme Ltd", address: ["14 Cable Street", "London E1 8JG", "VAT GB 123 4567 89"], kind: "Tax invoice", number: "INV-1234", date: printed(1), currency: "GBP", items: [["Brass desk lamp", 2000]], vatRate: 0.2, footer: ["Paid by card ending 4242. Thank you for your order."] }, subject: "Fwd: Your Acme order #1234", sender: "orders@acme.example", days: 0, state: "duplicate", supplier: "Acme", totalMinor: 2400, currency: "GBP", dupOf: 0, events: ["Received", "Same file as an earlier receipt"] },
  { doc: { file: "eticket.pdf", supplier: "Trainline", address: ["Off-peak day return", "London Victoria to Brighton"], kind: "Receipt", number: "TL-7Q2K9", date: printed(0), currency: "GBP", items: [["Off-peak day return, 1 adult", 1250]] }, subject: "Trainline e-ticket", sender: "auto@trainline.example", days: 0, state: "reading", events: ["Received"] },
  { doc: { file: "deliveroo-receipt.pdf", supplier: "Deliveroo", address: ["Order from Dishoom, Shoreditch"], kind: "Receipt", number: "DR-55102", date: printed(0), currency: "GBP", items: [["House black daal", 895], ["Chicken ruby", 1290], ["Delivery fee", 199], ["Service fee", 99]], footer: ["Paid with Apple Pay"] }, subject: "Your Deliveroo order from Dishoom", sender: "receipts@deliveroo.example", days: 0, state: "reading", events: ["Received"] },
  { doc: { file: "apple-invoice.pdf", supplier: "Apple Distribution International", address: ["Hollyhill Industrial Estate", "Cork, Ireland"], kind: "Invoice", number: "MT5XK2L9Q", date: printed(0), currency: "GBP", items: [["iCloud+ 200 GB, monthly", 299]], footer: ["Billed to Visa ending 4242"] }, subject: "Your receipt from Apple", sender: "no_reply@email.apple.example", days: 0, state: "reading", events: ["Received"] },
  { subject: "Your Tuesday evening trip with Uber", sender: "noreply@uber.example", days: 5, state: "could_not_read", reason: "no_attachment", body: UBER_EMAIL, bodyIsHtml: true, events: ["Received", "Could not read: no receipt file"] },
  { subject: "Your Figma invoice", sender: "billing@figma.example", days: 4, state: "filed", supplier: "Figma", totalMinor: 1200, currency: "GBP", receiptDate: ago(4), confidence: 0.95, inputKind: "text", filedAt: at(3), pinnedLine: `${BASE}/bank_transactions/101`, pinnedBy: "auto", events: ["Received", "Filed in FreeAgent"] },
  { subject: "Adobe receipt", sender: "billing@adobe.example", days: 7, state: "filed", supplier: "Adobe", totalMinor: 1998, currency: "GBP", receiptDate: ago(7), confidence: 0.95, inputKind: "text", filedAt: at(6), pinnedLine: `${BASE}/bank_transactions/102`, pinnedBy: "auto", events: ["Received", "Filed in FreeAgent"] },
  { subject: "Uber receipt", sender: "billing@uber.example", days: 10, state: "filed", supplier: "Uber", totalMinor: 1840, currency: "GBP", receiptDate: ago(10), confidence: 0.95, inputKind: "text", filedAt: at(9), pinnedLine: `${BASE}/bank_transactions/103`, pinnedBy: "manual", events: ["Received", "Filed in FreeAgent"] },
  { subject: "AWS invoice", sender: "billing@amazon.example", days: 13, state: "filed", supplier: "Amazon Web Services", totalMinor: 2311, currency: "USD", receiptDate: ago(13), confidence: 0.95, inputKind: "text", filedAt: at(12), pinnedLine: `${BASE}/bank_transactions/104`, pinnedBy: "auto", events: ["Received", "Filed in FreeAgent"] },
  { subject: "Zoom receipt", sender: "billing@zoom.example", days: 31, state: "filed", supplier: "Zoom", totalMinor: 1439, currency: "GBP", receiptDate: ago(31), confidence: 0.95, inputKind: "text", filedAt: at(30), pinnedLine: `${BASE}/bank_transactions/105`, pinnedBy: "auto", events: ["Received", "Filed in FreeAgent"] },
  { subject: "Railcard", sender: "billing@trainline.example", days: 37, state: "filed", supplier: "Trainline", totalMinor: 3000, currency: "GBP", receiptDate: ago(37), confidence: 0.95, inputKind: "text", filedAt: at(36), pinnedLine: `${BASE}/bank_transactions/106`, pinnedBy: "manual", events: ["Received", "Filed in FreeAgent"] },
  ...history(26),
];

export interface Scenario { id: string; label: string; description: string; build: () => Seed[] }

export const SCENARIOS: Scenario[] = [
  { id: "everyday", label: "Everyday mix", description: "A bit of everything: the default test data.", build: everyday },
  { id: "empty", label: "Empty", description: "First run: no receipts at all.", build: () => [] },
  {
    id: "caught-up", label: "All caught up", description: "Nothing needs you: two waiting, ten weeks filed.",
    build: () => { const r = kit(); return [r("waiting_payment", "Pret A Manger", 645, 1), r("waiting_explanation", "Other Shop", 999, 3), ...history(30, 2)]; },
  },
  {
    id: "one-failed", label: "One failure, nothing else", description: "A single failed receipt: no queue behind it, no history.",
    build: () => { const r = kit(); return [r("failed", "Stripe", 9900, 2, { currency: "USD", reason: ATTACH_FAILED })]; },
  },
  {
    id: "pile-up", label: "Pile-up after a holiday", description: "13 need you, 6 reading, 4 waiting: long progress strip, busy side column.",
    build: () => {
      const r = kit();
      const reads = ["no_total", "no_attachment", "unreadable_file", "zero_total", "file_too_large"];
      return [
        ...["Stripe", "Vercel", "Linear", "Slack"].map((s, i) => r("failed", s, 1500 + i * 700, 3 + i, { reason: REASONS_FAILED[i] })),
        ...["Notion Labs", "Uber", "Boots", "Waitrose", "Ryanair"].map((s, i) => r("could_not_read", s, 2000 + i * 333, 2 + i, { reason: reads[i], ...(reads[i] === "no_attachment" ? { noFile: true } : {}) })),
        ...["Acme", "Amazon", "Tesco", "Shell"].map((s, i) => r("needs_choice", s, 2400 + i * 100, 1 + i)),
        ...["Apple", "Deliveroo", "Trainline", "Costa", "Zoom", "Figma"].map((s, i) => r("reading", s, 500 + i * 100, 0)),
        r("waiting_payment", "Pret A Manger", 645, 1), r("waiting_payment", "Lime", 350, 1), r("waiting_payment", "Costa Coffee", 385, 2), r("waiting_explanation", "Other Shop", 999, 4),
        ...history(20),
      ];
    },
  },
  {
    id: "reading-burst", label: "Reading burst", description: "Seven emails just arrived and nothing else exists yet.",
    build: () => { const r = kit(); return ["Apple", "Deliveroo", "Trainline", "Costa Coffee", "Zoom", "Figma", "Uber Eats"].map((s, i) => r("reading", s, 400 + i * 150, 0)); },
  },
  {
    id: "long-text", label: "Long names, huge amounts", description: "Very long supplier names, subjects and errors; seven- and eight-figure totals.",
    build: () => {
      const r = kit();
      const long = "Société Générale de Transports Urbains et Interurbains de la Région Parisienne (London Branch) Ltd";
      return [
        r("failed", long, 1234567890, 2, { subject: `Fwd: Fwd: RE: Your invoice INV-2026-00004521 from ${long} is now available to download`, reason: "FreeAgent refused the attachment: 422 Unprocessable Entity {\"errors\":{\"error\":{\"message\":\"Attachment file name is too long or contains characters FreeAgent does not accept in a file name\"}}}" }),
        r("needs_choice", "Hyper-Extremely-Long-Supplier-Name-With-No-Spaces-At-All-Industries-International", 99999999, 3),
        r("could_not_read", "Amazon Marketplace EU S.à r.l.", 4500, 4, { subject: "Your Amazon.co.uk order of \"Anker 737 Power Bank (PowerCore 24K) 140W 24,000mAh Portable Charger…\" has been dispatched", reason: "no_total" }),
        r("waiting_payment", "Pret", 1, 1),
        r("waiting_explanation", "Wise Payments Ltd on behalf of Hetzner Online GmbH", 1000000, 5),
        ...history(8),
      ];
    },
  },
  {
    id: "missing-files", label: "Missing or odd files", description: "No file and no text, a file too large, a HEIC photo and an HTML file the browser must not open.",
    build: () => {
      const r = kit();
      const heic = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99]); // just the HEIC header: no preview either way
      const html = new TextEncoder().encode("<h1>Receipt</h1><script>alert(1)</script>");
      return [
        r("could_not_read", "Unknown sender", 0, 1, { subject: "(no subject)", reason: "no_attachment", noFile: true, body: null, sender: "someone@example.com" }),
        r("could_not_read", "Scanner", 0, 2, { subject: "Scan from the office copier", reason: "file_too_large", noFile: true }),
        r("failed", "Boots", 1299, 3, { reason: ATTACH_FAILED, files: [["IMG_2041.HEIC", "image/heic", heic]] }),
        r("could_not_read", "Shady shop", 0, 4, { subject: "Your receipt (open the attachment)", reason: "unreadable_file", files: [["receipt.html", "text/html", html]] }),
        r("needs_choice", "Acme", 2400, 1),
      ];
    },
  },
  {
    id: "history-only", label: "History only", description: "Ten weeks of filed receipts, all automatic, nothing in flight.",
    build: () => history(30, 1).map((s) => ({ ...s, pinnedBy: "auto" })),
  },
  {
    id: "new-month", label: "Nothing filed this month", description: "Plenty last month, none yet this month; one receipt needs a choice.",
    build: () => { const r = kit(); const dom = new Date().getUTCDate(); return [r("needs_choice", "Acme", 2400, 0), ...history(14, dom + 1)]; },
  },
  {
    id: "duplicates", label: "Lots of duplicates", description: "A Gmail filter forwarded everything twice: five duplicates.",
    build: () => {
      const r = kit();
      const originals = ["Figma", "Adobe", "Zoom", "GitHub", "Notion Labs"].map((s, i) => r("filed", s, 1000 + i * 250, 3 + i));
      return [...originals, ...originals.map((o, i) => ({ ...o, subject: `Fwd: ${o.subject}`, state: "duplicate" as const, pinnedLine: null, pinnedBy: null, filedAt: null, days: o.days - 1, dupOf: i, events: ["Received", "Same file as an earlier receipt"] }))];
    },
  },
  {
    id: "foreign", label: "Foreign currencies", description: "Euros, dollars and francs: each needs a by-hand match against pound lines.",
    build: () => {
      const r = kit();
      return [
        r("needs_choice", "Hetzner Online GmbH", 4165, 2, { currency: "EUR" }),
        r("failed", "DigitalOcean", 2400, 3, { currency: "USD", reason: ATTACH_FAILED }),
        r("waiting_payment", "Swiss Federal Railways", 8800, 4, { currency: "CHF" }),
        r("filed", "OpenAI", 2000, 6, { currency: "USD" }), r("filed", "Booking.com", 31250, 9, { currency: "EUR" }),
        ...history(10),
      ];
    },
  },
];
