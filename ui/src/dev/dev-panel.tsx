// The UI playground's data switcher. Loaded only on localhost (App.tsx), and it shows only when the
// dev worker (dev/worker.ts) answers /__scenarios with JSON: the real Worker answers with the app page.
import { CheckIcon, FlaskConicalIcon, Loader2Icon, MailPlusIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { notifyChanged } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Scenario { id: string; label: string; description: string }
interface ScenarioList { current: string | null; scenarios: Scenario[] }

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  if (!res.headers.get("Content-Type")?.includes("application/json")) throw new Error("not the dev worker");
  return (await res.json()) as T;
}

export default function DevPanel() {
  const [list, setList] = useState<ScenarioList | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const navigate = useNavigate();
  const { pathname } = useLocation();

  useEffect(() => {
    getJson<ScenarioList>("/__scenarios").then(setList, () => setList(null));
  }, []);
  if (!list) return null;

  const load = async (id: string) => {
    setBusy(id);
    try {
      const { current } = await getJson<{ current: string }>(`/__scenario?name=${encodeURIComponent(id)}`);
      setList((l) => l && { ...l, current });
      if (pathname.startsWith("/receipts/")) navigate("/"); // the open receipt no longer exists
      notifyChanged();
      toast.success(`Data: ${list.scenarios.find((s) => s.id === current)?.label ?? current}`);
    } catch (e) {
      toast.error(`Could not load the scenario: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };
  const arrive = async () => {
    setBusy("new");
    try {
      await getJson("/__new");
      notifyChanged();
      toast.success("A new receipt arrived; it finishes reading in about 8 seconds");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const current = list.scenarios.find((s) => s.id === list.current);

  return (
    <div className="fixed bottom-4 left-4 z-40 flex flex-col items-start gap-2">
      {open && (
        <section aria-label="Dev data" className="flex max-h-[min(36rem,calc(100svh-6rem))] w-[22rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border-2 border-dashed border-violet-500/50 bg-popover text-popover-foreground shadow-xl">
          <div className="flex items-center gap-2 border-b px-3 py-2.5">
            <span className="rounded bg-violet-600 px-1.5 text-[10px] leading-4 font-bold tracking-wide text-white">DEV</span>
            <h2 className="text-sm font-semibold">Test data</h2>
            <span className="ml-auto text-xs text-muted-foreground">local only</span>
            <Button variant="ghost" size="icon-xs" onClick={() => setOpen(false)} aria-label="Close the dev panel"><XIcon aria-hidden /></Button>
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto p-1.5" aria-label="Scenarios">
            {list.scenarios.map((s) => {
              const on = s.id === list.current;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    aria-pressed={on}
                    disabled={busy !== null}
                    onClick={() => load(s.id)}
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60",
                      on && "bg-violet-500/10",
                    )}
                  >
                    <span className="mt-0.5 grid size-4 shrink-0 place-items-center" aria-hidden>
                      {busy === s.id ? <Loader2Icon className="size-4 animate-spin" /> : on ? <CheckIcon className="size-4 text-violet-600 dark:text-violet-400" /> : null}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{s.label}</span>
                      <span className="block text-xs text-muted-foreground">{s.description}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap gap-2 border-t p-2.5">
            <Button size="sm" variant="outline" onClick={arrive} disabled={busy !== null}>
              {busy === "new" ? <Loader2Icon className="animate-spin" aria-hidden /> : <MailPlusIcon aria-hidden />}Email in a receipt
            </Button>
            <Button size="sm" variant="ghost" onClick={() => current && load(current.id)} disabled={busy !== null || !current}>
              <RotateCcwIcon aria-hidden />Reload
            </Button>
          </div>
        </section>
      )}
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="border-dashed border-violet-500/60 bg-popover shadow-md"
      >
        <FlaskConicalIcon className="text-violet-600 dark:text-violet-400" aria-hidden />
        {current?.label ?? "Test data"}
      </Button>
    </div>
  );
}
