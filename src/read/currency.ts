const KNOWN: Record<string, string> = { "£": "GBP", GBP: "GBP", $: "USD", "US$": "USD", USD: "USD", "€": "EUR", EUR: "EUR" };

export function toCurrency(symbolOrCode: string | null): string {
  const s = (symbolOrCode ?? "").trim().toUpperCase();
  return s ? (KNOWN[s] ?? s) : "GBP";
}
