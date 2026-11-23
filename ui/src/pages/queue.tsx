import type { ListResponse, ReceiptRow } from "@api";
import { InboxIcon, SearchIcon } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import { ReceiptActions } from "@/components/receipt-actions";
import { ErrorAlert, PageTitle, StateBadge, usePageTitle } from "@/components/receipt-bits";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApi } from "@/lib/api";
import { useReceiptNav } from "@/lib/nav";
import { cn } from "@/lib/utils";

const NEEDS_YOU = new Set(["failed", "could_not_read", "needs_choice"]);
const VIEWS: { key: string; label: string; keep: (r: ReceiptRow) => boolean }[] = [
  { key: "all", label: "All", keep: () => true },
  { key: "attention", label: "Needs you", keep: (r) => NEEDS_YOU.has(r.state) },
  { key: "open", label: "Open", keep: (r) => r.state !== "filed" && r.state !== "duplicate" },
  { key: "filed", label: "Filed", keep: (r) => r.state === "filed" },
  { key: "duplicate", label: "Duplicates", keep: (r) => r.state === "duplicate" },
];

export function QueuePage() {
  usePageTitle("Queue");
  const { data, error, loading } = useApi<ListResponse>("/api/receipts");
  const nav = useReceiptNav();
  // The view and search live in the URL, so Back returns to the same list.
  const [params, setParams] = useSearchParams();
  const view = VIEWS.find((v) => v.key === params.get("view")) ?? VIEWS[0];
  const q = params.get("q") ?? "";
  const set = (key: "view" | "q", value: string, isDefault: boolean) =>
    setParams((p) => { if (isDefault) p.delete(key); else p.set(key, value); return p; }, { replace: true });
  const receipts = data?.receipts ?? [];
  const counts = Object.fromEntries(VIEWS.map((v) => [v.key, receipts.filter(v.keep).length]));
  const needle = q.trim().toLowerCase();
  const shown = receipts.filter(view.keep).filter((r) => !needle || `${r.title} ${r.subject ?? ""} ${r.amount} ${r.amount.replace(/,/g, "")} ${r.stateLabel}`.toLowerCase().includes(needle));

  return (
    <>
      <PageTitle sub="Every receipt, newest open ones first.">Queue</PageTitle>
      {error && <ErrorAlert error={error} />}
      {!error && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div role="group" aria-label="Show" className="inline-flex flex-wrap rounded-lg border bg-background p-0.5">
              {VIEWS.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  aria-pressed={view.key === v.key}
                  onClick={() => set("view", v.key, v.key === "all")}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                    view.key === v.key ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {v.label}
                  {data && <span className="text-xs tabular-nums text-muted-foreground">{counts[v.key]}</span>}
                </button>
              ))}
            </div>
            <div className="relative ml-auto w-full sm:w-64">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input type="search" aria-label="Search receipts" placeholder="Search receipts" value={q} onChange={(e) => set("q", e.target.value, e.target.value === "")} className="pl-8" />
            </div>
          </div>
          <Card className="gap-0 overflow-hidden py-0">
            {loading ? (
              <div className="space-y-3 p-4">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : shown.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-16 text-center">
                <InboxIcon className="size-8 text-muted-foreground" aria-hidden />
                <p className="font-medium">{receipts.length ? "No receipts match" : "No receipts yet"}</p>
                {receipts.length > 0 && <Button variant="outline" size="sm" onClick={() => setParams({}, { replace: true })}>Show all receipts</Button>}
              </div>
            ) : (
              <>
                <ul className="divide-y md:hidden">
                  {shown.map((r) => (
                    <li key={r.id} className="flex items-start gap-3 p-4">
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <Link {...nav.link(r.id)} className="block font-medium break-words hover:underline underline-offset-4">{r.title}</Link>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <StateBadge r={r} />
                          <span className="tabular-nums">{r.received}</span>
                        </div>
                        {r.reason && <p className={cn("text-xs break-words", r.tone === "bad" ? "text-destructive" : "text-muted-foreground")}>{r.reason}</p>}
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        <span className="font-medium tabular-nums">{r.amount}</span>
                        <ReceiptActions r={r} />
                      </div>
                    </li>
                  ))}
                </ul>
                <Table className="hidden md:table">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="pl-4">Receipt</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Received</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="pr-4 text-right"><span className="sr-only">Actions</span></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shown.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="max-w-64 pl-4 whitespace-normal">
                          <Link {...nav.link(r.id)} className="block font-medium break-words hover:underline underline-offset-4">{r.title}</Link>
                          {r.supplier && r.subject && <span className="block text-xs break-words text-muted-foreground">{r.subject}</span>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{r.amount}</TableCell>
                        <TableCell className="text-muted-foreground tabular-nums">{r.received}</TableCell>
                        <TableCell className="max-w-64 whitespace-normal">
                          <StateBadge r={r} />
                          {r.reason && <span className={cn("mt-1 block text-xs break-words", r.tone === "bad" ? "text-destructive" : "text-muted-foreground")}>{r.reason}</span>}
                        </TableCell>
                        <TableCell className="pr-4">
                          <div className="flex justify-end"><ReceiptActions r={r} /></div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            )}
          </Card>
        </>
      )}
    </>
  );
}
