import { expect, it } from "vitest";
import { toCurrency } from "../src/read/currency";
import { chooseDate, parseWrittenDate } from "../src/read/dates";
import { embeddedJpegs } from "../src/read/pdf";
import scanUrl from "./fixtures/scan.pdf?inline";
import textUrl from "./fixtures/text.pdf?inline";

const bytes = (dataUrl: string) => Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (c) => c.charCodeAt(0));
const scanPdf = bytes(scanUrl);
const textPdf = bytes(textUrl);

it("copies both JPEGs out of a two-page scan", () => {
  const out = embeddedJpegs(scanPdf);
  expect(out).toHaveLength(2);
  expect(out[0][0]).toBe(0xff);
  expect(out[0][1]).toBe(0xd8);
  expect(out[0].length).toBeGreaterThanOrEqual(out[1].length);
});
it("returns nothing for a text PDF", () => expect(embeddedJpegs(textPdf)).toEqual([]));
it.each([["03/04/2026", "2026-04-03"], ["04/03/26", "2026-03-04"], ["07/11/2026 20:41", "2026-11-07"], ["14.10.2026", "2026-10-14"],
  ["02/03/18 05:16 PM", "2018-03-02"], ["4th March 2026", null], ["November 2026", null], ["31/02/2026", null]])(
  "parses %s day-first", (w, iso) => expect(parseWrittenDate(w)).toBe(iso));
it("uses the written date for text and the typed date for images", () => {
  expect(chooseDate({ inputKind: "text", typed: "2026-03-04", written: "03/04/2026", emailDate: "2026-04-03" })).toBe("2026-04-03");
  expect(chooseDate({ inputKind: "image", typed: "2017-12-02", written: "02/12/207", emailDate: "2017-12-02" })).toBe("2017-12-02");
});
it("falls back to the email date when the date is missing, in the future, or over a year old", () => {
  expect(chooseDate({ inputKind: "image", typed: null, written: null, emailDate: "2026-11-12" })).toBe("2026-11-12");
  expect(chooseDate({ inputKind: "image", typed: "2028-03-14", written: null, emailDate: "2026-11-12" })).toBe("2026-11-12");
  expect(chooseDate({ inputKind: "image", typed: "0207-12-02", written: null, emailDate: "2026-11-12" })).toBe("2026-11-12");
  expect(chooseDate({ inputKind: "image", typed: "2024-01-01", written: null, emailDate: "2026-11-12" })).toBe("2026-11-12");
});
it("returns the candidate as it is when there is no email date", () => {
  expect(chooseDate({ inputKind: "image", typed: "2024-01-01", written: null, emailDate: null })).toBe("2024-01-01");
  expect(chooseDate({ inputKind: "text", typed: null, written: "bad", emailDate: null })).toBeNull();
});
it("compares on the day of a postal-mime timestamp and always returns a plain day", () => {
  const ts = "2026-11-13T09:00:00.000Z";
  expect(chooseDate({ inputKind: "text", typed: "2026-11-02", written: "02/11/2026", emailDate: ts })).toBe("2026-11-02");
  expect(chooseDate({ inputKind: "image", typed: null, written: null, emailDate: ts })).toBe("2026-11-13");
  expect(chooseDate({ inputKind: "image", typed: "2028-03-14", written: null, emailDate: ts })).toBe("2026-11-13");
  expect(chooseDate({ inputKind: "image", typed: "2026-11-13T10:00:00Z", written: null, emailDate: null })).toBeNull();
});
it("falls back to the typed date when a text receipt's written date does not parse", () => {
  expect(chooseDate({ inputKind: "text", typed: "2026-11-02", written: "2nd November", emailDate: "2026-11-13T09:00:00.000Z" })).toBe("2026-11-02");
});
it.each([["£", "GBP"], ["GBP", "GBP"], ["$", "USD"], ["US$", "USD"], ["usd", "USD"], ["€", "EUR"], ["chf", "CHF"], [" chf ", "CHF"], ["", "GBP"], [null, "GBP"]])(
  "maps %s", (s, c) => expect(toCurrency(s)).toBe(c));
