import { useCallback, useEffect, useState } from "react";

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

/** Calls the Worker API; a non-2xx answer throws with the server's plain-English message. */
export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(path, {
    ...rest,
    headers: { Accept: "application/json", ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...rest.headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError((body as { error?: string } | null)?.error ?? `Request failed (${res.status}).`, res.status);
  return body as T;
}

const CHANGED = "receipts:changed";
/** Tells every open view that receipts changed, so each reloads what it shows. */
// Deferred: a dialog that just closed itself must unmount before the views reload.
export const notifyChanged = () => setTimeout(() => window.dispatchEvent(new Event(CHANGED)));

/** Loads a GET endpoint; reload() fetches it again, keeping the old data on screen meanwhile. Reloads after notifyChanged(). */
export function useApi<T>(path: string, { live = true }: { live?: boolean } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    api<T>(path).then(
      (d) => { if (live) { setData(d); setError(null); } },
      (e: unknown) => { if (live) setError(e instanceof ApiError ? e : new ApiError(String(e), 0)); },
    );
    return () => { live = false; };
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!live) return; // live: false, for data that a change elsewhere cannot alter
    window.addEventListener(CHANGED, reload);
    return () => window.removeEventListener(CHANGED, reload);
  }, [reload, live]);
  return { data, error, reload, loading: data === null && error === null };
}
