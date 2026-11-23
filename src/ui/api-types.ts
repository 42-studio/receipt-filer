// JSON shapes the API returns. The UI (ui/) imports these, so this file imports nothing.

export type Action = "match" | "retry" | "delete";
export type Tone = "info" | "warn" | "bad" | "ok" | "neutral";

export interface ReceiptRow {
  id: string;
  title: string;
  subject: string | null;
  supplier: string | null;
  amount: string; // "GBP 24.00", or "–" when unknown
  received: string; // YYYY-MM-DD
  state: string;
  stateLabel: string;
  tone: Tone;
  reason: string | null;
  actions: Action[];
  primary: { action: Action; label: string } | null; // the one action this state asks of you; always one of `actions`
  matchLabel: string; // what the match action is called in this state
  duplicateOf: string | null;
  totalMinor: number | null; // for sums; `amount` is the display form
  currency: string | null;
  filedAt: string | null; // ISO time it was attached in FreeAgent
  pinnedBy: "auto" | "manual" | null;
}

export interface ReceiptDetail extends ReceiptRow {
  receiptDate: string | null;
  confidence: string | null; // "0.90 (text)"
  sender: string | null;
  pinnedLine: string | null;
  filed: boolean;
}

export interface FileInfo { id: string; filename: string; contentType: string; size: number; url: string | null; preview: "pdf" | "image" | null }
export interface EventInfo { at: string; message: string }

export interface MatchLine { url: string; datedOn: string; amount: string; description: string; explained: boolean; fits: boolean; heldByOther: boolean; current: boolean }

export interface ListResponse { receipts: ReceiptRow[] }
export interface ReceiptResponse { receipt: ReceiptDetail; files: FileInfo[]; events: EventInfo[]; email: EmailInfo }
/** The email as it arrived; bodyUrl serves its body (sandboxed), null once filing removed it. */
export interface EmailInfo { from: string | null; subject: string | null; date: string | null; bodyUrl: string | null }
export interface MatchResponse { receipt: ReceiptRow; receiptDay: string; windowDays: number; lines: MatchLine[]; files: FileInfo[]; email: EmailInfo }
export interface SettingsResponse { forwardAddress: string | null; connected: boolean; baseUrl: string }
export interface ErrorResponse { error: string }
