import { DownloadIcon, ExternalLinkIcon, FileWarningIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type PdfJs = typeof import("pdfjs-dist");
let pdfjs: Promise<PdfJs> | null = null;
/** pdf.js loads on the first preview only: it is large, and most pages never show a PDF. */
function loadPdfJs() {
  pdfjs ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = worker.default; // served from this origin, so script-src 'self' covers it
    return lib;
  });
  return pdfjs;
}

/**
 * A PDF drawn by pdf.js instead of the browser's own viewer: every page as a white sheet fitted to the width,
 * stacked and scrollable, with our own open and download buttons. Fills its parent's height.
 */
export function PdfPreview({ url, filename, className }: { url: string; filename: string; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [count, setCount] = useState(0);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The file loads once per url (files are served no-store, so a reload would download it again)...
  const [doc, setDoc] = useState<Awaited<ReturnType<PdfJs["getDocument"]>["promise"]> | null>(null);
  useEffect(() => {
    let cancelled = false;
    let task: { destroy: () => Promise<void> } | null = null;
    setState("loading");
    loadPdfJs()
      .then((lib) => {
        const loading = lib.getDocument({ url, useSystemFonts: true, isOffscreenCanvasSupported: false });
        task = loading; // destroying the loading task frees the document and its worker
        return loading.promise;
      })
      .then((pdf) => {
        if (cancelled) return;
        setDoc(pdf);
        setCount(pdf.numPages);
      })
      .catch(() => { if (!cancelled) setState("failed"); });
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [url]);

  // ...and its pages are drawn again only when the width changes.
  useEffect(() => {
    if (!doc || !width) return;
    let cancelled = false;
    const tasks: { cancel: () => void }[] = [];
    (async () => {
      try {
        const sheetWidth = width - 2; // edge to edge inside the 1px border
        const ratio = window.devicePixelRatio || 1;
        const canvases: HTMLCanvasElement[] = [];
        for (let n = 1; n <= doc.numPages && !cancelled; n++) {
          const page = await doc.getPage(n);
          const viewport = page.getViewport({ scale: sheetWidth / page.getViewport({ scale: 1 }).width });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width * ratio);
          canvas.height = Math.floor(viewport.height * ratio);
          canvas.style.width = `${Math.floor(viewport.width)}px`;
          canvas.style.height = `${Math.floor(viewport.height)}px`;
          canvas.setAttribute("role", "img");
          canvas.setAttribute("aria-label", `${filename}, page ${n} of ${doc.numPages}`);
          canvas.className = "block bg-white";
          const task = page.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
          tasks.push(task);
          await task.promise;
          canvases.push(canvas);
        }
        if (cancelled || !pages.current) return;
        pages.current.replaceChildren(...canvases);
        setState("ready");
      } catch (e) {
        if (!cancelled && (e as Error)?.name !== "RenderingCancelledException") setState("failed");
      }
    })();
    return () => {
      cancelled = true;
      for (const t of tasks) t.cancel();
    };
  }, [doc, width, filename]);

  return (
    // one white pane with a border, like the email body: no frame around the page
    <div ref={box} className={cn("group/pdf relative min-h-0 overflow-hidden rounded-lg border bg-white", className)}>
      <div className="h-full overflow-y-auto overscroll-contain">
        {state === "loading" && <Skeleton className="h-full w-full rounded-none bg-neutral-100" />}
        {state === "failed" && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-neutral-500">
            <FileWarningIcon className="size-6" aria-hidden />
            <p>This PDF could not be shown here.</p>
            <a href={url} target="_blank" rel="noopener" className="font-medium text-neutral-900 underline underline-offset-4">Open {filename}</a>
          </div>
        )}
        {/* pages run on, a hairline between them */}
        <div ref={pages} className={cn("flex flex-col divide-y divide-neutral-200", state !== "ready" && "hidden")} />
      </div>
      {state === "ready" && (
        <div className="absolute top-2 right-2 flex items-center gap-1 rounded-lg bg-background/90 p-0.5 opacity-90 shadow-sm ring-1 ring-foreground/10 backdrop-blur transition-opacity group-hover/pdf:opacity-100">
          {count > 1 && <span className="px-1.5 text-xs text-muted-foreground tabular-nums">{count} pages</span>}
          <Button asChild variant="ghost" size="icon-sm" aria-label={`Open ${filename} in a new tab`}>
            <a href={url} target="_blank" rel="noopener"><ExternalLinkIcon aria-hidden /></a>
          </Button>
          <Button asChild variant="ghost" size="icon-sm" aria-label={`Download ${filename}`}>
            <a href={url} download={filename}><DownloadIcon aria-hidden /></a>
          </Button>
        </div>
      )}
    </div>
  );
}
