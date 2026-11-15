import { handleEmail } from "./email/handler";
import type { Env } from "./env";

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/health") return new Response("ok");
    return new Response("not found", { status: 404 });
  },
  async email(message, env, ctx): Promise<void> {
    await handleEmail(message, env, ctx);
  },
} satisfies ExportedHandler<Env>;
