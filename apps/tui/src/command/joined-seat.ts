import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { relative, isAbsolute, sep } from "node:path";
import { z } from "zod";
import { createDefaultCredentialStore } from "@clankie/credential-broker";
import { JoinedSeatResponseSchema, type JoinedSeatRequest } from "@clankie/protocol/machine-join";
import {
  exchangeJoinedMachine,
  readJoinedMachineCredential,
  type JoinedMachineCredential,
} from "../../bin/joined-machine-client.ts";
import { defaultSpawn, parseSeatArgs, runSeatCommand, type SeatCommandOptions } from "./seat.ts";
import type { HeadlessCaptainCommandOptions } from "../../bin/headless-captain.ts";

const LaunchResult = z.strictObject({
  conversationId: z.string().min(1).optional(),
  directory: z.string().min(1),
  maximumTrustMode: z.boolean(),
  token: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/u)
    .optional(),
});
// Existing CLI consumers require a credential. This sentinel is accepted only by
// the in-process adapter; it is never sent to the home or persisted in the broker.
const SENTINEL = `clankie_op_${"j".repeat(43)}`;
const HOST = "http://joined-seat.invalid";
export function joinedSeatTransport(credential: JoinedMachineCredential, fetcher: typeof fetch) {
  const rpc = async (request: JoinedSeatRequest, signal?: AbortSignal) => {
    const result = JoinedSeatResponseSchema.parse(
      await exchangeJoinedMachine(
        credential,
        { op: "seat", request },
        fetcher,
        signal ?? AbortSignal.timeout(60_000),
      ),
    );
    return new Response(result.body || null, { status: result.status, headers: result.headers });
  };
  const fetchFor =
    (token: string): typeof fetch =>
    async (resource, init) => {
      const request = new Request(resource, init);
      const url = new URL(request.url);
      const paths: Record<string, string> = {
        "/v1/mcp": "/v1/fleet/lead/mcp",
        "/v1/captain/prompt": "/v1/fleet/lead/prompt",
        "/v1/captain/memory-card": "/v1/fleet/lead/memory-card",
        "/v1/seat/transcript": "/v1/fleet/lead/transcript",
      };
      const path =
        paths[url.pathname] ??
        (url.pathname.startsWith("/v1/seat/events")
          ? url.pathname.replace("/v1/seat/events", "/v1/fleet/lead/events")
          : undefined);
      if (!path || (url.searchParams.has("lane") && url.searchParams.get("lane") !== "operator"))
        throw Error("joined_seat_route_refused");
      const headers = new Headers();
      for (const name of [
        "content-type",
        "accept",
        "mcp-session-id",
        "mcp-protocol-version",
        "x-clankie-seat-capabilities",
      ]) {
        const value = request.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      headers.set("authorization", `Bearer ${token}`);
      return rpc(
        {
          method: request.method as JoinedSeatRequest["method"],
          path: path + url.search,
          headers: Object.fromEntries(headers),
          ...(request.body ? { body: await request.text() } : {}),
        },
        request.signal,
      );
    };
  return { rpc, fetchFor };
}

/** Reuse the installed seat/plugin; only chat resolution and the home transport differ. */
export async function runJoinedClaudeSeat(
  args: readonly string[],
  options: SeatCommandOptions,
): Promise<number | undefined> {
  const env = options.env ?? process.env;
  const store = options.joinCredentialStore ?? createDefaultCredentialStore({ env });
  const credential = await readJoinedMachineCredential(store);
  if (!credential) return undefined;
  const reset = args.includes("--reset");
  const seatArgs = args.filter((arg) => arg !== "--reset");
  const flags = parseSeatArgs(seatArgs, options.harnessCommand ?? options.claudeCommand);
  if (flags.harness !== undefined && flags.harness !== "claude")
    throw Error("Joined installs currently support clankie claude; other harness seats are a follow-up.");
  if (reset && (flags.resume || flags.newConversation))
    throw Error("--reset keeps the folder chat; use it without --resume or --new");
  const directory = await realpath(process.cwd());
  let allowed = false;
  for (const root of credential.localDirectories) {
    const remainder = relative(await realpath(root), directory);
    if (!isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(`..${sep}`)) allowed = true;
  }
  if (!allowed) throw Error("directory_refused: launch from a directory approved when this machine joined");
  let sessionId = flags.resumeSessionId ?? randomUUID();
  const wire = joinedSeatTransport(credential, options.fetchImpl ?? fetch);
  let resolved: z.infer<typeof LaunchResult> | undefined;
  let token: string | undefined;
  const launch = async (dryRun: boolean, fresh: boolean, conversationId?: string) => {
    const response = await wire.rpc({
      method: "POST",
      path: "/launch",
      headers: {},
      body: JSON.stringify({
        reset,
        sessionId,
        directory,
        fresh,
        dryRun,
        ...(conversationId === undefined ? {} : { conversationId }),
      }),
    });
    const body = await response.json();
    if (!response.ok) throw Error(body.error ?? "joined_seat_unavailable");
    const { earlierSessions, ...result } = body;
    if (!dryRun && Array.isArray(earlierSessions) && earlierSessions.length)
      (options.stderr ?? process.stderr).write(
        `Earlier joined launches: ${earlierSessions.join(", ")}. Their panes were not closed.\n`,
      );
    resolved = LaunchResult.parse(result);
    token = resolved.token ?? token;
    return resolved;
  };
  const seatEnv = { ...env };
  for (const key of [
    "CLANKIE_OPERATOR_TOKEN",
    "CLANKIE_CAPTAIN_TOKEN",
    "CLANKIE_REMOTE_LEAD_TOKEN",
    "CLANKIE_JOINED_SEAT_TOKEN",
    "CLANKIE_JOINED_WORKER_SESSION",
  ])
    delete seatEnv[key];
  try {
    return await runSeatCommand(seatArgs, {
      ...options,
      env: seatEnv,
      joinedSeat: {
        sessionId,
        validateResume: async (request) => {
          if ((await realpath(request.cwd)) !== directory)
            throw Error("Joined resume must run in its original approved folder");
          sessionId = request.sessionId;
          await launch(true, false, request.conversationId);
        },
        resolveContext: async (request) => {
          const result = await launch(request.dryRun, request.fresh === true, request.conversationId);
          return result.conversationId === undefined
            ? {
                cwd: directory,
                newConversation: {
                  op: "create",
                  schemaVersion: 1,
                  scope: { kind: "workspace", workspaceId: directory },
                  title: "Clankie claude",
                },
              }
            : { cwd: directory, conversationId: result.conversationId };
        },
        maximumTrust: async () => ({ enabled: resolved!.maximumTrustMode }),
      },
      spawnImpl: async (command, launchArgs, cwd, childEnv) => {
        if (!token) await launch(false, flags.newConversation === true, resolved?.conversationId);
        if (!resolved?.conversationId || !token) throw Error("joined_seat_binding_missing");
        return (options.spawnImpl ?? defaultSpawn)(command, launchArgs, cwd, {
          ...childEnv,
          CLANKIE_CONVERSATION_ID: resolved.conversationId,
          CLANKIE_JOINED_SEAT_TOKEN: token,
        });
      },
    });
  } finally {
    if (token)
      await wire
        .rpc({ method: "POST", path: "/close", headers: { authorization: `Bearer ${token}` } })
        .catch(() => {
          (options.stderr ?? process.stderr).write(
            "Clankie home did not confirm seat closure; the reservation expires after one hour without traffic.\n",
          );
        });
  }
}

/** Native plugin subprocesses resolve the machine lease locally, never inherit a home bearer. */
export async function runJoinedSeatHook(
  command: string | undefined,
  args: readonly string[],
  options: HeadlessCaptainCommandOptions,
): Promise<number | undefined> {
  const env = options.env ?? process.env;
  const token = env.CLANKIE_JOINED_SEAT_TOKEN;
  if (!token || !["mcp", "prompt", "memory-card", "seat-sync"].includes(command ?? "")) return undefined;
  const credential = await readJoinedMachineCredential(createDefaultCredentialStore({ env }));
  if (!credential) throw Error("Joined machine registration missing; use clankie join resume");
  const wire = joinedSeatTransport(credential, options.fetchImpl ?? fetch);
  const routed: HeadlessCaptainCommandOptions = {
    ...options,
    env: { ...env, CLANKIE_OPERATOR_TOKEN: SENTINEL },
    host: HOST,
    fetchImpl: async (resource, init) => {
      await (await import("./joined-worker.ts")).verifyJoinedWorker(env);
      return wire.fetchFor(token)(resource, init);
    },
  };
  if (command === "mcp") return (await import("./mcp.ts")).runMcpCommand(args, routed);
  if (command === "prompt") return (await import("./prompt.ts")).runPromptCommand(args, routed);
  if (command === "memory-card") return (await import("./memory-card.ts")).runMemoryCardCommand(args, routed);
  return (await import("./seat-sync.ts")).runSeatSyncCommand(args, routed);
}
