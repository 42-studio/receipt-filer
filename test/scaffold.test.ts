import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { CONFIDENCE_AUTO, FX_TOLERANCE, IMAGE_MAX_SIDE, STUCK_AFTER_DAYS } from "../src/env";

it("applies the schema", async () => {
  const t = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  expect(t.results.map((r) => r.name)).toEqual(expect.arrayContaining(["receipts", "files", "events", "settings", "rates"]));
});
it("exposes the spec's constants", () => {
  expect([CONFIDENCE_AUTO, FX_TOLERANCE, STUCK_AFTER_DAYS, IMAGE_MAX_SIDE]).toEqual([0.7, 0.04, 14, 1600]);
});
