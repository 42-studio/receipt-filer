import type { Action, ReceiptRow } from "@api";
import { EllipsisIcon, EyeIcon, LinkIcon, Loader2Icon, RotateCwIcon, Trash2Icon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api, notifyChanged, type ApiError } from "@/lib/api";
import { useReceiptNav } from "@/lib/nav";

// The one thing each state asks of you. States not listed need nothing: they move on by themselves.
const PRIMARY: Record<string, { action: Action; label: string }> = {
  failed: { action: "retry", label: "Retry" },
  could_not_read: { action: "match", label: "Match by hand" },
  needs_choice: { action: "match", label: "Choose bank line" },
  duplicate: { action: "delete", label: "Delete" },
};

const ICON: Record<Action, ReactNode> = { match: <LinkIcon aria-hidden />, retry: <RotateCwIcon aria-hidden />, delete: <Trash2Icon aria-hidden /> };
const matchLabel = (r: ReceiptRow) => (r.state === "waiting_explanation" ? "Change bank line" : "Match by hand");

/** Retry and delete with their busy state and the delete confirmation; match opens the match dialog. */
function useReceiptActions(r: ReceiptRow, onDeleted?: () => void) {
  const nav = useReceiptNav();
  const [busy, setBusy] = useState<Action | null>(null);
  const [confirming, setConfirming] = useState(false);

  const retry = async () => {
    setBusy("retry");
    try {
      const { receipt } = await api<{ receipt: ReceiptRow }>(`/api/receipts/${r.id}/retry`, { method: "POST" });
      toast.success(`${r.title} read again: ${receipt.stateLabel.toLowerCase()}`);
      notifyChanged();
    } catch (e) {
      toast.error((e as ApiError).message);
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    setBusy("delete");
    try {
      await api(`/api/receipts/${r.id}`, { method: "DELETE" });
      toast.success(`Deleted ${r.title}`);
      setConfirming(false);
      onDeleted?.();
      notifyChanged();
    } catch (e) {
      toast.error((e as ApiError).message);
    } finally {
      setBusy(null);
    }
  };
  const run = (a: Action) => (a === "match" ? nav.open(r.id, true) : a === "retry" ? void retry() : setConfirming(true));

  const confirm = (
    <AlertDialog open={confirming} onOpenChange={setConfirming}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {r.title}?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the receipt, its stored files and its history here. Nothing changes in FreeAgent. You cannot undo this.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy === "delete"}>Cancel</AlertDialogCancel>
          {/* preventDefault keeps the dialog open until the delete has finished */}
          <AlertDialogAction variant="destructive" onClick={(e) => { e.preventDefault(); void remove(); }} disabled={busy === "delete"}>
            {busy === "delete" && <Loader2Icon className="animate-spin" aria-hidden />}Delete receipt
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return { busy, run, confirm, nav };
}

/**
 * The receipt's one guided action as a button, and everything else it allows in a "⋯" menu.
 * `inDetails` drops "View details" (you are already there) and closes the dialog after a delete.
 */
export function ReceiptActions({ r, inDetails = false, size = "sm" }: { r: ReceiptRow; inDetails?: boolean; size?: "sm" | "default" }) {
  const nav = useReceiptNav();
  const { busy, run, confirm } = useReceiptActions(r, inDetails ? nav.closeAll : undefined);
  const primary = PRIMARY[r.state];
  const others = r.actions.filter((a) => a !== primary?.action);

  return (
    <div className="flex shrink-0 items-center gap-1">
      {primary && (
        <Button
          size={size}
          variant={primary.action === "delete" ? "outline" : "default"}
          className={primary.action === "delete" ? "text-destructive hover:text-destructive" : undefined}
          onClick={() => run(primary.action)}
          disabled={busy !== null}
        >
          {busy === primary.action ? <Loader2Icon className="animate-spin" aria-hidden /> : ICON[primary.action]}
          {primary.label}
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size={size === "sm" ? "icon-sm" : "icon"} variant="ghost" aria-label={`More actions for ${r.title}`} disabled={busy !== null}>
            {busy && busy !== primary?.action ? <Loader2Icon className="animate-spin" aria-hidden /> : <EllipsisIcon aria-hidden />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          {!inDetails && <DropdownMenuItem onSelect={() => nav.open(r.id)}><EyeIcon aria-hidden />View details</DropdownMenuItem>}
          {others.includes("match") && <DropdownMenuItem onSelect={() => run("match")}><LinkIcon aria-hidden />{matchLabel(r)}</DropdownMenuItem>}
          {others.includes("retry") && <DropdownMenuItem onSelect={() => run("retry")}><RotateCwIcon aria-hidden />Read again</DropdownMenuItem>}
          {others.includes("delete") && (
            <>
              {(!inDetails || others.length > 1) && <DropdownMenuSeparator />}
              <DropdownMenuItem variant="destructive" onSelect={() => run("delete")}><Trash2Icon aria-hidden />Delete…</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {confirm}
    </div>
  );
}
