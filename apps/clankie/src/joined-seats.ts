import { createJoinedWorkers } from "./joined-workers.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { posix, win32 } from "node:path";
import { z } from "zod";
import { JoinedSeatResponseSchema, type JoinedSeatRequest } from "@clankie/protocol/machine-join";
import type { SettingsStore } from "@clankie/settings";
import type { CaptainPort } from "./captain/port.ts";
import type { JoinedSeatMachine, MachineJoins } from "./machine-joins.ts";
import { occupantIdForHerdrSession } from "./captain/herdr-census.ts";
import { createRemoteLeadBridge, type RemoteSeatAuthority } from "./remote-lead-bridge.ts";

const Launch = z.strictObject({
  sessionId: z.uuid(),
  directory: z.string().min(1).max(4096),
  conversationId: z.string().min(1).max(256).optional(),
  fresh: z.boolean(),
  dryRun: z.boolean(),
  reset: z.boolean().default(false),
});
interface Seat extends RemoteSeatAuthority {
  readonly machineId: string;
  readonly directory: string;
  readonly sessionId: string;
  readonly abort: AbortController;
  touchedAt: number;
}

/** A joined install gets only a delegated lead in its approved workspace, never an owner bearer. */
export function createJoinedSeats(input: {
  joins: MachineJoins;
  captain: CaptainPort;
  settings?: Pick<SettingsStore, "load">;
  receiptPath?: string;
}) {
  const seats = new Map<string, Seat>();
  const launches = new Map<string, string[]>();
  const workers = createJoinedWorkers(input);
  const bridge = createRemoteLeadBridge({
    captain: input.captain,
    ...(input.receiptPath === undefined ? {} : { receiptPath: input.receiptPath }),
    identity: () => undefined,
    delegations: {
      isRevoked: () => false,
      close: () => {
        for (const seat of seats.values()) seat.abort.abort();
        seats.clear();
        workers.close();
      },
      authorize: async (request) => {
        const token = request.headers.get("authorization")?.replace(/^Bearer /u, "");
        const seat = token === undefined ? undefined : (seats.get(token) ?? (await workers.authority(token)));
        if (!seat || !seat.current() || !(await seat.authorize())) return undefined;
        if ("touchedAt" in seat) seat.touchedAt = Date.now();
        return seat;
      },
    },
  });
  const closeSeat = (token: string, seat: Seat) => {
    input.captain.releaseJoinedSeat?.(seat.binding.conversationId);
    seats.delete(token);
    seat.abort.abort();
  };
  const respond = async (response: Response) =>
    JoinedSeatResponseSchema.parse({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    });
  const handler = async (machine: JoinedSeatMachine, frame: JoinedSeatRequest) => {
    await machine.authorize();
    if (!frame.path.startsWith("/") || frame.path.startsWith("//")) throw Error("joined_seat_route_refused");
    const url = new URL(frame.path, "http://joined-seat.invalid");
    const json = (body: unknown, status = 200) => respond(Response.json(body, { status }));
    if (url.pathname === "/launch" && frame.method === "POST") {
      const launch = Launch.parse(JSON.parse(frame.body ?? ""));
      const paths = machine.platform === "win32" ? win32 : posix;
      const canonical = (path: string) =>
        machine.platform === "win32" ? paths.normalize(path).toLowerCase() : paths.normalize(path);
      const cwd = canonical(launch.directory);
      if (
        !paths.isAbsolute(cwd) ||
        !machine.directories.some((root) => {
          const relative = paths.relative(canonical(root), cwd);
          return !paths.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${paths.sep}`);
        })
      )
        return json({ error: "directory_refused" }, 403);
      if (launch.reset && launch.fresh) return json({ error: "joined_reset_new_refused" }, 400);
      let conversationId = launch.conversationId;
      if (conversationId === undefined && !launch.fresh) {
        const list = await input.captain.serveOperatorConversation({ op: "list", schemaVersion: 1 });
        if (list.op === "list")
          conversationId = list.conversations.find(
            (chat) =>
              chat.scope.kind === "workspace" &&
              chat.scope.machineId === machine.machineId &&
              canonical(chat.scope.workspaceId) === cwd,
          )?.conversationId;
      }
      if (conversationId === undefined && launch.reset)
        return json({ error: "joined_reset_chat_missing" }, 404);
      if (conversationId === undefined && !launch.dryRun) {
        await machine.authorize();
        conversationId = input.captain.createRemoteWorkspaceConversation({
          title: `Clankie claude · ${paths.basename(launch.directory).slice(0, 64)}`,
          workspaceId: launch.directory,
          machineId: machine.machineId,
        }).conversationId;
      }
      const maximumTrustMode = input.settings ? (await input.settings.load()).maximumTrustMode : false;
      if (conversationId === undefined) return json({ directory: launch.directory, maximumTrustMode });
      const context = input.captain.seatContext(conversationId);
      if (!context || context.machineId !== machine.machineId || canonical(context.cwd) !== cwd)
        return json({ error: "joined_seat_conversation_mismatch" }, 403);
      const earlierSessions = launches.get(conversationId) ?? [];
      if (launch.reset && !launch.dryRun) {
        await machine.authorize();
        const list = await input.captain.serveOperatorConversation({ op: "list", schemaVersion: 1 });
        const chat =
          list.op === "list"
            ? list.conversations.find((chat) => chat.conversationId === conversationId)
            : undefined;
        if (!chat) return json({ error: "joined_seat_conversation_mismatch" }, 403);
        await machine.authorize();
        for (const [token, seat] of seats)
          if (seat.binding.conversationId === conversationId) closeSeat(token, seat);
        try {
          await input.captain.serveOperatorConversation({
            op: "reset",
            schemaVersion: 1,
            conversationId,
            expectedRevision: chat.revision,
          });
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : "joined_reset_refused" }, 409);
        }
        workers.revokeConversation(conversationId);
      }
      if (!launch.reset && input.captain.operatorSeatReady?.(conversationId))
        return json({ error: "seat_occupied" }, 409);
      const standing = input.captain.seatSessionState?.(conversationId, launch.sessionId);
      if (standing === "retired" || standing === "elsewhere")
        return json({ error: "joined_seat_session_refused" }, 403);
      await machine.authorize();
      if (launch.dryRun) return json({ conversationId, directory: launch.directory, maximumTrustMode });
      for (const [token, seat] of seats) if (!seat.current()) closeSeat(token, seat);
      // Reserve at launch, before the native channel's first poll. A racing launch cannot steal it.
      if ([...seats.values()].some((seat) => seat.binding.conversationId === conversationId))
        return json({ error: "seat_occupied" }, 409);
      if (seats.size >= 128) return json({ error: "joined_seat_capacity" }, 503);
      const token = randomBytes(32).toString("base64url");
      const abort = new AbortController();
      const seat: Seat = {
        id: randomUUID(),
        machineId: machine.machineId,
        directory: launch.directory,
        sessionId: launch.sessionId,
        abort,
        binding: {
          conversationId,
          nativeOccupantId: occupantIdForHerdrSession({
            source: "herdr:claude",
            kind: "id",
            value: launch.sessionId,
          }),
        },
        signal: abort.signal,
        touchedAt: Date.now(),
        current: () =>
          seats.get(token) === seat && !abort.signal.aborted && Date.now() - seat.touchedAt < 60 * 60_000,
        authorize: async () => {
          try {
            await machine.authorize();
            const standing = input.captain.seatSessionState?.(conversationId, launch.sessionId);
            if (standing === "retired" || standing === "elsewhere") {
              closeSeat(token, seat);
              return false;
            }
            return (
              seat.current() && input.captain.seatContext(conversationId)?.machineId === machine.machineId
            );
          } catch {
            closeSeat(token, seat);
            return false;
          }
        },
      };
      seat.toolBank = workers.tools(seat, machine, launch.directory, maximumTrustMode);
      if (!launches.has(conversationId) && launches.size >= 256)
        launches.delete(launches.keys().next().value!);
      launches.set(conversationId, [...new Set([...earlierSessions, launch.sessionId])].slice(-32));
      if (!input.captain.syncSeatTranscript(conversationId, { sessionId: launch.sessionId, entries: [] }))
        return json({ error: "joined_seat_session_refused" }, 403);
      seats.set(token, seat);
      return json({ conversationId, directory: launch.directory, maximumTrustMode, token, earlierSessions });
    }
    const token = frame.headers.authorization?.replace(/^Bearer /u, "");
    const worker = token === undefined ? undefined : await workers.authority(token, machine);
    const seat = token === undefined ? undefined : (seats.get(token) ?? worker);
    if (!seat || seat.machineId !== machine.machineId || !(await seat.authorize()))
      return json({ error: "joined_seat_revoked" }, 403);
    if (worker && url.pathname === "/workers/check" && frame.method === "GET")
      return json({
        sessionId: worker.sessionId,
        directory: worker.directory,
        conversationId: worker.binding.conversationId,
        // The worker bridge re-checks its pane against this before every request.
        ...(worker.nativeSessionId === undefined ? {} : { nativeSessionId: worker.nativeSessionId }),
      });
    if (worker && url.pathname === "/workers/admit" && frame.method === "POST") {
      try {
        return json(await workers.admit(worker, JSON.parse(frame.body ?? "")));
      } catch {
        return json({ error: "joined_worker_session_mismatch" }, 403);
      }
    }
    if (worker && !/^\/v1\/fleet\/lead\/(mcp|events(?:\/[^/]+\/ack)?)$/u.test(url.pathname))
      return json({ error: "joined_worker_route_refused" }, 403);
    if (url.pathname === "/close" && frame.method === "POST") {
      closeSeat(token!, seat as Seat);
      return json({ closed: true });
    }
    // Only the delegated bridge's published routes are reachable. It pins chat and transcript session.
    if (!url.pathname.startsWith("/v1/fleet/lead/")) return json({ error: "joined_seat_route_refused" }, 403);
    // Notifications use the bounded seat-events poll. MCP SSE cannot fit in
    // one encrypted response; the SDK accepts 405 for its optional GET stream.
    if (url.pathname === "/v1/fleet/lead/mcp" && frame.method === "GET")
      return json({ error: "stream_unavailable_use_seat_events" }, 405);
    return respond(
      await bridge.app.fetch(
        new Request(url, {
          method: frame.method,
          headers: frame.headers,
          ...(frame.body === undefined ? {} : { body: frame.body }),
          signal: seat.signal,
        }),
      ),
    );
  };
  input.joins.setSeatHandler(handler);
  // Clankie's own hires on a joined machine (VUH-2607): the same workers, led by a home conversation.
  input.joins.setWorkerHire({
    hire: async (request) => {
      const machine = input.joins.seatMachine(request.machineId);
      if (machine === undefined) throw Error(`No joined machine ${request.machineId}.`);
      await machine.authorize();
      const maximumTrust = input.settings ? (await input.settings.load()).maximumTrustMode : false;
      return workers.hire(machine, request, maximumTrust);
    },
    message: async ({ seat, conversationId, message }) => ({
      ...(await workers.deliver(seat, conversationId, message)),
    }),
  });
  return { close: bridge.close };
}
