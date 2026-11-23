import type { MatchLine, MatchResponse, ReceiptDetail } from "@api";
import { FileQuestionIcon, Loader2Icon, SearchIcon, SearchXIcon } from "lucide-react";
import { useState } from "react";
import { useParams } from "react-router";
import { toast } from "sonner";
import { ErrorAlert, ToneBadge, usePageTitle } from "@/components/receipt-bits";
import { ReceiptViewer } from "@/components/receipt-viewer";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, notifyChanged, useApi, type ApiError } from "@/lib/api";
import { useReceiptNav } from "@/lib/nav";
import { cn } from "@/lib/utils";

const DAY = 86_400_000;
const daysFrom = (line: string, day: string) => Math.round((Date.parse(line) - Date.parse(day)) / DAY);
// Words in the subject and sender that are worth looking for in a bank description ("notion", "uber").
const COMMON = new Set(["your", "from", "receipt", "invoice", "order", "payment", "thanks", "with", "trip", "noreply", "reply", "billing", "example", "mail", "email", "info", "support"]);
const nameWords = (e: MatchResponse["email"]) =>
  new Set(`${e.subject ?? ""} ${(e.from ?? "").replace(/@/g, " ").replace(/\./g, " ")}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !COMMON.has(w)));
const offset = (d: number) => (d === 0 ? "same day" : `${Math.abs(d)} day${Math.abs(d) === 1 ? "" : "s"} ${d > 0 ? "after" : "before"}`);

/**
 * Pick a bank line for a receipt. A receipt that could not be read gets a split view:
 * the receipt on one side to read the total and date from, the bank lines on the other.
 */
export function MatchDialog() {
  const { id } = useParams();
  const nav = useReceiptNav();
  const { data, error } = useApi<MatchResponse>(`/api/receipts/${id}/match`);
  const unread = data?.receipt.state === "could_not_read";
  usePageTitle(unread ? "Match by hand" : "Match a bank line");

  return (
    <Dialog open onOpenChange={(open) => { if (!open) nav.close(); }}>
      <DialogContent className={cn("flex max-h-[92svh] flex-col gap-0 p-0", unread ? "h-[92svh] sm:max-w-6xl" : "sm:max-w-2xl")}>
        <DialogHeader className="border-b p-4 pr-12 text-left">
          <DialogTitle className="text-lg">{unread ? "Match by hand" : "Match a bank line"}</DialogTitle>
          <DialogDescription>
            {!data ? "Loading bank lines…" : unread ? (
              <><span className="font-medium text-foreground">{data.receipt.title}</span> could not be read{data.receipt.reason ? ` (${data.receipt.reason})` : ""}. Find its total and date on the receipt, then choose the payment.</>
            ) : <Summary data={data} />}
          </DialogDescription>
        </DialogHeader>
        {error ? <div className="p-4"><ErrorAlert error={error} /></div> : !data ? (
          <div className="space-y-3 p-4">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : unread ? (
          <div className="grid min-h-0 flex-1 grid-rows-[minmax(14rem,42%)_minmax(0,1fr)] lg:grid-cols-2 lg:grid-rows-1">
            <section aria-label="Receipt" className="flex min-h-0 flex-col border-b bg-muted/30 p-4 lg:border-r lg:border-b-0">
              <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium"><FileQuestionIcon className="size-4 text-amber-600 dark:text-amber-400" aria-hidden />The receipt</h3>
              <ReceiptViewer files={data.files} email={data.email} className="flex-1" />
            </section>
            <Lines data={data} byDistance label="Find the payment" placeholder="Total from the receipt, e.g. 24.00" />
          </div>
        ) : (
          <Lines data={data} label="Filter bank lines" placeholder="Description, date or amount" />
        )}
        <DialogFooter className="m-0 border-t p-4">
          <Button variant="outline" onClick={nav.close}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Summary({ data }: { data: MatchResponse }) {
  const fits = data.lines.filter((l) => l.fits).length;
  return (
    <>
      <span className="font-medium text-foreground">{data.receipt.title}</span>, <span className="tabular-nums">{data.receipt.amount}</span> on {data.receiptDay}.
      {" "}Lines within {data.windowDays} days{fits > 0 && <>; {fits === 1 ? "the one that fits is" : `the ${fits} that fit are`} first</>}.
    </>
  );
}

/** The filter and the bank lines. `byDistance` orders by how close each line is to the receipt's day (the email's, when unread). */
function Lines({ data, byDistance = false, label, placeholder }: { data: MatchResponse; byDistance?: boolean; label: string; placeholder: string }) {
  const { id } = useParams();
  const nav = useReceiptNav();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const needle = q.trim().toLowerCase().replace(/^[-£$€]+/, "");
  const words = byDistance ? nameWords(data.email) : new Set<string>();
  const named = (l: MatchLine) => [...words].some((w) => l.description.toLowerCase().includes(w));
  const near = (l: MatchLine) => Math.abs(daysFrom(l.datedOn, data.receiptDay));
  const lines = data.lines
    .filter((l) => !needle || `${l.description} ${l.datedOn} ${l.amount} ${l.amount.replace(/,/g, "")}`.toLowerCase().includes(needle))
    .sort((a, b) => (byDistance ? Number(named(b)) - Number(named(a)) || near(a) - near(b) : 0));

  const choose = async (l: MatchLine) => {
    setBusy(l.url);
    try {
      const { receipt } = await api<{ receipt: ReceiptDetail }>(`/api/receipts/${id}/match`, { method: "POST", json: { line: l.url } });
      toast.success(`${receipt.title} matched to ${l.description}: ${receipt.stateLabel.toLowerCase()}`);
      nav.closeAll();
      notifyChanged();
    } catch (e) {
      toast.error((e as ApiError).message);
      setBusy(null);
    }
  };

  return (
    <section aria-label="Bank lines" className="flex min-h-0 flex-col">
      <div className="space-y-1.5 border-b p-4">
        <label htmlFor="line-filter" className="text-sm font-medium">{label}</label>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input id="line-filter" type="search" inputMode={byDistance ? "decimal" : undefined} placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
        </div>
        {byDistance && <p className="text-xs text-muted-foreground">Bank lines within {data.windowDays} days of {data.receiptDay}. Names from the email first, then the closest dates.</p>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {lines.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
            <SearchXIcon className="size-8 text-muted-foreground" aria-hidden />
            <p className="font-medium">{needle ? "No bank lines match" : "No bank lines in this window"}</p>
            {needle && <Button variant="outline" size="sm" onClick={() => setQ("")}>Clear the filter</Button>}
          </div>
        ) : (
          <ul className="divide-y">
            {lines.map((l) => (
              <li key={l.url} className={cn("flex items-center gap-3 px-4 py-3", l.fits && "bg-emerald-500/[0.04]")}>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="flex flex-wrap items-center gap-2 font-medium break-words">
                    {l.fits && <ToneBadge tone="ok">Fits</ToneBadge>}
                    {!l.fits && named(l) && <ToneBadge tone="info">Name matches</ToneBadge>}
                    {l.description}
                  </p>
                  <p className="text-sm text-muted-foreground tabular-nums">
                    {l.datedOn} · {byDistance ? offset(daysFrom(l.datedOn, data.receiptDay)) : l.explained ? "explained" : "not explained"}
                    {l.current && " · current match"}
                  </p>
                  {l.heldByOther && <p className="text-xs text-destructive">Held by another receipt</p>}
                </div>
                <span className="shrink-0 text-base font-semibold tabular-nums">{l.amount}</span>
                <div className="w-20 shrink-0 text-right">
                  {!l.heldByOther && (
                    <Button size="sm" variant={l.fits ? "default" : "outline"} onClick={() => choose(l)} disabled={busy !== null} aria-label={`Match to ${l.description}, ${l.amount}, ${l.datedOn}`}>
                      {busy === l.url && <Loader2Icon className="animate-spin" aria-hidden />}Match
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
