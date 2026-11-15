import { handleEmail } from "./email/handler";
import type { Env } from "./env";
import { runMatcher } from "./match/run";
import { readReceipt } from "./read/reader";

const logged = (what: string) => (e: unknown) => console.error(what, e); // the cron run retries anything that fails here

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/health") return new Response("ok");
    return new Response("not found", { status: 404 });
  },
  async email(message, env, ctx): Promise<void> {
    await handleEmail(message, env, ctx, (id) => readReceipt(env, id).then(() => runMatcher(env, {}, id)).catch(logged("after-email run failed")));
  },
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(runMatcher(env).catch(logged("scheduled run failed")));
  },
} satisfies ExportedHandler<Env>;
