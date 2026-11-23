import type { ReceiptRow, Tone } from "@api";
import { AlertCircleIcon } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { Link } from "react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import type { ApiError } from "@/lib/api";

// The label always carries the meaning; the colour only reinforces it.
const TONE: Record<Tone, string> = {
  info: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  warn: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  bad: "bg-red-500/10 text-red-700 dark:text-red-300",
  ok: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  neutral: "bg-muted text-muted-foreground",
};

export function StateBadge({ r }: { r: Pick<ReceiptRow, "tone" | "stateLabel"> }) {
  return <Badge className={TONE[r.tone]}>{r.stateLabel}</Badge>;
}

export function ToneBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <Badge className={TONE[tone]}>{children}</Badge>;
}

export function ErrorAlert({ error, title = "Could not load this" }: { error: ApiError; title?: string }) {
  return (
    <Alert variant="destructive">
      <AlertCircleIcon aria-hidden />
      <AlertTitle>{error.status === 404 ? "Not found" : title}</AlertTitle>
      <AlertDescription>
        <p>{error.message}</p>
        <Link to="/" className="underline underline-offset-4">Back to the dashboard</Link>
      </AlertDescription>
    </Alert>
  );
}

/** Sets the browser tab title while mounted; it is what a screen reader announces first. */
export function usePageTitle(title: string | undefined) {
  useEffect(() => {
    const before = document.title;
    document.title = title ? `${title} · Receipt filer` : "Receipt filer";
    return () => { document.title = before; };
  }, [title]);
}

export function PageTitle({ children, sub, action }: { children: ReactNode; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{children}</h1>
        {sub && <p className="mt-1 text-sm text-muted-foreground">{sub}</p>}
      </div>
      {action}
    </div>
  );
}
