import type { ReceiptRow } from "@api";
import { weeklyByStatus, type StatusGroup, type WeekBucket } from "@stats";
import { TableIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const WEEKS = 10;
// Bottom of the stack first. Colours are fixed per series (dataviz categorical slots 1-3, validated for
// both themes on the card surface). The light filed green is under 3:1, so the numbers also have a table.
const SERIES: { key: StatusGroup; label: string; color: string }[] = [
  { key: "filed", label: "Filed", color: "var(--viz-3)" },
  { key: "inProgress", label: "In progress", color: "var(--viz-1)" },
  { key: "needsYou", label: "Needs you", color: "var(--viz-2)" },
];
// No legend in the tile, by request: the tooltip and the table name every series.
const PLOT_H = 96, AXIS_H = 14, GAP = 2, BAR_MAX = 18, RADIUS = 3;

const shortDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const weekName = (b: WeekBucket, last: boolean) => (last ? "This week" : `Week of ${shortDate(b.start)}`);
/** A column segment: square at the bottom, rounded corners only on the top of the stack. */
function segment(x: number, w: number, yTop: number, yBottom: number, rounded: boolean) {
  const r = rounded ? Math.min(RADIUS, yBottom - yTop, w / 2) : 0;
  return `M${x},${yBottom}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + w - r}Q${x + w},${yTop} ${x + w},${yTop + r}V${yBottom}Z`;
}

/** A stat-tile-sized stacked column chart: receipts received per week, by where each one is now. */
export function WeeklyTile({ receipts, className }: { receipts: ReceiptRow[]; className?: string }) {
  const weeks = weeklyByStatus(receipts, new Date(), WEEKS);
  const [active, setActive] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth); // before the first paint
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const yMax = Math.max(4, ...weeks.map((w) => w.total));
  const band = width / WEEKS;
  const barW = Math.min(BAR_MAX, band * 0.6);
  const y = (v: number) => PLOT_H - (v / yMax) * PLOT_H;
  const tip = active === null ? null : weeks[active];
  // The average leaves out this week: it is not over yet, so it would drag the line down.
  const full = weeks.slice(0, -1);
  const avg = full.reduce((t, w) => t + w.total, 0) / full.length;
  const avgText = avg.toFixed(1).replace(/\.0$/, "");

  return (
    <div className={cn("@container flex flex-col gap-1.5 rounded-xl bg-card px-4 py-3.5 text-card-foreground ring-1 ring-foreground/10", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <span className="mr-auto text-sm whitespace-nowrap text-muted-foreground">Receipts per week</span>
        {avg > 0 && (
          <span className="order-last flex basis-full items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground @sm:order-none @sm:basis-auto">
            <svg width="14" height="2" aria-hidden><line x1="0" x2="14" y1="1" y2="1" className="stroke-foreground/50" strokeWidth={1.5} strokeDasharray="2 2" /></svg>
            {avgText} a week on average
          </span>
        )}
        <Button variant="ghost" size="icon-xs" className="-my-1 -mr-1.5 text-muted-foreground" onClick={() => setTable(true)} aria-label="Show the numbers as a table">
          <TableIcon aria-hidden />
        </Button>
      </div>
      <div ref={box} className="relative mt-auto" onPointerLeave={() => setActive(null)}>
        {width > 0 && (
          <svg width={width} height={PLOT_H + AXIS_H} role="img" aria-label={`Receipts received per week, last ${WEEKS} weeks, ${avgText} a week on average. Use the table button for the numbers.`} className="block overflow-visible">
            <line x1={0} x2={width} y1={PLOT_H} y2={PLOT_H} className="stroke-foreground/20" shapeRendering="crispEdges" />
            {weeks.map((w, i) => {
              const x = i * band + (band - barW) / 2;
              const shown = SERIES.filter((s) => w[s.key] > 0);
              let base = 0;
              return (
                <g key={w.start} className={cn("transition-opacity", active !== null && active !== i && "opacity-40")}>
                  {shown.map((s, j) => {
                    const yBottom = y(base) - (j > 0 ? GAP : 0); // the 2px surface gap between segments
                    base += w[s.key];
                    const yTop = y(base);
                    return yBottom - yTop > 0.5 && <path key={s.key} d={segment(x, barW, yTop, yBottom, j === shown.length - 1)} style={{ fill: s.color }} />;
                  })}
                  {/* the whole week's band is the hover and focus target */}
                  <rect
                    x={i * band} y={0} width={band} height={PLOT_H} fill="transparent" tabIndex={0}
                    aria-label={`${weekName(w, i === WEEKS - 1)}: ${w.total} receipts, ${SERIES.map((s) => `${w[s.key]} ${s.label.toLowerCase()}`).join(", ")}`}
                    onPointerEnter={() => setActive(i)} onFocus={() => setActive(i)} onBlur={() => setActive(null)}
                    className="outline-none focus-visible:stroke-ring focus-visible:stroke-2"
                  />
                </g>
              );
            })}
            {avg > 0 && (
              <line x1={0} x2={width} y1={y(avg)} y2={y(avg)} className="pointer-events-none stroke-foreground/50" strokeWidth={1.5} strokeDasharray="2 3" strokeLinecap="round" />
            )}
            <text x={0} y={PLOT_H + 12} className="fill-muted-foreground text-[10px]">{shortDate(weeks[0].start)}</text>
            <text x={width} y={PLOT_H + 12} textAnchor="end" className="fill-muted-foreground text-[10px]">This week</text>
          </svg>
        )}
        {tip && active !== null && (
          <div
            role="presentation"
            className="pointer-events-none absolute top-0 z-10 w-40 rounded-lg bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10"
            // inside the plot, beside the column: to its left when there is room, else to its right
            style={{ left: active * band + (band - barW) / 2 - 8 - 160 >= 0 ? active * band + (band - barW) / 2 - 8 - 160 : active * band + (band + barW) / 2 + 8 }}
          >
            <p className="mb-1 text-muted-foreground">{weekName(tip, active === WEEKS - 1)}</p>
            {[...SERIES].reverse().map((s) => (
              <p key={s.key} className="flex items-center gap-2">
                <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} aria-hidden />
                <span className="text-muted-foreground">{s.label}</span>
                <span className="ml-auto font-semibold tabular-nums">{tip[s.key]}</span>
              </p>
            ))}
          </div>
        )}
      </div>
      <Dialog open={table} onOpenChange={setTable}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Receipts per week</DialogTitle>
            <DialogDescription>Received in the last {WEEKS} weeks, by where each one is now. Duplicates left out. {avgText} a week on average over the {full.length} full weeks.</DialogDescription>
          </DialogHeader>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th scope="col" className="py-1.5 pr-3 font-medium">Week</th>
                {SERIES.map((s) => <th key={s.key} scope="col" className="py-1.5 pr-3 text-right font-medium">{s.label}</th>)}
                <th scope="col" className="py-1.5 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {weeks.map((w, i) => (
                <tr key={w.start} className="border-b last:border-0">
                  <th scope="row" className="py-1.5 pr-3 text-left font-normal">{weekName(w, i === WEEKS - 1)}</th>
                  {SERIES.map((s) => <td key={s.key} className="py-1.5 pr-3 text-right">{w[s.key]}</td>)}
                  <td className="py-1.5 text-right font-medium">{w.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </DialogContent>
      </Dialog>
    </div>
  );
}
