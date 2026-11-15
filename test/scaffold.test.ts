import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { CONFIDENCE_AUTO, FX_TOLERANCE, IMAGE_MAX_SIDE, STUCK_AFTER_DAYS } from "../src/env";
import devVarsExample from "../.dev.vars.example?raw";
import wrangler from "../wrangler.jsonc?raw";

const SECRETS = ["FORWARD_ADDRESS", "ALLOWED_SENDERS", "NOTIFY_TO", "OWNER_EMAIL"];

it("applies the schema", async () => {
  const t = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  expect(t.results.map((r) => r.name)).toEqual(expect.arrayContaining(["receipts", "files", "events", "settings", "rates"]));
});
it("exposes the spec's constants", () => {
  expect([CONFIDENCE_AUTO, FX_TOLERANCE, STUCK_AFTER_DAYS, IMAGE_MAX_SIDE]).toEqual([0.7, 0.04, 14, 1600]);
});
it("keeps the addresses out of the committed vars; .dev.vars.example names them with example.com values", () => {
  const vars = /"vars":\s*\{[^}]*\}/.exec(wrangler)![0];
  for (const k of SECRETS) expect(vars).not.toContain(k);
  for (const k of ["APP_URL", "FREEAGENT_BASE_URL", "CLAIRIC_MODEL"]) expect(vars).toContain(k);
  for (const k of SECRETS) expect(devVarsExample).toMatch(new RegExp(`^${k}=.*example\\.com`, "m"));
  for (const m of devVarsExample.matchAll(/[\w.+-]+@([\w.-]+)/g)) expect(m[1]).toMatch(/(^|\.)example\.com$/);
});
