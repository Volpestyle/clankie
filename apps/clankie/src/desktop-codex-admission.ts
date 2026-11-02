import { lstat, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import type { HerdrBinding } from "@clankie/protocol";
import { CodexAppServerClient, openCodexSocket } from "./captain/codex-app-server.ts";
import { codexControlEndpoint, codexProcess } from "./captain/codex-seat.ts";
import { HERDR_CORE_FLEET } from "./captain/herdr-core-runner.ts";
import { nativeSessionId } from "./captain/native-session-resume.ts";
import { occupantIdForHerdrSession } from "./captain/herdr-census.ts";
import type { HerdrWatchRunner } from "./captain/herdr-watch.ts";
import { nativeProcessReceipt, observeCodexServer } from "./local-fleet-process.ts";

/** Recover only a hired desktop view's own private server, from kernel-observed ancestry. */
export function desktopCodexAdmission(
  runner: Pick<HerdrWatchRunner, "get" | "paneProcesses">,
  coreBinding: () => HerdrBinding | undefined,
  observeServer = observeCodexServer,
) {
  return async (
    ancestors: readonly number[],
    pane: string,
    binding: HerdrBinding,
    occupant?: string,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    const currentBinding = () => {
      const current = coreBinding();
      return current?.socketPath === binding.socketPath && current.session === binding.session;
    };
    if (!new RegExp(`^${HERDR_CORE_FLEET}/t[0-9a-z]+$`, "u").test(pane) || !currentBinding()) return false;
    const address = pane.slice(HERDR_CORE_FLEET.length + 1);
    try {
      signal?.throwIfAborted();
      const agent = await runner.get(address);
      const session = nativeSessionId(agent);
      const view = codexProcess((await runner.paneProcesses?.(address)) ?? []);
      const endpoint = codexControlEndpoint(view);
      if (
        agent.agent !== "codex" ||
        !session ||
        !view ||
        typeof endpoint !== "string" ||
        (occupant !== undefined &&
          occupantIdForHerdrSession({ source: "herdr:codex", kind: "id", value: session }) !== occupant)
      )
        return false;
      // paneProcesses requires the service-owned record, original terminal PID and
      // native session before it exposes the actual --remote endpoint (#279).
      const alias = endpoint.slice("unix://".length);
      const canonical = await realpath(alias);
      const directory = await lstat(dirname(alias));
      const socket = await lstat(canonical);
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        directory.uid !== process.getuid?.() ||
        directory.mode & 0o077 ||
        !socket.isSocket() ||
        socket.uid !== process.getuid?.() ||
        socket.mode & 0o077
      )
        return false;
      for (const pid of ancestors) {
        signal?.throwIfAborted();
        const birth = await observeServer(pid, endpoint, canonical, signal);
        if (!birth) continue;
        const connection = await openCodexSocket(`ws+unix://${alias}:/`);
        if (!connection) return false;
        const client = new CodexAppServerClient(connection, () => {}, 5_000);
        try {
          await client.initialize(true);
          const loaded = (await client.request("thread/loaded/list", {})) as {
            data?: unknown;
            nextCursor?: unknown;
          };
          if (!Array.isArray(loaded.data) || !loaded.data.includes(session) || loaded.nextCursor != null)
            return false;
          const fresh = await runner.get(address);
          const observed = codexProcess((await runner.paneProcesses?.(address)) ?? []);
          const after = await observeServer(pid, endpoint, canonical, signal);
          const latestSocket = await lstat(await realpath(alias));
          signal?.throwIfAborted();
          return (
            currentBinding() &&
            fresh.agent === "codex" &&
            nativeSessionId(fresh) === session &&
            observed?.pid === view.pid &&
            codexControlEndpoint(observed) === endpoint &&
            after !== undefined &&
            nativeProcessReceipt(after) === nativeProcessReceipt(birth) &&
            latestSocket.dev === socket.dev &&
            latestSocket.ino === socket.ino
          );
        } finally {
          client.close();
        }
      }
      return false;
    } catch {
      signal?.throwIfAborted();
      return false;
    }
  };
}
