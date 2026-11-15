import { addEvent, claimForAttach, getReceipt, listFiles, listOpen, pin, releaseClaim, unpin, updateReceipt, usedLines, type Receipt, type State } from "../db";
import { IMAGE_MAX_SIDE, LOOKBACK_DAYS, STUCK_AFTER_DAYS, type Env } from "../env";
import * as freeagent from "../freeagent/client";
import { AttachUnconfirmed, FreeAgentAuthError, FreeAgentUnavailable, type BankLine } from "../freeagent/client";
import { notify, UNCONFIRMED } from "../notify";
import { readReceipt } from "../read/reader";
import { decide, type Decision } from "./matcher";
import { rateToGbp } from "./fx";

type AttachFile = { filename: string; contentType: string; data: Uint8Array };

export interface Deps {
  fa: Pick<typeof freeagent, "listBankLines" | "getBankLine" | "attach" | "pickExplanation">;
  rate: typeof rateToGbp;
  notify: typeof notify;
  now: () => Date;
  read: typeof readReceipt;
  convert: (env: Env, file: AttachFile) => Promise<AttachFile>;
}

const DAY_MS = 86_400_000;
const NEEDS_CONVERSION = new Set(["image/webp", "image/heic", "image/heif"]); // FreeAgent takes only PNG, JPEG, GIF, PDF

/** Converts WebP and HEIC/HEIF to JPEG, scaled down to IMAGE_MAX_SIDE; every other file passes through unchanged. */
export async function toFreeAgentFile(env: Env, f: AttachFile): Promise<AttachFile> {
  if (!NEEDS_CONVERSION.has(f.contentType)) return f;
  const out = await env.IMAGES.input(new Response(f.data as BodyInit).body!)
    .transform({ width: IMAGE_MAX_SIDE, height: IMAGE_MAX_SIDE, fit: "scale-down" }) // keeps the JPEG under FreeAgent's 5 MB
    .output({ format: "image/jpeg", quality: 85 });
  return {
    filename: f.filename.replace(/\.[^./]+$/, "") + ".jpg",
    contentType: "image/jpeg",
    data: new Uint8Array(await new Response(out.image()).arrayBuffer()),
  };
}

const defaults: Deps = { fa: freeagent, rate: rateToGbp, notify, now: () => new Date(), read: readReceipt, convert: toFreeAgentFile };
const isDown = (e: unknown) => e instanceof FreeAgentUnavailable || e instanceof FreeAgentAuthError;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const dateOf = (r: Receipt) => r.receiptDate ?? r.emailDate?.slice(0, 10) ?? r.receivedAt.slice(0, 10);

export async function runMatcher(env: Env, partial: Partial<Deps> = {}, onlyReceiptId?: string): Promise<void> {
  const d: Deps = { ...defaults, ...partial };
  const note = (kind: Parameters<typeof notify>[1], r?: Receipt) => d.notify(env, kind, r, d.now);
  const open = async () => (await listOpen(env.DB)).filter((r) => !onlyReceiptId || r.id === onlyReceiptId);

  const setState = async (r: Receipt, state: State, reason: string | null, event: string) => {
    await updateReceipt(env.DB, r.id, { state, reason });
    await addEvent(env.DB, r.id, event);
  };

  // Files the receipt on its line, or waits for the line's explanation.
  const file = async (r: Receipt, line: BankLine) => {
    const explanation = d.fa.pickExplanation(line, r.totalMinor ?? NaN); // no total (hand-matched): NaN matches nothing, so the largest explanation is taken
    if (!explanation) {
      if (r.state !== "waiting_explanation") await setState(r, "waiting_explanation", null, "Matched; waiting for the bank line to be explained");
      return;
    }
    if (!(await claimForAttach(env.DB, r.id))) return; // another run holds it, or it is already filed
    const rows = await listFiles(env.DB, r.id);
    let urls: string[];
    try {
      const files: AttachFile[] = [];
      for (const f of rows) {
        const obj = await env.FILES.get(f.r2Key);
        if (!obj) throw new Error(`File ${f.filename} is missing from storage`);
        files.push(await d.convert(env, { filename: f.filename, contentType: f.contentType, data: new Uint8Array(await obj.arrayBuffer()) }));
      }
      urls = await d.fa.attach(env, explanation, files);
    } catch (e) {
      if (e instanceof AttachUnconfirmed) {
        // The claim stays held: FreeAgent may have saved the files, so only Josh can send them again (Retry or Match).
        const saved = e.attachmentUrls.length ? ` Saved before the failure: ${e.attachmentUrls.join(", ")}` : "";
        await setState(r, "failed", UNCONFIRMED, `${e.message}.${saved}`);
        return note("failed", { ...r, state: "failed", reason: UNCONFIRMED });
      }
      await releaseClaim(env.DB, r.id);
      if (isDown(e)) throw e;
      const message = e instanceof Error ? e.message : String(e);
      await setState(r, "failed", message, `FreeAgent refused the attachment: ${message}`);
      return note("failed", { ...r, state: "failed", reason: message });
    }
    try {
      // attachmentUrls is set first and in one write with the state: it is what stops a second attach.
      await updateReceipt(env.DB, r.id, { state: "filed", reason: null, explanationUrl: explanation, attachmentUrls: urls, filedAt: d.now().toISOString(), body: null });
      await addEvent(env.DB, r.id, `Attached ${urls.length} file(s) to FreeAgent`);
    } catch (e) {
      // shortcut: the claim stays held so nothing attaches twice; the receipt stays unfiled in the UI until someone looks.
      console.error("attached but could not record it", r.id, urls, e);
      return;
    }
    try {
      await env.FILES.delete(rows.map((f) => f.r2Key)); // rows stay as history and for duplicate checks
    } catch (e) {
      console.error("R2 delete failed", r.id, e);
    }
  };

  const handle = async (r: Receipt, decision: Decision | undefined, contested: (url: string) => boolean) => {
    if (r.pinnedLine) {
      const line = await d.fa.getBankLine(env, r.pinnedLine);
      if (!line) {
        await unpin(env.DB, r.id);
        return setState(r, "waiting_payment", null, "The pinned bank line no longer exists; waiting for payment again");
      }
      return file(r, line);
    }
    if (!decision) return; // FreeAgent could not be listed, or the receipt has no reading
    if (decision.kind === "match" && contested(decision.line.url)) {
      if (r.state === "needs_choice") return;
      await setState(r, "needs_choice", null, `Another receipt also fits this bank line (${decision.line.url}); choose one`);
      return note("needs_choice", { ...r, state: "needs_choice", reason: null });
    }
    if (decision.kind === "match") {
      if (await pin(env.DB, r.id, decision.line.url, "auto")) {
        await addEvent(env.DB, r.id, `Matched to bank line ${decision.line.url}`);
        return file({ ...r, pinnedLine: decision.line.url }, decision.line);
      }
      // another run took the line first
    }
    if (decision.kind === "choice") {
      if (r.state === "needs_choice") return;
      await setState(r, "needs_choice", null, `${decision.lines.length} bank line(s) fit; choose one`);
      return note("needs_choice", { ...r, state: "needs_choice", reason: null });
    }
    if (r.state !== "waiting_payment") await setState(r, "waiting_payment", null, "No bank line fits yet");
  };

  try {
    for (const r of await open()) {
      if (r.state !== "reading") continue;
      try { await d.read(env, r.id, d.now, d.notify); } catch (e) { console.error("read failed", r.id, e); }
    }

    // Every open receipt counts for the contest check, even in a run for one receipt; only `receipts` change state.
    const all = (await listOpen(env.DB)).filter((r) => ["waiting_payment", "needs_choice", "waiting_explanation"].includes(r.state));
    const receipts = all.filter((r) => !onlyReceiptId || r.id === onlyReceiptId);
    const unpinned = all.filter((r) => !r.pinnedLine && r.totalMinor !== null && r.currency);
    let lines: BankLine[] | null = null;
    if (receipts.some((r) => unpinned.includes(r))) {
      const oldest = unpinned.map(dateOf).sort()[0];
      lines = await d.fa.listBankLines(env, isoDay(new Date(Date.parse(oldest) - LOOKBACK_DAYS * DAY_MS)));
    }
    const used = await usedLines(env.DB);

    // A line may be pinned on its own only when it is a candidate for exactly one receipt.
    const decisions = new Map<string, Decision>();
    const claims = new Map<string, number>();
    for (const r of lines ? unpinned : []) {
      try {
        const day = dateOf(r);
        const rate = r.currency === "GBP" ? 1 : await d.rate(env, day, r.currency!);
        const decision = decide(
          { totalMinor: r.totalMinor!, currency: r.currency!, date: day, supplier: r.supplier, confidence: r.confidence ?? 0, inputKind: r.inputKind ?? "text" },
          lines!, used, rate,
        );
        decisions.set(r.id, decision);
        for (const l of decision.kind === "match" ? [decision.line] : decision.kind === "choice" ? decision.lines : []) claims.set(l.url, (claims.get(l.url) ?? 0) + 1);
      } catch (e) {
        if (isDown(e)) throw e;
        console.error("match failed", r.id, e);
      }
    }
    const contested = (url: string) => (claims.get(url) ?? 0) > 1;

    for (const r of receipts) {
      try {
        await handle(r, decisions.get(r.id), contested);
      } catch (e) {
        if (isDown(e)) throw e;
        console.error("match failed", r.id, e);
      }
    }

    for (const r of await open()) {
      if (r.state !== "waiting_payment" && r.state !== "waiting_explanation") continue;
      if (d.now().getTime() - Date.parse(r.receivedAt) >= STUCK_AFTER_DAYS * DAY_MS) await note("stuck", r);
    }
  } catch (e) {
    if (e instanceof FreeAgentAuthError) return note("reconnect");
    if (e instanceof FreeAgentUnavailable) return console.warn("FreeAgent unavailable; will retry on the next run");
    throw e;
  }
}
