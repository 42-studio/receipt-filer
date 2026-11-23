import type { EmailInfo, FileInfo } from "@api";
import { ExternalLinkIcon, FileXIcon, MailIcon } from "lucide-react";
import { PdfPreview } from "@/components/pdf-preview";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/**
 * The receipt itself, to read while matching: each previewable file, then the email it came in.
 * Fills its parent's height, so the parent sets the size.
 */
export function ReceiptViewer({ files, email, className }: { files: FileInfo[]; email: EmailInfo; className?: string }) {
  const viewable = files.filter((f) => f.preview && f.url);
  const tabs = [...viewable.map((f) => ({ key: f.id, label: f.filename })), ...(email.bodyUrl ? [{ key: "email", label: "Email" }] : [])];

  if (tabs.length === 0) {
    return (
      <div className={cn("flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-center", className)}>
        <FileXIcon className="size-8 text-muted-foreground" aria-hidden />
        <p className="font-medium">Nothing to show</p>
        <p className="max-w-xs text-sm text-muted-foreground">
          The email had no receipt file and no text. Use the subject and date{files.length ? ", or open the file," : ""} to find the payment.
        </p>
        {files.map((f) => f.url && <a key={f.id} href={f.url} target="_blank" rel="noopener" className="text-sm underline underline-offset-4">{f.filename}</a>)}
      </div>
    );
  }

  return (
    <Tabs defaultValue={tabs[0].key} className={cn("min-h-0 gap-2", className)}>
      {tabs.length > 1 && (
        // shown under the preview, full width; first in the markup so Tab still reaches it before the content
        <TabsList className="order-last w-full shrink-0 overflow-x-auto">
          {tabs.map((t) => (
            <TabsTrigger key={t.key} value={t.key} className="min-w-0 flex-1">
              {t.key === "email" && <MailIcon aria-hidden />}
              <span className="truncate">{t.label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      )}
      {viewable.map((f) => (
        <TabsContent key={f.id} value={f.id} className="flex min-h-0 flex-col gap-1.5">
          {f.preview === "pdf"
            ? <PdfPreview url={f.url!} filename={f.filename} className="flex-1" />
            : (
              <div className="relative min-h-0 flex-1 overflow-auto rounded-lg border bg-white">
                <img src={f.url!} alt={`Receipt file ${f.filename}`} className="mx-auto block max-w-full" />
                <a href={f.url!} target="_blank" rel="noopener" aria-label={`Open ${f.filename} in a new tab`} className="absolute top-2 right-2 grid size-7 place-items-center rounded-md bg-background/90 text-muted-foreground shadow-sm ring-1 ring-foreground/10 hover:text-foreground"><ExternalLinkIcon className="size-3.5" aria-hidden /></a>
              </div>
            )}
        </TabsContent>
      ))}
      {email.bodyUrl && (
        <TabsContent value="email" className="flex min-h-0 flex-col gap-2">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs">
            <dt className="text-muted-foreground">From</dt><dd className="min-w-0 break-words">{email.from ?? "–"}</dd>
            <dt className="text-muted-foreground">Subject</dt><dd className="min-w-0 break-words">{email.subject ?? "–"}</dd>
            {email.date && <><dt className="text-muted-foreground">Sent</dt><dd className="tabular-nums">{email.date.slice(0, 16).replace("T", " ")}</dd></>}
          </dl>
          {/* sandbox with no allowances: the body runs no script and has no origin; the server also blocks its network */}
          <iframe src={email.bodyUrl} sandbox="" title="Email body" className="min-h-0 w-full flex-1 rounded-lg border bg-white" />
        </TabsContent>
      )}
    </Tabs>
  );
}
