import { ReceiptTextIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { Link, Route, Routes, useLocation, useNavigate } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { MatchDialog } from "@/dialogs/match-dialog";
import { ReceiptDialog } from "@/dialogs/receipt-dialog";
import { useBackground } from "@/lib/nav";
import { DashboardPage } from "@/pages/dashboard";
import { NotFound } from "@/pages/not-found";
import { QueuePage } from "@/pages/queue";
import { SettingsPage } from "@/pages/settings";

const navClass = (isActive: boolean) =>
  cn("rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-muted hover:text-foreground", isActive ? "text-foreground" : "text-muted-foreground");

// The test-data switcher: only on a local dev server, so a deployed app never even fetches its code.
const LOCAL = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const DevPanel = LOCAL ? lazy(() => import("@/dev/dev-panel")) : null;

const NAV: [string, string, (path: string) => boolean][] = [
  ["/", "Dashboard", (p) => p === "/" || p.startsWith("/receipts/")],
  ["/queue", "Queue", (p) => p === "/queue"],
  ["/settings", "Settings", (p) => p === "/settings"],
];

/** Where a path sits in the nav order; a receipt dialog's path counts as the dashboard under it. */
const navIndex = (path: string) => Math.max(0, NAV.findIndex(([, , on]) => on(path)));

/**
 * Follows a nav link inside a view transition, so the page under the header slides out one side and the next page
 * in from the other (index.css). A new-tab click, no View Transitions, or reduced motion: a plain navigation.
 */
function usePageSwipe(from: string) {
  const navigate = useNavigate();
  return (to: string) => (e: React.MouseEvent) => {
    const doc = document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };
    const plain = e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
    if (plain || !doc.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const a = navIndex(from), b = navIndex(to);
    if (a === b) return; // same page: no slide
    e.preventDefault();
    document.documentElement.dataset.swipe = b < a ? "prev" : "next";
    doc.startViewTransition(() => flushSync(() => navigate(to))).finished.finally(() => { delete document.documentElement.dataset.swipe; });
  };
}

export default function App() {
  const location = useLocation();
  // A receipt dialog opens over the page it came from; a deep link (an email) opens it over the dashboard.
  const background = useBackground();
  const page = background ?? location;
  const { pathname } = page;
  const main = useRef<HTMLElement>(null);
  const swipeTo = usePageSwipe(pathname);
  const shown = useRef(pathname);
  // A client route change keeps the old scroll position and focus; reset both, as a page load would.
  useEffect(() => {
    if (shown.current === pathname) return; // first render (twice under StrictMode)
    shown.current = pathname;
    window.scrollTo(0, 0);
    main.current?.focus({ preventScroll: true });
  }, [pathname]);

  return (
    <div className="min-h-svh bg-muted/40">
      <a href="#main" className="sr-only rounded-md bg-background text-sm font-medium shadow focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:px-3 focus:py-2">Skip to content</a>
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-4 px-4">
          <Link to="/" onClick={swipeTo("/")} aria-label="Receipt filer, dashboard" className="mr-auto flex items-center gap-2 font-semibold">
            <ReceiptTextIcon className="size-5" aria-hidden />
            <span className="hidden sm:inline">Receipt filer</span>
          </Link>
          <nav aria-label="Main" className="flex gap-1">
            {/* active by the page under any dialog, not the dialog's own address */}
            {NAV.map(([to, label, on]) => (
              <Link key={to} to={to} onClick={swipeTo(to)} className={navClass(on(pathname))} aria-current={on(pathname) ? "page" : undefined}>{label}</Link>
            ))}
          </nav>
        </div>
      </header>
      <main id="main" ref={main} tabIndex={-1} className="mx-auto max-w-5xl px-4 py-6 pb-16 outline-none">
        <Routes location={page}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/queue" element={<QueuePage />} />
          <Route path="/receipts/*" element={<DashboardPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <Routes>
        <Route path="/receipts/:id" element={<ReceiptDialog />} />
        <Route path="/receipts/:id/match" element={<MatchDialog />} />
        <Route path="*" element={null} />
      </Routes>
      <Toaster position="bottom-right" richColors />
      {DevPanel && <Suspense fallback={null}><DevPanel /></Suspense>}
    </div>
  );
}
