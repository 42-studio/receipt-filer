import { getSetting, setSetting } from "../db";
import { ATTACH_BATCH, type Env } from "../env";

export interface BankLine { url: string; datedOn: string; amountMinor: number; description: string; explanations: { url: string; grossMinor: number }[]; }
/** Network error, 429 or 5xx: try again later. `url` is the request that failed; `status` is absent for a network error. */
export class FreeAgentUnavailable extends Error {
  constructor(message: string, readonly url?: string, readonly status?: number) { super(message); }
}
/** An attach POST was sent but its outcome is unknown, so FreeAgent may have saved files. Never retry on its own. */
export class AttachUnconfirmed extends Error {
  constructor(message: string, readonly attachmentUrls: string[]) { super(message); }
}
/** Not connected or the refresh was refused: Josh must sign in again. */
export class FreeAgentAuthError extends Error {}

const TOKENS_KEY = "freeagent_tokens";
const REFRESH_MARGIN_MS = 60_000;
const HEADERS = { "X-Api-Version": "2026-09-01", Accept: "application/json", "User-Agent": "receipt-filer/0.1" };
interface Tokens { access_token: string; refresh_token: string; expires_at: number }

const readTokens = async (env: Env): Promise<Tokens | null> => {
  const raw = await getSetting(env.DB, TOKENS_KEY);
  return raw ? (JSON.parse(raw) as Tokens) : null;
};

async function send(url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { ...HEADERS, ...init.headers } });
  } catch (e) {
    throw new FreeAgentUnavailable(`FreeAgent unreachable: ${e}`, url);
  }
  if (res.status === 429 || res.status >= 500) throw new FreeAgentUnavailable(`FreeAgent ${res.status}: ${await res.text()}`, url, res.status);
  return res;
}

async function tokenCall(env: Env, params: Record<string, string>): Promise<void> {
  const res = await send(`${env.FREEAGENT_BASE_URL}/token_endpoint`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${env.FREEAGENT_CLIENT_ID}:${env.FREEAGENT_CLIENT_SECRET}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new FreeAgentAuthError(`FreeAgent refused the token request (${res.status}): ${await res.text()}`);
  const t = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  await setSetting(env.DB, TOKENS_KEY, JSON.stringify({ access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expires_in * 1000 } satisfies Tokens));
}

export function authoriseUrl(env: Env, state: string, redirectUri: string): string {
  const q = new URLSearchParams({ client_id: env.FREEAGENT_CLIENT_ID, response_type: "code", redirect_uri: redirectUri, state });
  return `${env.FREEAGENT_BASE_URL}/approve_app?${q}`;
}

export const exchangeCode = (env: Env, code: string, redirectUri: string) =>
  tokenCall(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri });

export async function isConnected(env: Env): Promise<boolean> {
  return (await readTokens(env)) !== null;
}

// One refresh at a time per isolate. shortcut: no cross-isolate lock, the re-read below covers a refresh finished elsewhere.
let inflight: Promise<Tokens> | null = null;

/** Refreshes `used`, unless the stored refresh token already differs (another isolate refreshed): then returns the stored tokens. */
function refresh(env: Env, used: Tokens): Promise<Tokens> {
  inflight ??= (async () => {
    const stored = await readTokens(env);
    if (!stored) throw new FreeAgentAuthError("FreeAgent is not connected");
    if (stored.refresh_token !== used.refresh_token) return stored;
    try {
      await tokenCall(env, { grant_type: "refresh_token", refresh_token: used.refresh_token });
    } catch (e) {
      if (!(e instanceof FreeAgentAuthError)) throw e;
      // A refusal can mean another isolate rotated the token a moment ago: use its tokens.
      const now = await readTokens(env);
      if (now && now.refresh_token !== used.refresh_token) return now;
      throw e;
    }
    return (await readTokens(env))!;
  })().finally(() => (inflight = null));
  return inflight;
}

async function validTokens(env: Env): Promise<Tokens> {
  const t = await readTokens(env);
  if (!t) throw new FreeAgentAuthError("FreeAgent is not connected");
  return t.expires_at - Date.now() > REFRESH_MARGIN_MS ? t : refresh(env, t);
}

/** Authenticated call. A 401 refreshes once and retries once. Returns any other status for the caller to judge. */
async function api(env: Env, url: string, init: RequestInit = {}): Promise<Response> {
  let t = await validTokens(env);
  for (let attempt = 0; ; attempt++) {
    const res = await send(url, { ...init, headers: { Authorization: `Bearer ${t.access_token}`, ...init.headers } });
    if (res.status !== 401) return res;
    if (attempt === 1) throw new FreeAgentAuthError("FreeAgent rejected the access token after a refresh");
    t = await refresh(env, t);
  }
}

const fail = async (res: Response): Promise<never> => { throw new Error(`FreeAgent ${res.status}: ${await res.text()}`); };
const getJson = async <T>(env: Env, url: string): Promise<T> => {
  const res = await api(env, url);
  return res.ok ? ((await res.json()) as T) : fail(res);
};

// Never send the bearer token to a URL that is not under the FreeAgent base URL.
const own = (env: Env, url: string) => {
  if (!url.startsWith(`${env.FREEAGENT_BASE_URL}/`)) throw new Error(`Refusing URL outside FreeAgent: ${url}`);
  return url;
};

const minor = (s: string) => Math.round(parseFloat(s) * 100) || 0; // `|| 0` turns -0 into 0
interface RawTx { url: string; amount: string; dated_on: string; description?: string; bank_transaction_explanations?: { url: string; gross_value: string }[] }
const toLine = (t: RawTx): BankLine => ({
  url: t.url, datedOn: t.dated_on, amountMinor: minor(t.amount), description: t.description ?? "",
  explanations: (t.bank_transaction_explanations ?? []).map((e) => ({ url: e.url, grossMinor: minor(e.gross_value) })),
});

export async function listBankLines(env: Env, fromDate: string): Promise<BankLine[]> {
  const accounts = (await getJson<{ bank_accounts: { url: string; status: string }[] }>(env, `${env.FREEAGENT_BASE_URL}/bank_accounts`)).bank_accounts;
  const lines: BankLine[] = [];
  for (const a of accounts.filter((a) => a.status === "active")) {
    for (let page = 1; ; page++) {
      const q = new URLSearchParams({ bank_account: a.url, from_date: fromDate, per_page: "100", page: String(page) });
      const txs = (await getJson<{ bank_transactions: RawTx[] }>(env, `${env.FREEAGENT_BASE_URL}/bank_transactions?${q}`)).bank_transactions;
      lines.push(...txs.map(toLine));
      if (txs.length < 100) break;
    }
  }
  return lines;
}

export async function getBankLine(env: Env, url: string): Promise<BankLine | null> {
  const res = await api(env, own(env, url));
  if (res.status === 404) return null;
  if (!res.ok) await fail(res);
  return toLine(((await res.json()) as { bank_transaction: RawTx }).bank_transaction);
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function attach(env: Env, explanationUrl: string, files: { filename: string; contentType: string; data: Uint8Array }[]): Promise<string[]> {
  own(env, explanationUrl);
  const post = `${explanationUrl}/attachments`;
  const urls: string[] = [];
  const unconfirmed = (e: unknown) => new AttachUnconfirmed(`FreeAgent did not confirm the attachment: ${e instanceof Error ? e.message : String(e)}`, [...urls]);
  for (let i = 0; i < files.length; i += ATTACH_BATCH) {
    const attachments = files.slice(i, i + ATTACH_BATCH).map((f) => ({ data: base64(f.data), file_name: f.filename, content_type: f.contentType, description: f.filename }));
    let res: Response;
    try {
      res = await api(env, post, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ attachments }) });
    } catch (e) {
      // Nothing is saved when the POST was never sent (token, auth) or got a 429; a network error or 5xx on the POST may have saved it.
      const unknown = e instanceof FreeAgentUnavailable && e.url === post && e.status !== 429;
      throw urls.length || unknown ? unconfirmed(e) : e;
    }
    if (!res.ok) await fail(res).catch((e) => { throw urls.length ? unconfirmed(e) : e; });
    try {
      urls.push(...((await res.json()) as { attachments: { url: string }[] }).attachments.map((a) => a.url));
    } catch (e) {
      throw unconfirmed(e); // a 2xx whose body cannot be read: the files are probably saved
    }
  }
  return urls;
}

/** The explanation of equal value first, else the largest; null when the line has none. */
export function pickExplanation(line: BankLine, totalMinor: number): string | null {
  const abs = line.explanations.map((e) => ({ url: e.url, v: Math.abs(e.grossMinor) }));
  return (abs.find((e) => e.v === Math.abs(totalMinor)) ?? abs.sort((a, b) => b.v - a.v)[0])?.url ?? null;
}
