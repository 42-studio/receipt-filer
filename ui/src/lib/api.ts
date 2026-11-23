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

/**
 * Loads a GET endpoint; reload() fetches it again, keeping the old data on screen meanwhile. Reloads after notifyChanged().
 * Data and errors belong to the path they came from: a new path shows nothing (loading) until its own answer arrives.
 */
export function useApi<T>(path: string, { live = true }: { live?: boolean } = {}) {
  const [result, setResult] = useState<{ path: string; data: T | null; error: ApiError | null }>({ path, data: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let current = true;
    api<T>(path).then(
      (d) => { if (current) setResult({ path, data: d, error: null }); },
      (e: unknown) => {
        const error = e instanceof ApiError ? e : new ApiError(String(e), 0);
        // a failed reload keeps this path's data; a failed new path shows only its error
        if (current) setResult((r) => ({ path, data: r.path === path ? r.data : null, error }));
      },
    );
    return () => { current = false; };
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!live) return; // live: false, for data that a change elsewhere cannot alter
    window.addEventListener(CHANGED, reload);
    return () => window.removeEventListener(CHANGED, reload);
  }, [reload, live]);
  const mine = result.path === path;
  const data = mine ? result.data : null;
  const error = mine ? result.error : null;
  return { data, error, reload, loading: data === null && error === null };
}
