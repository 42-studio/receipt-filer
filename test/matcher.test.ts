import { describe, expect, it } from "vitest";
import type { BankLine } from "../src/freeagent/client";
import { decide } from "../src/match/matcher";

const line = (date: string, amountMinor: number, description: string, url = `https://fa/tx/${date}/${amountMinor}/${description}`): BankLine =>
  ({ url, datedOn: date, amountMinor, description, explanations: [] });
const none = new Set<string>();
const r = (o = {}) => ({ totalMinor: 2400, currency: "GBP", date: "2026-11-10", supplier: "Northwind Hosting" as string | null, confidence: 0.9, inputKind: "text" as "text" | "image", ...o });
const usd = (o = {}) => r({ totalMinor: 1500, currency: "USD", date: "2026-11-09", ...o });

describe("pound receipts", () => {
  it("matches one exact line inside the window", () => expect(decide(r(), [line("2026-11-12", -2400, "NORTHWIND")], none, null).kind).toBe("match"));
  it.each([["2026-11-05", "match"], ["2026-11-04", "none"], ["2026-12-01", "match"], ["2026-12-02", "none"]])(
    "pound window: line on %s is %s", (d, k) => expect(decide(r(), [line(d, -2400, "X")], none, null).kind).toBe(k));
  it("ignores a different amount, a money-in line and a used line", () => {
    expect(decide(r(), [line("2026-11-10", -2401, "X"), line("2026-11-10", 2400, "X")], none, null).kind).toBe("none");
    const l = line("2026-11-10", -2400, "X");
    expect(decide(r(), [l], new Set([l.url]), null).kind).toBe("none");
  });
  it("matches a refund to the money-in line", () => expect(decide(r({ totalMinor: -4500 }), [line("2026-11-10", 4500, "REFUND"), line("2026-11-10", -4500, "X")], none, null)).toMatchObject({ kind: "match", line: { amountMinor: 4500 } }));
  it("asks when two lines fit and the supplier does not separate them", () => expect(decide(r(), [line("2026-11-10", -2400, "A"), line("2026-11-11", -2400, "B")], none, null).kind).toBe("choice"));
  it("asks when two identical twins fit", () => {
    const d = decide(r({ supplier: null }), [line("2026-11-10", -2400, "X", "u1"), line("2026-11-10", -2400, "X", "u2")], none, null);
    expect(d).toMatchObject({ kind: "choice" });
    expect(d.kind === "choice" && d.lines).toHaveLength(2);
  });
  it("asks when both candidates match the supplier", () =>
    expect(decide(r(), [line("2026-11-10", -2400, "NORTHWIND HOSTING", "a"), line("2026-11-11", -2400, "NORTHWIND HOSTING", "b")], none, null).kind).toBe("choice"));
  it("uses the supplier name as a tie-breaker for text receipts only", () => {
    const two = [line("2026-11-10", -2400, "NORTHWIND HOSTING LTD"), line("2026-11-11", -2400, "OTHER")];
    expect(decide(r(), two, none, null).kind).toBe("match");
    expect(decide(r({ inputKind: "image", supplier: null }), two, none, null).kind).toBe("choice");
    expect(decide(r({ inputKind: "image" }), two, none, null).kind).toBe("choice");
  });
  it("drops company suffixes and short words from the supplier", () => {
    const two = [line("2026-11-10", -2400, "ACME SERVICES"), line("2026-11-11", -2400, "OTHER")];
    expect(decide(r({ supplier: "Acme Services Ltd" }), two, none, null).kind).toBe("match");
    expect(decide(r({ supplier: "Acme Services Limited Inc" }), two, none, null).kind).toBe("match");
    expect(decide(r({ supplier: "AB Acme Services" }), two, none, null).kind).toBe("match");
  });
  it("skips the tie-breaker when no supplier words are left", () => {
    const two = [line("2026-11-10", -2400, "LTD"), line("2026-11-11", -2400, "OTHER")];
    expect(decide(r({ supplier: "Ltd" }), two, none, null).kind).toBe("choice");
    expect(decide(r({ supplier: "" }), two, none, null).kind).toBe("choice");
    expect(decide(r({ supplier: "Co" }), two, none, null).kind).toBe("choice");
  });
  it("asks for confirmation when confidence is under 0.7", () => {
    expect(decide(r({ confidence: 0.69 }), [line("2026-11-10", -2400, "X")], none, null)).toMatchObject({ kind: "choice", lines: [expect.anything()] });
    expect(decide(r({ confidence: 0.7 }), [line("2026-11-10", -2400, "X")], none, null).kind).toBe("match");
  });
  it("tries the swapped date when day and month are both 12 or less", () => {
    expect(decide(r({ date: "2026-03-04" }), [line("2026-04-03", -2400, "X")], none, null).kind).toBe("match");
    expect(decide(r({ date: "2026-03-14" }), [line("2026-04-20", -2400, "X")], none, null).kind).toBe("none");
    expect(decide(r({ date: "2026-03-03" }), [line("2026-04-20", -2400, "X")], none, null).kind).toBe("none");
  });
  it("does not duplicate a line that fits both the real and the swapped date", () =>
    expect(decide(r({ date: "2026-03-04" }), [line("2026-03-20", -2400, "X")], none, null).kind).toBe("match"));
});

describe("foreign receipts", () => {
  it("matches a foreign receipt by the amount written in the description", () => {
    expect(decide(usd(), [line("2026-11-10", -1193, "FIGMA USD 15.00")], none, null).kind).toBe("match");
    expect(decide(usd(), [line("2026-11-10", -1193, "FIGMA REF 15.00")], none, null).kind).toBe("none");
  });
  it.each(["USD 15.00", "USD15.00", "15.00 USD", "15.00USD", "$15.00", "US$15.00", "usd 15.00", "$ 15.00"])("accepts description %s", (d) =>
    expect(decide(usd(), [line("2026-11-10", -1193, `FIGMA ${d}`)], none, null).kind).toBe("match"));
  it.each(["USD 115.00", "USD 15.001", "USD 1,15.00", "USD 15.00.5", "15.0 USD", "EUR 15.00", "USD 15.5"])("rejects description %s", (d) =>
    expect(decide(usd(), [line("2026-11-10", -1193, `FIGMA ${d}`)], none, null).kind).toBe("none"));
  it("accepts a trailing full stop after the amount", () =>
    expect(decide(usd(), [line("2026-11-10", -1193, "FIGMA USD 15.00.")], none, null).kind).toBe("match"));
  it("understands euro symbol and code, and other codes by code only", () => {
    const eur = (o = {}) => usd({ currency: "EUR", ...o });
    expect(decide(eur(), [line("2026-11-10", -1300, "SHOP €15.00")], none, null).kind).toBe("match");
    expect(decide(eur(), [line("2026-11-10", -1300, "SHOP 15.00 EUR")], none, null).kind).toBe("match");
    expect(decide(eur(), [line("2026-11-10", -1300, "SHOP $15.00")], none, null).kind).toBe("none");
    expect(decide(usd({ currency: "CAD" }), [line("2026-11-10", -1100, "SHOP CAD 15.00")], none, null).kind).toBe("match");
    expect(decide(usd({ currency: "CAD" }), [line("2026-11-10", -1100, "SHOP $15.00")], none, null).kind).toBe("none");
  });
  it("prefers description matches over the converted-amount fallback", () => {
    const d = decide(usd(), [line("2026-11-10", -1193, "FIGMA USD 15.00", "a"), line("2026-11-10", -1170, "OTHER", "b")], none, 0.78);
    expect(d).toMatchObject({ kind: "match", line: { url: "a" } });
  });
  it("matches a foreign receipt within 4% of the converted amount", () => {
    expect(decide(usd(), [line("2026-11-10", -1216, "FIGMA")], none, 0.78).kind).toBe("match");
    expect(decide(usd(), [line("2026-11-10", -1218, "FIGMA")], none, 0.78).kind).toBe("none");
  });
  it("tolerance edge is inclusive at exactly 4%", () => {
    // 2500 cents * 0.8 = 2000 pence; 4% = 80
    const u = usd({ totalMinor: 2500 });
    expect(decide(u, [line("2026-11-10", -2080, "X")], none, 0.8).kind).toBe("match");
    expect(decide(u, [line("2026-11-10", -1920, "X")], none, 0.8).kind).toBe("match");
    expect(decide(u, [line("2026-11-10", -2081, "X")], none, 0.8).kind).toBe("none");
    expect(decide(u, [line("2026-11-10", -1919, "X")], none, 0.8).kind).toBe("none");
  });
  it.each([["2026-11-06", "match"], ["2026-11-05", "none"], ["2026-11-16", "match"], ["2026-11-17", "none"]])(
    "foreign window (rate): line on %s is %s", (d, k) => expect(decide(usd(), [line(d, -1170, "X")], none, 0.78).kind).toBe(k));
  it.each([["2026-11-06", "match"], ["2026-11-05", "none"], ["2026-11-16", "match"], ["2026-11-17", "none"]])(
    "foreign window (description): line on %s is %s", (d, k) => expect(decide(usd(), [line(d, -1170, "USD 15.00")], none, null).kind).toBe(k));
  it("returns none when no rate is known and no description matches", () => expect(decide(usd(), [line("2026-11-10", -1170, "X")], none, null).kind).toBe("none"));
  it("ignores used lines and wrong-sign lines", () => {
    const l = line("2026-11-10", -1170, "USD 15.00");
    expect(decide(usd(), [l], new Set([l.url]), 0.78).kind).toBe("none");
    expect(decide(usd(), [line("2026-11-10", 1170, "USD 15.00")], none, 0.78).kind).toBe("none");
  });
  it("matches a foreign refund to a money-in line", () => {
    const f = usd({ totalMinor: -1500 });
    expect(decide(f, [line("2026-11-10", 1170, "X"), line("2026-11-10", -1170, "X")], none, 0.78)).toMatchObject({ kind: "match", line: { amountMinor: 1170 } });
    expect(decide(f, [line("2026-11-10", 1193, "REFUND USD 15.00")], none, null).kind).toBe("match");
  });
  it("applies the swapped date to foreign receipts", () => {
    expect(decide(usd({ date: "2026-03-04" }), [line("2026-04-03", -1170, "X")], none, 0.78).kind).toBe("match");
    expect(decide(usd({ date: "2026-03-14" }), [line("2026-04-14", -1170, "X")], none, 0.78).kind).toBe("none");
  });
  it("asks when two foreign lines fit", () =>
    expect(decide(usd({ supplier: null }), [line("2026-11-10", -1170, "A", "a"), line("2026-11-10", -1170, "A", "b")], none, 0.78).kind).toBe("choice"));
});
