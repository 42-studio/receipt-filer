import PostalMime from "postal-mime";
import { MAX_FILE_BYTES, MIN_IMAGE_BYTES, SHORT_PLAIN_TEXT_CHARS } from "../env";

export interface Attachment { filename: string; contentType: string; data: Uint8Array }
export interface ParsedEmail {
  messageId: string | null;
  date: string | null;
  from: string;
  subject: string;
  body: string;
  bodyIsHtml: boolean;
  attachments: Attachment[];
}

const EXT_TYPES: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", heic: "image/heic",
};
const ACCEPTED = new Set(Object.values(EXT_TYPES));

export function chooseBody(plain: string | null, html: string | null): { kind: "plain" | "html"; content: string } {
  const p = plain?.trim() ?? "";
  if (html && p.length < SHORT_PLAIN_TEXT_CHARS) return { kind: "html", content: html };
  return { kind: "plain", content: plain ?? "" };
}

const FORWARD_MARKER = /^-{2,}\s*Forwarded message\s*-{2,}$/i;
const REPLY_HEADER = /^(On .+wrote:|-{2,}\s*Original Message\s*-{2,})$/i;

export function stripQuoted(text: string): string {
  const out: string[] = [];
  let inSignature = false;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (FORWARD_MARKER.test(t)) inSignature = false; // forwarded content is the receipt
    else if (REPLY_HEADER.test(t)) break; // shortcut: wrapped "On ...\n wrote:" headers are not detected
    else if (t === "--") inSignature = true;
    if (inSignature || t.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

export async function parseEmail(raw: ArrayBuffer): Promise<ParsedEmail> {
  const m = await PostalMime.parse(raw);
  const chosen = chooseBody(m.text ?? null, m.html ?? null);
  return {
    messageId: m.messageId ?? null,
    date: m.date ?? null,
    from: m.from?.address ? m.from.address : m.from?.name ?? "",
    subject: m.subject ?? "",
    body: chosen.kind === "plain" ? stripQuoted(chosen.content) : chosen.content,
    bodyIsHtml: chosen.kind === "html",
    attachments: m.attachments.map((a) => ({
      filename: a.filename ?? "",
      contentType: a.mimeType,
      data: new Uint8Array(a.content as ArrayBuffer),
    })),
  };
}

// Normalises octet-stream attachments by extension; returns null when the type is not accepted.
function receiptType(a: Attachment): string | null {
  const type = a.contentType.toLowerCase();
  if (ACCEPTED.has(type)) return type;
  if (type !== "application/octet-stream") return null;
  return EXT_TYPES[a.filename.split(".").pop()?.toLowerCase() ?? ""] ?? null;
}

export function selectReceiptFiles(a: Attachment[]): { files: Attachment[]; tooLarge: Attachment[] } {
  const files: Attachment[] = [];
  const tooLarge: Attachment[] = [];
  for (const att of a) {
    const type = receiptType(att);
    if (!type) continue;
    if (type !== "application/pdf" && att.data.byteLength < MIN_IMAGE_BYTES) continue; // logos and tracking pixels
    (att.data.byteLength > MAX_FILE_BYTES ? tooLarge : files).push({ ...att, contentType: type });
  }
  return { files, tooLarge };
}
