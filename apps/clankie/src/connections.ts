import { z } from "zod";
import {
  OperatorConnectionInventorySchema,
  type OperatorConnectionCommand,
  type OperatorConnectionInventory,
} from "@clankie/protocol";
import type { ClankieAppDependencies } from "./app.ts";

type Dependencies = Pick<ClankieAppDependencies, "runtimes" | "swarm" | "workerMcp">;
const metadata = z.string().max(4096);
const observation = z.object({
  scope: metadata,
  sessions: z.object({
    items: z.array(
      z.object({
        actor: metadata,
        generation: z.number().int().positive(),
        state: metadata,
        runtime: metadata,
      }),
    ),
    truncated: z.boolean(),
  }),
});
const swarmStatus = z.object({
  connections: z
    .array(
      z.object({
        id: metadata,
        conversationId: metadata,
        enabled: z.boolean(),
        actor: metadata,
        scope: metadata,
      }),
    )
    .default([]),
  conversations: z
    .array(
      z.object({
        connection: metadata.optional(),
        conversationId: metadata.optional(),
        actor: metadata.optional(),
        runtimeConfiguration: z.enum(["live", "restart-required"]).optional(),
        state: z.unknown().optional(),
      }),
    )
    .default([]),
});

async function connectionInventory(deps: Dependencies): Promise<OperatorConnectionInventory> {
  const [runtimes, rawSwarm, account] = await Promise.all([
    deps.runtimes?.list() ?? [],
    deps.swarm?.status() ?? {},
    deps.workerMcp?.linearAccount() ?? { status: "unavailable" as const },
  ]);
  const swarm = swarmStatus.parse(rawSwarm);
  const rows = [...swarm.connections];
  for (const live of swarm.conversations) {
    if (
      live.connection &&
      live.conversationId &&
      !rows.some((row) => row.id === live.connection && row.conversationId === live.conversationId)
    )
      rows.push({
        id: live.connection,
        conversationId: live.conversationId,
        enabled: true,
        actor: live.actor ?? "",
        scope: "",
      });
  }
  return OperatorConnectionInventorySchema.parse({
    observedAt: new Date().toISOString(),
    runtimes: runtimes.map(({ id, kind, session, state, enabled, capacity, capabilities }) => ({
      id,
      kind,
      session,
      state,
      enabled,
      capacity,
      capabilities,
    })),
    swarms: rows.slice(0, 64).map((row) => {
      const live = swarm.conversations.find(
        (entry) => entry.connection === row.id && entry.conversationId === row.conversationId,
      );
      const state = observation.safeParse(live?.state);
      return {
        ...row,
        state: !row.enabled ? "disabled" : state.success ? "connected" : "unavailable",
        ...(state.success ? { scope: state.data.scope } : {}),
        ...(live?.runtimeConfiguration ? { runtimeConfiguration: live.runtimeConfiguration } : {}),
        agents: state.success
          ? state.data.sessions.items.slice(0, 20).map(({ actor, ...agent }) => ({ id: actor, ...agent }))
          : [],
        agentsTruncated:
          state.success && (state.data.sessions.truncated || state.data.sessions.items.length > 20),
      };
    }),
    swarmsTruncated: rows.length > 64,
    unavailableSwarms: swarm.conversations.filter((row) => !row.connection || !row.conversationId).length,
    linear: {
      status: account.status,
      ...("account" in account
        ? {
            email: account.account.email,
            workspace: account.account.workspaceName,
            verifiedAt: account.account.verifiedAt,
          }
        : {}),
    },
  });
}

/** Shared by local REST and paired-device commands; settings never imply live coordinator support. */
export async function changeRuntime(deps: Dependencies, command: "connect" | "disconnect", input: unknown) {
  if (!deps.runtimes) throw new Error("Execution connections unavailable");
  await deps.swarm?.syncRuntimeConnections?.();
  const result =
    command === "connect"
      ? await deps.runtimes.connect(input)
      : await deps.runtimes.disconnect(String(input));
  await deps.swarm?.syncRuntimeConnections?.();
  return result;
}

export async function manageConnections(deps: Dependencies, command: OperatorConnectionCommand) {
  if (command.action === "connect_runtime")
    await changeRuntime(deps, "connect", { id: command.id, session: command.session });
  if (command.action === "reconnect_runtime") {
    const runtime = (await deps.runtimes?.list())?.find((entry) => entry.id === command.id);
    if (!runtime || runtime.id === "default") throw new Error("Unknown named runtime");
    const { id, kind, session, socketPath, capacity, capabilities } = runtime;
    await changeRuntime(deps, "connect", { id, kind, session, socketPath, capacity, capabilities });
  }
  if (command.action === "disconnect_runtime") await changeRuntime(deps, "disconnect", command.id);
  if (command.action === "disconnect_swarm") {
    if (!deps.swarm?.disconnect) throw new Error("Swarm connections unavailable");
    await deps.swarm.disconnect(command.id);
  }
  return connectionInventory(deps);
}
