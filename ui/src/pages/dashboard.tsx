import type { ListResponse, ReceiptResponse, ReceiptRow } from "@api";
import { dashboardStats } from "@stats";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, CircleCheckIcon, FileQuestionIcon, InboxIcon, OctagonAlertIcon, SplitIcon, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ReceiptActions } from "@/components/receipt-actions";
import { ErrorAlert, usePageTitle } from "@/components/receipt-bits";
import { ReceiptViewer } from "@/components/receipt-viewer";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { WeeklyTile } from "@/components/weekly-chart";
import { useApi } from "@/lib/api";
import { useReceiptNav } from "@/lib/nav";
import { cn } from "@/lib/utils";

// Dashboard guidance only: an icon and "what to do" steps for the receipts that need you, in the order they are
// worked through. Which receipts need you, their labels and colours come from the API (stage, stateLabel, tone).
const GUIDE: Record<string, { icon: LucideIcon; steps: string[] }> = {
  failed: {
    icon: OctagonAlertIcon,
    steps: ["Open the transaction in FreeAgent and check whether the receipt is attached.", "Not attached: retry. Attached: delete it here; FreeAgent keeps its copy."],
  },
  could_not_read: {
    icon: FileQuestionIcon,
    steps: ["Find the total and the date on the receipt.", "Match it by hand to the payment on your bank lines."],
  },
  needs_choice: {
    icon: SplitIcon,
    steps: ["More than one bank line fits this receipt.", "Choose the one that is really its payment."],
  },
};
const GENERIC_GUIDE = { icon: OctagonAlertIcon, steps: ["Open the receipt to see what it needs."] };
const guideFor = (r: ReceiptRow) => GUIDE[r.state] ?? GENERIC_GUIDE;
const rank = (r: ReceiptRow) => { const i = Object.keys(GUIDE).indexOf(r.state); return i < 0 ? 99 : i; }; // unguided ones last
const bad = (r: ReceiptRow) => r.tone === "bad";
const WAIT_HINT: Record<string, string> = {
  waiting_payment: "For the bank line to appear. Checked every 15 minutes.",
  waiting_explanation: "For you to explain the bank line in FreeAgent.",
};

const money = (minor: number, currency: string) => {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(minor / 100);
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
};

export function DashboardPage() {
  usePageTitle("Dashboard");
  const { data, error, loading, reload } = useApi<ListResponse>("/api/receipts");
  const receipts = data?.receipts ?? [];
  const reading = receipts.filter((r) => r.stage === "reading");

  // Reading receipts move on within seconds; check back while any are in flight.
  useEffect(() => {
    if (!reading.length) return;
    const t = setInterval(reload, 4000);
    return () => clearInterval(t);
  }, [reading.length, reload]);

  return (
    <>
      {error && <ErrorAlert error={error} />}
      {loading && (
        <div className="space-y-6">
          <Skeleton className="h-24 w-full rounded-xl" />
          <div className="flex flex-wrap gap-6"><Skeleton className="h-[28rem] flex-[999_1_560px] rounded-xl" /><Skeleton className="h-[28rem] flex-[1_1_300px] rounded-xl" /></div>
        </div>
      )}
      {data && receipts.length === 0 && <Empty />}
      {data && receipts.length > 0 && <Dashboard receipts={receipts} reading={reading} />}
    </>
  );
}

function Dashboard({ receipts, reading }: { receipts: ReceiptRow[]; reading: ReceiptRow[] }) {
  // Which one is showing: by id, and by place, so that when it is dealt with the next one takes its place.
  const [sel, setSel] = useState<{ id: string | null; pos: number }>({ id: null, pos: 0 });
  // A fixed order (failed, could not read, choices), so moving through them never reshuffles the gallery.
  const needs = receipts.filter((r) => r.stage === "needs_you").sort((a, b) => rank(a) - rank(b));
  const found = needs.findIndex((r) => r.id === sel.id);
  const index = found >= 0 ? found : Math.min(sel.pos, needs.length - 1);
  const select = (i: number) => {
    const j = ((i % needs.length) + needs.length) % needs.length; // wraps at both ends
    setSel({ id: needs[j].id, pos: j });
  };
  const waiting = receipts.filter((r) => r.stage === "waiting");
  const duplicates = receipts.filter((r) => r.stage === "duplicate");

  return (
    <div className="space-y-8">
      <Headline receipts={receipts} needs={needs.length} />
      <div className="flex flex-wrap items-start gap-6">
        {needs.length ? <UpNext items={needs} index={index} onSelect={select} /> : <AllClear />}
        <aside aria-label="Everything else" className="flex min-w-0 flex-[1_1_300px] flex-col gap-4">
          {reading.length > 0 && <ReadingCard items={reading} />}
          {waiting.length > 0 && <WaitingCard items={waiting} />}
          <MonthCard receipts={receipts} />
          <WeeklyTile receipts={receipts} />
          {duplicates.length > 0 && <DuplicateLine items={duplicates} />}
        </aside>
      </div>
    </div>
  );
}

/** The one-line summary and a bar of where every receipt is. */
function Headline({ receipts, needs }: { receipts: ReceiptRow[]; needs: number }) {
  const count = (stage: ReceiptRow["stage"]) => receipts.filter((r) => r.stage === stage).length;
  const parts = [
    { label: "reading", n: count("reading"), color: "var(--viz-1)" },
    { label: needs === 1 ? "needs you" : "need you", n: needs, color: "var(--viz-2)" },
    { label: "waiting", n: count("waiting"), color: "var(--color-neutral-400)" },
    { label: "filed", n: count("filed"), color: "var(--viz-3)" },
  ];
  const onTrack = parts.reduce((t, p) => t + p.n, 0) - needs;
  const shown = parts.filter((p) => p.n > 0);
  return (
    <section aria-labelledby="headline" className="space-y-3">
      <h1 id="headline" className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
        {needs ? `${needs} receipt${needs === 1 ? " needs" : "s need"} you.` : "Nothing needs you."}
        {onTrack > 0 && <>{" "}<span className="text-muted-foreground">{onTrack} {onTrack === 1 ? "is" : "are"} on track.</span></>}
      </h1>
      {/* a thin segmented bar: every part is named, with its count, in the list under it */}
      <div className="flex h-2.5 gap-[3px]" aria-hidden>
        {shown.map((p, i) => (
          <span key={p.label} style={{ flexGrow: p.n, background: p.color }} className={cn("min-w-1.5", i === 0 && "rounded-l-full", i === shown.length - 1 && "rounded-r-full")} />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
        {shown.map((p) => (
          <li key={p.label} className="flex items-center gap-1.5"><span className="size-2.5 rounded-[3px]" style={{ background: p.color }} aria-hidden />{p.n} {p.label}</li>
        ))}
        <li className="ml-auto"><Link to="/queue" className="font-medium underline-offset-4 hover:text-foreground hover:underline">All {receipts.length} in the queue</Link></li>
      </ul>
    </section>
  );
}

const sentence = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** The receipts that need you, one shown in full at a time, with a gallery of all of them under it. */
function UpNext({ items, index, onSelect }: { items: ReceiptRow[]; index: number; onSelect: (i: number) => void }) {
  const total = items.length;
  return (
    <section aria-labelledby="up-next" className="min-w-0 flex-[999_1_560px] overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
      <div className="flex items-center gap-3 border-b px-5 py-3">
        <h2 id="up-next" className="text-sm font-semibold">Up next</h2>
        <span className="text-sm text-muted-foreground" aria-live="polite">{total === 1 ? "The only one that needs you" : `${index + 1} of ${total} that need you`}</span>
        {total > 1 && (
          <span className="ml-auto flex gap-1">
            <Button variant="outline" size="icon-sm" onClick={() => onSelect(index - 1)} aria-label="Previous receipt"><ChevronLeftIcon aria-hidden /></Button>
            <Button variant="outline" size="icon-sm" onClick={() => onSelect(index + 1)} aria-label="Next receipt"><ChevronRightIcon aria-hidden /></Button>
          </span>
        )}
      </div>
      <Focus key={items[index].id} r={items[index]} />
      {total > 1 && <Gallery items={items} index={index} onSelect={onSelect} />}
    </section>
  );
}

/** One receipt in full: the receipt itself, what went wrong, what to do, and the button to do it. */
function Focus({ r }: { r: ReceiptRow }) {
  const { data, error, reload } = useApi<ReceiptResponse>(`/api/receipts/${r.id}`, { live: false });
  const nav = useReceiptNav();
  const Icon = guideFor(r).icon;
  return (
    <div className="flex flex-wrap gap-6 p-5">
      {/* on a phone, what is wrong and the button come first; the receipt follows */}
      <div className="order-2 flex h-[22rem] min-w-0 flex-[1_1_300px] flex-col rounded-lg bg-muted/50 p-3 md:order-1 md:h-[26rem]">
        {data ? <ReceiptViewer files={data.files} email={data.email} className="flex-1" /> : error ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
            <p>The receipt could not be loaded. {error.message}</p>
            <Button variant="outline" size="sm" onClick={reload}>Try again</Button>
          </div>
        ) : <Skeleton className="flex-1" />}
      </div>

      <div className="order-1 flex min-w-0 flex-[1_1_300px] flex-col gap-4 md:order-2">
        <span className={cn(
          "inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold",
          bad(r) ? "bg-destructive text-white" : "bg-amber-500/15 text-amber-800 dark:text-amber-300",
        )}>
          <Icon className="size-3.5" aria-hidden />{r.stateLabel}
        </span>
        <div>
          <h3 className="text-2xl font-semibold tracking-tight break-words">
            <Link {...nav.link(r.id)} className="underline-offset-4 hover:underline">{r.title}</Link>
          </h3>
          <p className="text-sm text-muted-foreground break-words">{r.supplier && r.subject ? `${r.subject} · ` : ""}received {r.received}</p>
        </div>
        {r.totalMinor !== null && <p className="text-3xl font-semibold tracking-tight">{r.amount}</p>}
        {r.reason && (
          <p className={cn("rounded-lg px-3 py-2 text-sm font-medium break-words", bad(r) ? "bg-destructive/10 text-destructive" : "bg-amber-500/10 text-amber-900 dark:text-amber-200")}>
            {sentence(r.reason)}
          </p>
        )}
        <div>
          <h4 className="mb-1.5 text-sm font-semibold">What to do</h4>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-foreground/80">
            {guideFor(r).steps.map((s) => <li key={s}>{s}</li>)}
          </ol>
        </div>
        <ReceiptActions r={r} size="default" />
      </div>
    </div>
  );
}

/** Every receipt that needs you as a swipeable strip; the one showing is outlined and kept in view. */
function Gallery({ items, index, onSelect }: { items: ReceiptRow[]; index: number; onSelect: (i: number) => void }) {
  const strip = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const ul = strip.current;
    const li = ul?.children[index] as HTMLElement | undefined;
    if (!ul || !li) return;
    const pad = 20;
    const out = li.offsetLeft - pad < ul.scrollLeft || li.offsetLeft + li.offsetWidth + pad > ul.scrollLeft + ul.clientWidth;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (out) ul.scrollTo({ left: li.offsetLeft - pad, behavior: still ? "auto" : "smooth" });
  }, [index]);

  return (
    <div className="border-t bg-muted/30 py-4">
      <h3 className="mb-2.5 px-5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">All that need you</h3>
      <ul ref={strip} aria-label="Receipts that need you" className="relative flex snap-x snap-mandatory scroll-px-5 gap-2.5 overflow-x-auto px-5 pt-1 pb-2 [scrollbar-width:thin]">
        {items.map((n, i) => {
          const on = i === index;
          return (
            <li key={n.id} className="w-52 shrink-0 snap-start">
              <button
                type="button"
                onClick={() => onSelect(i)}
                aria-current={on ? "true" : undefined}
                aria-label={`${i + 1} of ${items.length}: ${n.title}, ${n.stateLabel}`}
                className={cn(
                  "flex h-full w-full min-w-0 flex-col gap-0.5 rounded-lg bg-card p-3 text-left ring-1 ring-foreground/10 transition-[background-color,box-shadow] hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  on && "ring-2 ring-foreground",
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className={cn("text-xs font-medium", bad(n) ? "text-destructive" : "text-amber-800 dark:text-amber-300")}>{n.stateLabel}</span>
                  <span className="text-[11px] text-muted-foreground tabular-nums">{i + 1}</span>
                </span>
                <span className="truncate font-medium">{n.title}</span>
                <span className="truncate text-xs text-muted-foreground">{n.reason ? sentence(n.reason) : n.amount}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RailCard({ title, aside, className, children }: { title: string; aside?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className={cn("rounded-xl bg-card p-4 ring-1 ring-foreground/10", className)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">{title}</h2>
        {aside && <span className="text-xs text-muted-foreground">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

const CAP = 3;
/** Splits a side-column list into the first three and the rest, which open in place (Collapse). */
function useCapped<T>(items: T[]) {
  const [all, setAll] = useState(false);
  const extra = Math.max(items.length - CAP, 0);
  return { head: items.slice(0, CAP), rest: items.slice(CAP), open: all, frame: { extra, all, onToggle: () => setAll((a) => !a) } };
}

/** Grows open and fades in, or folds away; while closed its contents cannot be tabbed to. */
function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      inert={!open}
      className={cn("grid transition-[grid-template-rows,opacity] duration-300 ease-out", open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

/** Wraps a side-column card whose list is capped: a "+N more" / "Show fewer" pill sits centred on its bottom border. */
function PillFrame({ extra, all, onToggle, children }: { extra: number; all: boolean; onToggle: () => void; children: ReactNode }) {
  if (!extra) return <>{children}</>;
  return (
    // pb = half the pill's height, so the pill's centre lands on the card's bottom border
    <div className="relative pb-[13px]">
      {children}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={all}
        className="absolute bottom-0 left-1/2 z-[1] flex h-[26px] -translate-x-1/2 items-center gap-1 rounded-full bg-card px-3 text-xs font-medium whitespace-nowrap text-foreground shadow-sm ring-1 ring-foreground/15 transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {all ? "Show fewer" : `+${extra} more`}
        <ChevronDownIcon className={cn("size-3 transition-transform duration-300", all && "rotate-180")} aria-hidden />
      </button>
    </div>
  );
}

function ReadingCard({ items }: { items: ReceiptRow[] }) {
  const nav = useReceiptNav();
  const { head, rest, open, frame } = useCapped(items);
  const row = (r: ReceiptRow, i: number) => (
    <li key={r.id} className="flex items-center gap-3">
      <PrintingReceipt delay={i * 0.45} />
      <div className="min-w-0">
        <Link {...nav.link(r.id)} className="block truncate text-sm font-medium underline-offset-4 hover:underline">{r.title}</Link>
        <p className="text-xs text-blue-700 dark:text-blue-300">Reading<span className="reading-dots" aria-hidden /></p>
      </div>
    </li>
  );
  return (
    <PillFrame {...frame}>
    <div className="reading-frame rounded-[calc(var(--radius-xl)+1px)] p-px">
      <RailCard title="Reading now" aside={items.length} className="ring-0">
        <ul className="space-y-3">{head.map(row)}</ul>
        {rest.length > 0 && <Collapse open={open}><ul className="space-y-3 pt-3">{rest.map((r, i) => row(r, i + CAP))}</ul></Collapse>}
      </RailCard>
    </div>
    </PillFrame>
  );
}

/** A till receipt feeding out of its slot while a scan line reads it. Decorative: the row's text says "Reading". */
function PrintingReceipt({ delay }: { delay: number }) {
  return (
    <span className="relative block h-11 w-9 shrink-0" aria-hidden>
      <span className="absolute inset-x-0 top-0 z-10 h-1.5 rounded-full bg-foreground/80" />
      <span className="receipt-slot absolute inset-x-1 top-1 bottom-0 overflow-hidden">
        <span className="receipt-paper absolute inset-x-px top-0 bottom-px flex flex-col gap-[3px] bg-white px-1 pt-1.5" style={{ animationDelay: `${delay}s` }}>
          <span className="h-[3px] w-3/5 rounded-full bg-neutral-800" />
          <span className="h-[2px] w-full rounded-full bg-neutral-300" />
          <span className="h-[2px] w-4/5 rounded-full bg-neutral-300" />
          <span className="h-[2px] w-full rounded-full bg-neutral-300" />
          <span className="mt-auto mb-2 h-[3px] w-1/2 self-end rounded-full bg-neutral-800" />
          <span className="receipt-scan absolute inset-x-0 top-0 h-2.5" style={{ animationDelay: `${delay}s` }} />
        </span>
      </span>
    </span>
  );
}

function WaitingCard({ items }: { items: ReceiptRow[] }) {
  const nav = useReceiptNav();
  const { head, rest, open, frame } = useCapped(items);
  const row = (r: ReceiptRow) => (
    <li key={r.id} className="flex items-start justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <Link {...nav.link(r.id)} className="block truncate text-sm font-medium underline-offset-4 hover:underline">{r.title}</Link>
        <p className="text-xs text-muted-foreground">{WAIT_HINT[r.state]}</p>
      </div>
      <span className="shrink-0 text-sm font-medium tabular-nums">{r.amount}</span>
    </li>
  );
  return (
    <PillFrame {...frame}>
    <RailCard title="Waiting" aside="nothing to do">
      <ul className="-mb-2.5 divide-y [&>li:first-child]:pt-1">{head.map(row)}</ul>
      {rest.length > 0 && <Collapse open={open}><ul className="mt-2.5 divide-y border-t">{rest.map(row)}</ul></Collapse>}
    </RailCard>
    </PillFrame>
  );
}

function MonthCard({ receipts }: { receipts: ReceiptRow[] }) {
  const s = dashboardStats(receipts, new Date());
  const f = s.filedThisMonth;
  return (
    <Link to="/queue?view=filed" className="block rounded-xl bg-card p-4 ring-1 ring-foreground/10 transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
      <h2 className="mb-2 text-sm font-semibold">{f.monthName}</h2>
      <div className="flex flex-wrap gap-x-8 gap-y-2">
        <div>
          <p className="text-2xl font-semibold tracking-tight">{f.count} filed</p>
          <p className="text-xs text-muted-foreground">{f.totals.length ? f.totals.map((t) => money(t.minor, t.currency)).join(" + ") : "nothing yet"} · {f.lastMonth} in {f.lastMonthName}</p>
        </div>
        <div>
          <p className="text-2xl font-semibold tracking-tight">{s.automatic.share === null ? "–" : `${Math.round(s.automatic.share * 100)}%`}</p>
          <p className="text-xs text-muted-foreground">filed without you</p>
        </div>
      </div>
    </Link>
  );
}

function DuplicateLine({ items }: { items: ReceiptRow[] }) {
  const nav = useReceiptNav();
  return (
    <p className="px-1 text-sm text-muted-foreground">
      {items.length} duplicate{items.length === 1 ? "" : "s"} can go.{" "}
      <Link {...nav.link(items[0].id)} className="font-medium underline underline-offset-4 hover:text-foreground">Review{items.length > 1 ? " the first" : " it"}</Link>
    </p>
  );
}

function AllClear() {
  return (
    <section aria-label="Up next" className="flex min-w-0 flex-[999_1_560px] flex-col items-center justify-center gap-2 rounded-xl bg-card px-6 py-16 text-center ring-1 ring-foreground/10">
      <CircleCheckIcon className="size-10 text-emerald-600 dark:text-emerald-400" aria-hidden />
      <h2 className="text-lg font-semibold">All caught up</h2>
      <p className="max-w-sm text-sm text-muted-foreground">Nothing needs you. The rest file themselves once the bank and FreeAgent catch up.</p>
    </section>
  );
}

function Empty() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl bg-card px-4 py-16 text-center ring-1 ring-foreground/10">
      <InboxIcon className="size-8 text-muted-foreground" aria-hidden />
      <p className="font-medium">No receipts yet</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        Forward a receipt email to the address on the <Link to="/settings" className="underline underline-offset-4">Settings</Link> page.
      </p>
    </div>
  );
}
