import type { IncomingMessage, ServerResponse } from "node:http";

/* ==========================================================================
 * Vercel serverless entry: one function for the whole API.
 *
 * Routing is done by an explicit rewrite in vercel.json rather than by a
 * `[...path]` catch-all file. The catch-all matched a single segment only, so
 * /api/config worked while /api/auth/nonce returned Vercel's own 404 before
 * any of this ran. The rewrite hands the original path over in `__p`, and this
 * puts it back on req.url so Express routes on the real URL.
 *
 * The app is loaded lazily and INSIDE a try. A module that throws while the
 * entry file is being imported takes the invocation down before any code of
 * ours runs, and the platform answers FUNCTION_INVOCATION_FAILED with the
 * reason only in a log. Deferring the import turns that into a readable body.
 * ======================================================================== */

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void;

let cached: NodeHandler | null = null;

async function loadApp(): Promise<NodeHandler> {
  if (cached) return cached;
  const { createApp } = await import("../src/app.js");
  cached = createApp() as unknown as NodeHandler;
  return cached;
}

/**
 * Rebuild the path the caller actually asked for, minus our own marker.
 *
 * Parsed by hand rather than with URLSearchParams, which percent-DECODES on
 * read: `%40` would come back as `@` and the path would be handed to Express
 * in a different form than the client sent. The value is spliced out of the
 * raw query string so every byte survives.
 */
function restoreOriginalUrl(req: IncomingMessage): void {
  const raw = req.url ?? "/";
  const split = raw.indexOf("?");
  if (split === -1) return;

  const pairs = raw.slice(split + 1).split("&");
  const index = pairs.findIndex((p) => p === "__p" || p.startsWith("__p="));
  if (index === -1) return;

  const path = pairs[index].slice("__p=".length);
  pairs.splice(index, 1);

  const rest = pairs.join("&");
  req.url = `/api/${path}${rest ? `?${rest}` : ""}`;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    restoreOriginalUrl(req);
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
    res.end(JSON.stringify({ error: "The API failed to start.", detail: message, stack }));
  }
}
