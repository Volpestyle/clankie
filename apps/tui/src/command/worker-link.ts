import { readLink, seatRoute } from "../../../../integrations/claude-plugin/worker/bin/link.mjs";
import { seatIdentity } from "./seat-identity.ts";
import { decodeMcpResult } from "@clankie/protocol/mcp-result";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** A hired pane uses only its own link, never an owner-bearer fallback. */
export function workerLink(options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }) {
  const env = options.env ?? process.env;
  if (env.CLANKIE_WORKER_PANE !== "1") return undefined;
  const { pane, socket } = seatIdentity(env);
  const link = socket === undefined ? undefined : readLink(socket, env);
  if (!pane || !link) throw new Error("Worker pane link unavailable; ask your lead to repair this seat.");
  const headers: Record<string, string> =
    link.authentication === "local-process"
      ? { "x-clankie-pane": pane }
      : { authorization: `Bearer ${link.token ?? ""}` };
  return {
    origin: link.url,
    headers,
    request: (route: string, suffix = "", init: RequestInit = {}) =>
      (options.fetchImpl ?? fetch)(`${seatRoute(link, pane, route).href}${suffix}`, {
        ...init,
        headers: {
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...Object.fromEntries(new Headers(init.headers)),
          ...headers,
        },
        redirect: "error",
        signal: init.signal ?? AbortSignal.timeout(60_000),
      }),
  };
}

/** Use the same role, worker attribution and durable call receipts as native tools. */
export async function workerTrackerCall(
  name: string,
  args: Record<string, unknown>,
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; repoRoot?: string } = {},
) {
  // The standalone bridge reads its manifest beside itself; keep it out of the console bundle.
  const root = options.repoRoot ?? fileURLToPath(new URL("../../../../", import.meta.url));
  const { callNativeConnectedTool } = (await import(
    pathToFileURL(join(root, "integrations/claude-plugin/worker/bin/seat-channel.mjs")).href
  )) as typeof import("../../../../integrations/claude-plugin/worker/bin/seat-channel.mjs");
  const result = (await callNativeConnectedTool(
    { name: name.startsWith("linear_") ? name : `linear_${name}`, arguments: args },
    { env: options.env ?? process.env, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) },
  )) as { isError?: boolean };
  const body = decodeMcpResult(result) as { outcome?: string; isError?: boolean } | undefined;
  return { ok: result.isError !== true && body?.outcome === "ok" && body.isError !== true, body };
}
