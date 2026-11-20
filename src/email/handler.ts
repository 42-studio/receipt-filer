import { addEvent, addFile, createReceipt, findByMessageId, findDuplicateFile, updateReceipt } from "../db";
import { MAX_BODY_CHARS, type Env } from "../env";
import { notify, senderAddress, SUBJECT_PREFIX, type Notify } from "../notify";
import { parseEmail, selectReceiptFiles } from "./parse";

const GMAIL_CONFIRMATION = "forwarding-noreply@google.com";

export const isGmailForwardingConfirmation = (from: string) => from.toLowerCase() === GMAIL_CONFIRMATION;

// Gmail auto-forward rewrites the envelope sender to "local+caf_=...@domain"; strip the tag to compare.
export function isAllowedSender(envelopeFrom: string, allowed: string[]): boolean {
  const from = envelopeFrom.trim().toLowerCase();
  if (!from) return false; // null sender (bounces) must never match a blank entry
  const at = from.lastIndexOf("@");
  const tag = from.indexOf("+caf_=");
  const base = tag !== -1 && tag < at ? from.slice(0, tag) + from.slice(at) : from;
  return allowed.some((a) => a.trim() !== "" && a.trim().toLowerCase() === base);
}

// Our own notification, forwarded back (for example by a wide Gmail rule): storing it would send another notification.
export function isOwnNotification(from: string, subject: string, forwardAddress: string): boolean {
  const own = forwardAddress.trim().toLowerCase();
  const f = from.trim().toLowerCase();
  if (own && (f === own || f === senderAddress(own))) return true;
  return subject.replace(/^\s*(?:(?:fwd?|re)\s*:\s*)*/i, "").toLowerCase().startsWith(SUBJECT_PREFIX.toLowerCase());
}

// A new email so it is addressed to NOTIFY_TO: forward() keeps To: as the forwarding address.
async function sendConfirmation(message: ForwardableEmailMessage, env: Env): Promise<void> {
  try {
    const e = await parseEmail(await new Response(message.raw).arrayBuffer());
    const body = e.bodyIsHtml ? { html: e.body } : { text: e.body };
    await env.EMAIL.send({ to: env.NOTIFY_TO, from: senderAddress(env.FORWARD_ADDRESS), subject: `${SUBJECT_PREFIX} ${e.subject}`, ...body });
  } catch (err) {
    console.error("confirmation send failed, forwarding it instead", err); // the confirmation must not be lost
    await message.forward(env.NOTIFY_TO);
  }
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
  next?: (receiptId: string) => Promise<void>,
  notifyFn: Notify = notify,
): Promise<void> {
  if (isGmailForwardingConfirmation(message.from)) return sendConfirmation(message, env);
  if (!isAllowedSender(message.from, (env.ALLOWED_SENDERS ?? "").split(",").filter((a) => a.trim()))) {
    console.warn("rejected sender", message.from);
    return message.setReject("Sender not allowed");
  }

  let email;
  try {
    email = await parseEmail(await new Response(message.raw).arrayBuffer());
  } catch (e) {
    const r = await createReceipt(env.DB, { messageId: null, emailDate: null, sender: message.from, subject: null, body: null, bodyIsHtml: false, state: "could_not_read", reason: "unreadable_file" });
    await addEvent(env.DB, r.id, `Could not read the email: ${String(e)}`);
    return notifyFn(env, "could_not_read", r);
  }
  if (isOwnNotification(email.from, email.subject, env.FORWARD_ADDRESS ?? "")) return console.log("dropped one of our own notifications", email.subject);
  if (email.messageId && (await findByMessageId(env.DB, email.messageId))) return;

  const { files, tooLarge } = selectReceiptFiles(email.attachments);
  const base = {
    messageId: email.messageId, emailDate: email.date, sender: email.from, subject: email.subject,
    body: email.body.slice(0, MAX_BODY_CHARS), bodyIsHtml: email.bodyIsHtml,
  };
  const stop = async (reason: "no_attachment" | "file_too_large", why: string) => {
    const r = await createReceipt(env.DB, { ...base, state: "could_not_read", reason });
    await addEvent(env.DB, r.id, why);
    await notifyFn(env, "could_not_read", r);
  };
  if (files.length === 0) {
    return tooLarge.length
      ? stop("file_too_large", `Every receipt file was over the size limit: ${tooLarge.map((f) => f.filename).join(", ")}`)
      : stop("no_attachment", "Email had no receipt file");
  }

  const receipt = await createReceipt(env.DB, { ...base, state: "reading", reason: null });
  for (const f of tooLarge) await addEvent(env.DB, receipt.id, `Skipped ${f.filename}: over the size limit`);

  try {
    const hashed = await Promise.all(files.map(async (f) => ({ f, sha256: await sha256Hex(f.data) })));
    // Duplicate only when every file is already stored: a file repeated in every email from a supplier (terms, a banner) must not hide new receipts.
    const dups = await Promise.all(hashed.map(({ sha256 }) => findDuplicateFile(env.DB, sha256, receipt.id)));
    if (dups.every(Boolean)) {
      await updateReceipt(env.DB, receipt.id, { state: "duplicate", duplicateOf: dups[0]!.receiptId });
      return await addEvent(env.DB, receipt.id, `Duplicate of receipt ${dups[0]!.receiptId}`);
    }

    for (const { f, sha256 } of hashed) {
      const id = crypto.randomUUID();
      const r2Key = `receipts/${receipt.id}/${id}`;
      await env.FILES.put(r2Key, f.data, { httpMetadata: { contentType: f.contentType } });
      await addFile(env.DB, { id, receiptId: receipt.id, r2Key, filename: f.filename, contentType: f.contentType, size: f.data.byteLength, sha256 });
    }
    await addEvent(env.DB, receipt.id, `Received ${files.length} file(s)`);
  } catch (e) {
    await updateReceipt(env.DB, receipt.id, { state: "could_not_read", reason: "unreadable_file" });
    await addEvent(env.DB, receipt.id, `Could not store the files: ${String(e)}`);
    return notifyFn(env, "could_not_read", { ...receipt, state: "could_not_read", reason: "unreadable_file" });
  }
  if (next) ctx.waitUntil(next(receipt.id));
}
