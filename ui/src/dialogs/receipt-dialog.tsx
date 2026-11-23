import type { ReceiptResponse } from "@api";
import { ExternalLinkIcon, FileTextIcon, InfoIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router";
import { PdfPreview } from "@/components/pdf-preview";
import { ReceiptActions } from "@/components/receipt-actions";
import { ErrorAlert, StateBadge, usePageTitle } from "@/components/receipt-bits";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useApi } from "@/lib/api";
import { useReceiptNav } from "@/lib/nav";

const size = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);
const when = (iso: string) => iso.slice(0, 16).replace("T", " ");

export function ReceiptDialog() {
  const { id } = useParams();
  const nav = useReceiptNav();
  const { data, error } = useApi<ReceiptResponse>(`/api/receipts/${id}`);
  usePageTitle(data?.receipt.title ?? (error ? "Not found" : undefined));
  const r = data?.receipt;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) nav.close(); }}>
      <DialogContent className="max-h-[92svh] gap-0 overflow-y-auto p-0 sm:max-w-5xl">
        <DialogHeader className="flex-row flex-wrap items-start gap-3 border-b p-4 pr-12 text-left">
          <div className="min-w-0 flex-1 space-y-1.5">
            <DialogTitle className="text-lg break-words">{r?.title ?? (error ? "Receipt" : <Skeleton className="h-6 w-48" />)}</DialogTitle>
            <DialogDescription asChild>
              <div className="flex flex-wrap items-center gap-2">
                {r && <StateBadge r={r} />}
                {r && <span className="tabular-nums">{r.amount}</span>}
                {r?.receiptDate && <span>· {r.receiptDate}</span>}
              </div>
            </DialogDescription>
          </div>
          {r && <ReceiptActions r={r} inDetails size="default" />}
        </DialogHeader>
        <div className="p-4">
          {error && <ErrorAlert error={error} />}
          {!data && !error && <Skeleton className="h-80 w-full" />}
          {data && <Body data={data} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Body({ data: { receipt: r, files, events } }: { data: ReceiptResponse }) {
  const nav = useReceiptNav();
  return (
    <div className="space-y-6">
      {r.reason && (
        <p className={`rounded-lg border px-3 py-2 text-sm ${r.tone === "bad" ? "border-destructive/30 bg-destructive/5 text-destructive" : "bg-muted/50"}`}>
          {r.reason}
        </p>
      )}
      <div className="grid gap-6 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="min-w-0 space-y-6">
          <section aria-labelledby="details-h">
            <h3 id="details-h" className="mb-3 text-sm font-medium">Details</h3>
            <dl className="grid gap-x-6 gap-y-0.5 text-sm sm:grid-cols-[max-content_1fr] sm:gap-y-2.5">
              <Field k="Supplier">{r.supplier ?? "–"}</Field>
              <Field k="Total"><span className="font-medium tabular-nums">{r.amount}</span></Field>
              <Field k="Receipt date">{r.receiptDate ?? "–"}</Field>
              <Field k="Confidence">{r.confidence ?? "–"}</Field>
              <Field k="Email subject">{r.subject ?? "–"}</Field>
              <Field k="From">{r.sender ?? "–"}</Field>
              <Field k="Received">{r.received}</Field>
              <Field k="Bank line">{r.pinnedLine ? <><code className="text-xs break-all">{r.pinnedLine}</code> <span className="text-muted-foreground">({r.pinnedBy === "manual" ? "matched by hand" : "matched automatically"})</span></> : "none"}</Field>
              {r.duplicateOf && <Field k="Duplicate of"><Link {...nav.link(r.duplicateOf)} replace className="underline underline-offset-4">the earlier receipt</Link></Field>}
            </dl>
          </section>
          <section aria-labelledby="history-h">
            <h3 id="history-h" className="mb-3 text-sm font-medium">History</h3>
            {events.length === 0 ? <p className="text-sm text-muted-foreground">No history.</p> : (
              <ol className="relative ml-1 space-y-3 border-l pl-4">
                {events.map((e, i) => (
                  <li key={i} className="relative text-sm">
                    <span className="absolute top-1.5 -left-[1.3rem] size-2 rounded-full bg-muted-foreground/40 ring-4 ring-popover" aria-hidden />
                    <time dateTime={e.at} className="block text-xs text-muted-foreground tabular-nums">{when(e.at)}</time>
                    <span className="break-words">{e.message}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
        <section aria-labelledby="files-h" className="min-w-0">
          <h3 id="files-h" className="mb-3 text-sm font-medium">Files</h3>
          {files.length === 0 && <p className="text-sm text-muted-foreground">No files.</p>}
          {r.filed && files.length > 0 && (
            <p className="mb-3 flex items-start gap-2 text-sm text-muted-foreground"><InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden />Attached in FreeAgent. The stored copies are removed after filing.</p>
          )}
          <div className="space-y-4">
            {files.map((f) => (
              <div key={f.id} className="space-y-2">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  <FileTextIcon className="size-4 text-muted-foreground" aria-hidden />
                  {f.url ? <a href={f.url} target="_blank" rel="noopener" className="inline-flex items-center gap-1 font-medium hover:underline underline-offset-4">{f.filename}<ExternalLinkIcon className="size-3" aria-label="opens in a new tab" /></a> : <span className="font-medium">{f.filename}</span>}
                  <span className="text-muted-foreground">{f.contentType} · {size(f.size)}</span>
                </div>
                {f.preview === "pdf" && <PdfPreview url={f.url!} filename={f.filename} className="h-[28rem]" />}
                {f.preview === "image" && <img src={f.url!} alt={f.filename} loading="lazy" className="max-h-[28rem] rounded-lg border" />}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function Field({ k, children }: { k: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="mb-2.5 min-w-0 break-words sm:mb-0">{children}</dd>
    </>
  );
}
