import type { IncomingMessage, ServerResponse } from "node:http";

/* ==========================================================================
 * Vercel serverless entry.
 *
 * A catch-all so every /api/* route reaches the same Express app: Vercel maps
 * api/[...path] to anything under /api, which keeps the routing in one place
 * rather than one function file per endpoint.
 *
 * The app is loaded lazily and INSIDE a try, on purpose. A module that throws
 * while the entry file is being imported takes the whole invocation down
 * before any code of ours runs, and the platform answers
 * FUNCTION_INVOCATION_FAILED with the reason only in a log. Deferring the
 * import turns that same failure into a response that says what broke.
 * ======================================================================== */

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void;

let cached: NodeHandler | null = null;

async function loadApp(): Promise<NodeHandler> {
  if (cached) return cached;
  const { createApp } = await import("../src/app.js");
  cached = createApp() as unknown as NodeHandler;
  return cached;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const app = await loadApp();
    app(req, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // The message names the problem; the stack is the noisy part, so it is
    // behind a flag rather than public by default.
    const stack =
      process.env.DEBUG_STARTUP === "1" && err instanceof Error
        ? (err.stack ?? "").split("\n").slice(0, 8)
        : undefined;

    console.error("[api] failed to start:", err);

    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        error: "The API failed to start.",
        detail: message,
        stack,
      }),
    );
  }
}
