import { addEvent, getReceipt, listFiles, updateReceipt } from "../db";
import { CLAIRIC_MAX_IMAGE_BYTES, IMAGE_MAX_SIDE, MAX_IMAGES, MIN_TEXT_CHARS, READ_GIVE_UP_HOURS, type Env } from "../env";
import { notify, shouldNotify, type Notify, type NotifyEnv } from "../notify";
import { chooseDate } from "./dates";
import { toCurrency } from "./currency";
import fields from "./fields.json";
import { embeddedJpegs } from "./pdf";

export interface Reading { totalMinor: number; confidence: number; date: string | null; supplier: string | null; currency: string; inputKind: "text" | "image"; }
export type ReadOutcome = { ok: true; reading: Reading } | { ok: false; reason: "no_total" | "zero_total" | "unreadable_file" } | { ok: false; retry: true; error: string };
type ReaderEnv = Pick<Env, "AI" | "IMAGES" | "FILES" | "DB" | "CLAIRIC_MODEL">;
type Email = { subject: string; body: string; bodyIsHtml: boolean; emailDate: string | null };
type InFile = { contentType: string; data: Uint8Array };
type Answer = { value: unknown; confidence?: number };

const TEXT_OPTIONS = { conversionOptions: { pdf: { metadata: false }, output: { format: "text" as const } } };
const KEEP = new Set(["image/jpeg", "image/png", "image/webp"]); // Clairic reads these; GIF is never a candidate
const CONVERT = new Set(["image/heic", "image/heif"]);

async function toText(env: ReaderEnv, name: string, data: Uint8Array | string, type: string): Promise<string> {
  const res = await env.AI.toMarkdown({ name, blob: new Blob([data as unknown as ArrayBuffer], { type }) }, TEXT_OPTIONS);
  return res.format === "error" ? "" : res.data; // an unconvertible PDF falls through to the image route
}

const stream = (d: Uint8Array) => new Response(d as BodyInit).body!;

function base64(d: Uint8Array): string {
  let s = "";
  for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000));
  return btoa(s);
}

async function prepareImage(env: ReaderEnv, contentType: string, data: Uint8Array): Promise<{ content_type: string; base64: string }> {
  const { width, height } = (await env.IMAGES.info(stream(data))) as { width?: number; height?: number };
  const tooBig = data.length > CLAIRIC_MAX_IMAGE_BYTES || Math.max(width ?? 0, height ?? 0) > IMAGE_MAX_SIDE;
  if (!CONVERT.has(contentType) && !tooBig) return { content_type: contentType, base64: base64(data) };
  const out = await env.IMAGES.input(stream(data))
    .transform({ width: IMAGE_MAX_SIDE, height: IMAGE_MAX_SIDE, fit: "scale-down" })
    .output({ format: "image/jpeg", quality: 85 });
  return { content_type: "image/jpeg", base64: base64(new Uint8Array(await new Response(out.image()).arrayBuffer())) };
}

export async function readInput(env: ReaderEnv, email: Email, files: InFile[]): Promise<ReadOutcome> {
  try {
    const bodyText = email.bodyIsHtml ? await toText(env, "body.html", email.body, "text/html") : email.body;
    const head = [email.subject, bodyText].filter(Boolean).join("\n\n");
    const pdfs = files.filter((f) => f.contentType === "application/pdf");
    const pdfTexts = await Promise.all(pdfs.map((p) => toText(env, "receipt.pdf", p.data, p.contentType)));

    let state = head;
    let images: { content_type: string; base64: string }[] = [];
    let inputKind: "text" | "image" = "text";
    if (pdfTexts.some((t) => t.replace(/\s/g, "").length >= MIN_TEXT_CHARS)) {
      state = [head, ...pdfTexts].filter(Boolean).join("\n\n");
    } else {
      inputKind = "image";
      const candidates = [
        ...files.filter((f) => KEEP.has(f.contentType) || CONVERT.has(f.contentType)),
        ...pdfs.flatMap((p) => embeddedJpegs(p.data).map((data) => ({ contentType: "image/jpeg", data }))),
      ].slice(0, MAX_IMAGES);
      if (!candidates.length) return { ok: false, reason: "unreadable_file" };
      images = await Promise.all(candidates.map((c) => prepareImage(env, c.contentType, c.data)));
    }

    const input: Record<string, unknown> = { model: "clairic", state, fields };
    if (images.length) input.images = images;
    const refDay = email.emailDate?.slice(0, 10) ?? ""; // postal-mime gives a full timestamp; Clairic was tested with a plain day
    if (/^\d{4}-\d{2}-\d{2}$/.test(refDay) && !Number.isNaN(Date.parse(refDay))) input.reference_date = refDay;
    const res = (await (env.AI as unknown as { run(m: string, i: unknown): Promise<unknown> }).run(env.CLAIRIC_MODEL, input)) as { answers: Record<string, Answer> };
    const a = res?.answers;
    if (!a) throw new Error("Clairic reply had no answers");

    const total = a.total?.value;
    if (typeof total !== "number") return { ok: false, reason: "no_total" };
    const totalMinor = Math.round(total * 100);
    if (totalMinor === 0) return { ok: false, reason: "zero_total" };
    const str = (k: string) => (typeof a[k]?.value === "string" ? (a[k].value as string) : null);
    return {
      ok: true,
      reading: {
        totalMinor,
        confidence: a.total.confidence ?? 0,
        date: chooseDate({ inputKind, typed: str("date"), written: str("date_text"), emailDate: email.emailDate }),
        supplier: inputKind === "image" ? null : str("supplier"),
        currency: toCurrency(str("currency")),
        inputKind,
      },
    };
  } catch (e) {
    console.error("read failed", e);
    return { ok: false, retry: true, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function readReceipt(env: ReaderEnv & NotifyEnv, receiptId: string, now: () => Date = () => new Date(), notifyFn: Notify = notify): Promise<void> {
  const r = await getReceipt(env.DB, receiptId);
  if (!r || r.state !== "reading") return;
  const files: InFile[] = [];
  for (const f of await listFiles(env.DB, receiptId)) {
    const obj = await env.FILES.get(f.r2Key);
    if (obj) files.push({ contentType: f.contentType, data: new Uint8Array(await obj.arrayBuffer()) });
  }
  const out = await readInput(env, { subject: r.subject ?? "", body: r.body ?? "", bodyIsHtml: r.bodyIsHtml, emailDate: r.emailDate }, files);
  if ("retry" in out) {
    if (now().getTime() - Date.parse(r.receivedAt) > READ_GIVE_UP_HOURS * 3_600_000) {
      await updateReceipt(env.DB, receiptId, { state: "could_not_read", reason: "unreadable_file" });
      await addEvent(env.DB, receiptId, `Gave up reading after ${READ_GIVE_UP_HOURS} hours: ${out.error}`);
      return notifyFn(env, "could_not_read", { ...r, state: "could_not_read", reason: "unreadable_file" });
    }
    const reason = `retrying: ${out.error}`;
    if (r.reason === reason) return;
    await updateReceipt(env.DB, receiptId, { reason });
    return addEvent(env.DB, receiptId, `Reading failed, will retry: ${out.error}`);
  }
  if (!out.ok) {
    await updateReceipt(env.DB, receiptId, { state: "could_not_read", reason: out.reason });
    await addEvent(env.DB, receiptId, `Could not read the receipt: ${out.reason}`);
    const updated = { ...r, state: "could_not_read" as const, reason: out.reason };
    return shouldNotify("could_not_read", updated) ? notifyFn(env, "could_not_read", updated) : undefined;
  }
  const { reading: x } = out;
  await updateReceipt(env.DB, receiptId, {
    state: "waiting_payment", reason: null, supplier: x.supplier, totalMinor: x.totalMinor, currency: x.currency,
    receiptDate: x.date, confidence: x.confidence, inputKind: x.inputKind,
  });
  await addEvent(env.DB, receiptId, `Read ${x.currency} ${(x.totalMinor / 100).toFixed(2)} (${x.inputKind}, confidence ${x.confidence.toFixed(2)})`);
}
