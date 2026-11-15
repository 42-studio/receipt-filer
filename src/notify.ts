import { getReceipt, getSetting, setSetting, updateReceipt, type Receipt } from "./db";
import type { Env } from "./env";

export type Kind = "stuck" | "could_not_read" | "needs_choice" | "failed" | "reconnect";
export type NotifyEnv = Pick<Env, "DB" | "EMAIL" | "NOTIFY_TO" | "FORWARD_ADDRESS" | "APP_URL">;
export type Notify = (env: NotifyEnv, kind: Kind, receipt?: Receipt) => Promise<void>;

/** Every notification subject starts with this; the email handler drops mail that carries it. */
export const SUBJECT_PREFIX = "Receipt filer:";

/** The reason the runner stores when an attach may or may not have been saved. */
export const UNCONFIRMED = "FreeAgent did not confirm the attachment. Check the transaction in FreeAgent before you press Retry.";

const QUIET_REASONS = new Set(["no_total", "zero_total"]); // newsletters and zero invoices make no noise
const DAY_MS = 86_400_000;

export function shouldNotify(kind: Kind, receipt?: Receipt): boolean {
  return kind !== "could_not_read" || !QUIET_REASONS.has(receipt?.reason ?? "");
}

const WHY: Record<string, string> = {
  no_attachment: "The email had no receipt file attached.",
  file_too_large: "The receipt file is too big for FreeAgent (5 MB limit).",
  unreadable_file: "The receipt file could not be read.",
};

function compose(kind: Kind, r: Receipt | undefined, appUrl: string): { subject: string; text: string } {
  if (kind === "reconnect") {
    return { subject: `${SUBJECT_PREFIX} reconnect FreeAgent`, text: `The FreeAgent connection has stopped working. Reconnect it here:\n${appUrl}\n` };
  }
  const name = r?.supplier || r?.subject || "a receipt";
  const link = `${appUrl}/receipts/${r?.id}`;
  const [label, why] = {
    could_not_read: ["Could not read", WHY[r?.reason ?? ""] ?? "The receipt could not be read."],
    stuck: ["Still unmatched", "No matching bank transaction has appeared after two weeks."],
    needs_choice: ["Choose a match", "More than one bank transaction fits. Pick the right one."],
    failed: ["Could not file", r?.reason === UNCONFIRMED ? UNCONFIRMED : `FreeAgent rejected the attachment${r?.reason ? `: ${r.reason}` : "."}`],
  }[kind];
  return { subject: `${SUBJECT_PREFIX} ${label} - ${name}`, text: `${why}\n\nReceipt: ${name}\n${link}\n` };
}

/** Sends at most one email per receipt and kind. Never throws; a failed send is retried on the next occasion. */
export async function notify(env: NotifyEnv, kind: Kind, receipt?: Receipt, now: () => Date = () => new Date()): Promise<void> {
  try {
    if (!shouldNotify(kind, receipt)) return;
    if (kind === "reconnect") {
      const last = await getSetting(env.DB, "reconnect_notified_at");
      if (last && now().getTime() - Date.parse(last) < DAY_MS) return;
    }
    // Read the sent list fresh: the caller's copy may be stale after an earlier notify for the same receipt.
    const sent = kind === "reconnect" ? [] : ((await getReceipt(env.DB, receipt?.id ?? ""))?.notified ?? null);
    if (!sent || sent.includes(kind)) return;

    for (const key of ["NOTIFY_TO", "FORWARD_ADDRESS"] as const) {
      if (!env[key]?.trim()) return console.error(`notify skipped: the ${key} secret is not set`, kind);
    }
    const { subject, text } = compose(kind, receipt, env.APP_URL);
    await env.EMAIL.send({ to: env.NOTIFY_TO, from: env.FORWARD_ADDRESS, subject, text });

    if (kind === "reconnect") await setSetting(env.DB, "reconnect_notified_at", now().toISOString());
    else await updateReceipt(env.DB, receipt!.id, { notified: [...sent, kind] });
  } catch (e) {
    console.error("notify failed", kind, e);
  }
}
