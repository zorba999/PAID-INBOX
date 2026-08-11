import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp } from "../src/app.js";

/* ==========================================================================
 * Vercel serverless entry.
 *
 * A catch-all so every /api/* route reaches the same Express app: Vercel maps
 * api/[...path] to anything under /api, which is what keeps the routing in one
 * place instead of one function file per endpoint.
 *
 * The app is built once per cold start and reused while the lambda stays warm.
 * ======================================================================== */

const app = createApp();

export default function handler(req: IncomingMessage, res: ServerResponse) {
  return (app as unknown as (r: IncomingMessage, s: ServerResponse) => void)(req, res);
}
