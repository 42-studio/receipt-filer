export type State = "reading" | "could_not_read" | "duplicate" | "waiting_payment" | "needs_choice" | "waiting_explanation" | "filed" | "failed";
export type Reason = "no_attachment" | "file_too_large" | "unreadable_file" | "no_total" | "zero_total" | (string & {}); // string: a FreeAgent error for "failed"
export interface Receipt {
  id: string; messageId: string | null; receivedAt: string; emailDate: string | null; sender: string | null; subject: string | null; body: string | null; bodyIsHtml: boolean;
  state: State; reason: Reason | null; supplier: string | null; totalMinor: number | null; currency: string | null; receiptDate: string | null;
  confidence: number | null; inputKind: "text" | "image" | null; pinnedLine: string | null; pinnedBy: "auto" | "manual" | null;
  explanationUrl: string | null; attachmentUrls: string[] | null; duplicateOf: string | null; notified: string[]; filedAt: string | null; updatedAt: string;
}
export interface StoredFile { id: string; receiptId: string; r2Key: string; filename: string; contentType: string; size: number; sha256: string }

type Row = Record<string, unknown>;

// Receipt field -> column. JSON/boolean columns are converted in toColumn/fromRow.
const COLS: Record<keyof Receipt, string> = {
  id: "id", messageId: "message_id", receivedAt: "received_at", emailDate: "email_date", sender: "sender", subject: "subject", body: "body",
  bodyIsHtml: "body_is_html", state: "state", reason: "reason", supplier: "supplier", totalMinor: "total_minor", currency: "currency",
  receiptDate: "receipt_date", confidence: "confidence", inputKind: "input_kind", pinnedLine: "pinned_line", pinnedBy: "pinned_by",
  explanationUrl: "explanation_url", attachmentUrls: "attachment_urls", duplicateOf: "duplicate_of", notified: "notified", filedAt: "filed_at", updatedAt: "updated_at",
};

function toColumn(key: keyof Receipt, v: unknown): unknown {
  if (v === undefined) return null;
  if (key === "bodyIsHtml") return v ? 1 : 0;
  if (key === "attachmentUrls" || key === "notified") return v === null ? null : JSON.stringify(v);
  return v;
}

function fromRow(r: Row): Receipt {
  const o: Row = {};
  for (const [k, c] of Object.entries(COLS)) o[k] = r[c] ?? null;
  o.bodyIsHtml = r.body_is_html === 1;
  o.attachmentUrls = r.attachment_urls == null ? null : JSON.parse(r.attachment_urls as string);
  o.notified = JSON.parse((r.notified as string) ?? "[]");
  return o as unknown as Receipt;
}

const fileFromRow = (r: Row): StoredFile => ({
  id: r.id as string, receiptId: r.receipt_id as string, r2Key: r.r2_key as string, filename: r.filename as string,
  contentType: r.content_type as string, size: r.size as number, sha256: r.sha256 as string,
});

const now = () => new Date().toISOString();
const OPEN_STATES = ["waiting_payment", "needs_choice", "waiting_explanation", "failed", "reading"];

export async function createReceipt(
  db: D1Database,
  r: Pick<Receipt, "messageId" | "emailDate" | "sender" | "subject" | "body" | "bodyIsHtml" | "state" | "reason">,
): Promise<Receipt> {
  const id = crypto.randomUUID(), t = now();
  await db
    .prepare("INSERT INTO receipts (id, message_id, received_at, email_date, sender, subject, body, body_is_html, state, reason, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, r.messageId, t, r.emailDate, r.sender, r.subject, r.body, r.bodyIsHtml ? 1 : 0, r.state, r.reason, t)
    .run();
  return (await getReceipt(db, id))!;
}

export async function getReceipt(db: D1Database, id: string): Promise<Receipt | null> {
  const r = await db.prepare("SELECT * FROM receipts WHERE id = ?").bind(id).first<Row>();
  return r ? fromRow(r) : null;
}

export async function findByMessageId(db: D1Database, messageId: string): Promise<Receipt | null> {
  const r = await db.prepare("SELECT * FROM receipts WHERE message_id = ?").bind(messageId).first<Row>();
  return r ? fromRow(r) : null;
}

export async function listReceipts(db: D1Database): Promise<Receipt[]> {
  const { results } = await db
    .prepare("SELECT * FROM receipts ORDER BY (state = 'filed'), received_at DESC, rowid DESC")
    .all<Row>();
  return results.map(fromRow);
}

export async function listOpen(db: D1Database): Promise<Receipt[]> {
  const { results } = await db
    .prepare(`SELECT * FROM receipts WHERE state IN (${OPEN_STATES.map(() => "?").join(",")}) ORDER BY received_at DESC, rowid DESC`)
    .bind(...OPEN_STATES)
    .all<Row>();
  return results.map(fromRow);
}

export async function updateReceipt(db: D1Database, id: string, patch: Partial<Receipt>): Promise<void> {
  const keys = (Object.keys(patch) as (keyof Receipt)[]).filter((k) => k !== "id" && k !== "updatedAt" && k in COLS && patch[k] !== undefined);
  const sets = [...keys.map((k) => `${COLS[k]} = ?`), "updated_at = ?"];
  await db
    .prepare(`UPDATE receipts SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...keys.map((k) => toColumn(k, patch[k])), now(), id)
    .run();
}

export async function deleteReceipt(db: D1Database, id: string): Promise<StoredFile[]> {
  const files = await listFiles(db, id);
  await db.batch([
    db.prepare("DELETE FROM files WHERE receipt_id = ?").bind(id),
    db.prepare("DELETE FROM events WHERE receipt_id = ?").bind(id),
    db.prepare("DELETE FROM receipts WHERE id = ?").bind(id),
  ]);
  return files;
}

export async function addFile(db: D1Database, f: Omit<StoredFile, "id">): Promise<StoredFile> {
  const file = { id: crypto.randomUUID(), ...f };
  await db
    .prepare("INSERT INTO files (id, receipt_id, r2_key, filename, content_type, size, sha256) VALUES (?,?,?,?,?,?,?)")
    .bind(file.id, file.receiptId, file.r2Key, file.filename, file.contentType, file.size, file.sha256)
    .run();
  return file;
}

export async function listFiles(db: D1Database, receiptId: string): Promise<StoredFile[]> {
  const { results } = await db.prepare("SELECT * FROM files WHERE receipt_id = ? ORDER BY rowid").bind(receiptId).all<Row>();
  return results.map(fileFromRow);
}

export async function findDuplicateFile(db: D1Database, sha256: string, notReceiptId: string): Promise<StoredFile | null> {
  const r = await db
    .prepare("SELECT * FROM files WHERE sha256 = ? AND receipt_id != ? ORDER BY rowid LIMIT 1")
    .bind(sha256, notReceiptId)
    .first<Row>();
  return r ? fileFromRow(r) : null;
}

export async function addEvent(db: D1Database, receiptId: string, message: string): Promise<void> {
  await db.prepare("INSERT INTO events (receipt_id, at, message) VALUES (?,?,?)").bind(receiptId, now(), message).run();
}

export async function listEvents(db: D1Database, receiptId: string): Promise<{ at: string; message: string }[]> {
  const { results } = await db.prepare("SELECT at, message FROM events WHERE receipt_id = ? ORDER BY id").bind(receiptId).all<{ at: string; message: string }>();
  return results;
}

/** Pins a receipt to a bank line. The unique index on pinned_line makes the claim atomic; false means another receipt holds the line. */
export async function pin(db: D1Database, id: string, lineUrl: string, by: "auto" | "manual"): Promise<boolean> {
  try {
    await db.prepare("UPDATE receipts SET pinned_line = ?, pinned_by = ?, updated_at = ? WHERE id = ?").bind(lineUrl, by, now(), id).run();
    return true;
  } catch (e) {
    if (String(e).includes("UNIQUE")) return false;
    throw e;
  }
}

export async function unpin(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE receipts SET pinned_line = NULL, pinned_by = NULL, updated_at = ? WHERE id = ?").bind(now(), id).run();
}

export async function usedLines(db: D1Database): Promise<Set<string>> {
  const { results } = await db.prepare("SELECT pinned_line FROM receipts WHERE pinned_line IS NOT NULL").all<{ pinned_line: string }>();
  return new Set(results.map((r) => r.pinned_line));
}

export async function claimForAttach(db: D1Database, id: string): Promise<boolean> {
  const r = await db
    .prepare("UPDATE receipts SET attach_claimed_at = ? WHERE id = ? AND attach_claimed_at IS NULL AND attachment_urls IS NULL")
    .bind(now(), id)
    .run();
  return r.meta.changes > 0;
}

export async function releaseClaim(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE receipts SET attach_claimed_at = NULL WHERE id = ?").bind(id).run();
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  return (await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}
