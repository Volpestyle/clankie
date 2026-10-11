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
});
interface Seat extends RemoteSeatAuthority {
  readonly machineId: string;
  readonly directory: string;
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
  const bridge = createRemoteLeadBridge({
    captain: input.captain,
    ...(input.receiptPath === undefined ? {} : { receiptPath: input.receiptPath }),
    identity: () => undefined,
    delegations: {
      isRevoked: () => false,
      close: () => {
        for (const seat of seats.values()) seat.abort.abort();
        seats.clear();
      },
      authorize: async (request) => {
        const token = request.headers.get("authorization")?.replace(/^Bearer /u, "");
        const seat = token === undefined ? undefined : seats.get(token);
        if (!seat || !seat.current() || !(await seat.authorize())) return undefined;
        seat.touchedAt = Date.now();
        return seat;
      },
    },
  });
  const closeSeat = (token: string, seat: Seat) => {
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
      if (input.captain.operatorSeatReady?.(conversationId)) return json({ error: "seat_occupied" }, 409);
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
      seats.set(token, seat);
      return json({ conversationId, directory: launch.directory, maximumTrustMode, token });
    }
    const token = frame.headers.authorization?.replace(/^Bearer /u, "");
    const seat = token === undefined ? undefined : seats.get(token);
    if (!seat || seat.machineId !== machine.machineId || !(await seat.authorize()))
      return json({ error: "joined_seat_revoked" }, 403);
    if (url.pathname === "/close" && frame.method === "POST") {
      closeSeat(token!, seat);
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
  return { close: bridge.close };
}
