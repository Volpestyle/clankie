import {
  OperatorConnectionInventorySchema,
  type OperatorConnectionCommand,
  type OperatorConnectionInventory,
} from "@clankie/protocol";
import type { ClankieAppDependencies } from "./app.ts";

type Dependencies = Pick<ClankieAppDependencies, "runtimes" | "workerMcp">;
async function connectionInventory(deps: Dependencies): Promise<OperatorConnectionInventory> {
  const [runtimes, account, machines] = await Promise.all([
    deps.runtimes?.list() ?? [],
    deps.workerMcp?.linearAccount() ?? { status: "unavailable" as const },
    deps.runtimes?.machines.list() ?? { machines: [] },
  ]);
  return OperatorConnectionInventorySchema.parse({
    observedAt: new Date().toISOString(),
    machines: machines.machines.map((machine) => ({
      ...machine,
      sessions: machine.sessions.map(({ socketPath: _socket, ...session }) => session),
    })),
    runtimes: runtimes.map(({ id, machine, kind, session, state, enabled, capacity, capabilities }) => ({
      machine: machine ?? "local",
      id,
      kind,
      session,
      state,
      enabled,
      capacity,
      capabilities,
    })),
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

/** Shared by local REST and paired-device commands; settings never imply runtime availability. */
export async function changeRuntime(deps: Dependencies, command: "connect" | "disconnect", input: unknown) {
  if (!deps.runtimes) throw new Error("Execution connections unavailable");
  const result =
    command === "connect"
      ? await deps.runtimes.connect(input)
      : await deps.runtimes.disconnect(String(input));
  return result;
}

export async function manageConnections(deps: Dependencies, command: OperatorConnectionCommand) {
  if (command.action === "set_machine_access") {
    if (!deps.runtimes) throw new Error("Machines unavailable");
    await deps.runtimes.machines.setAccess(command.id, { accessLevel: command.accessLevel });
  }
  if (command.action === "discover") await deps.runtimes?.machines.list(true);
  if (command.action === "add_machine") {
    if (!deps.runtimes) throw new Error("Machines unavailable");
    await deps.runtimes.machines.add({ id: command.id, ssh: command.ssh, shell: command.shell });
  }
  if (command.action === "remove_machine") {
    if (!deps.runtimes) throw new Error("Machines unavailable");
    await deps.runtimes.machines.remove(command.id);
  }
  if (command.action === "connect_runtime")
    await changeRuntime(deps, "connect", {
      id: command.id,
      session: command.session,
      ...(command.machine ? { machine: command.machine } : {}),
    });
  if (command.action === "reconnect_runtime") {
    const runtime = (await deps.runtimes?.list())?.find((entry) => entry.id === command.id);
    if (!runtime || runtime.id === "default") throw new Error("Unknown named runtime");
    const { id, machine, kind, session, socketPath, capacity, capabilities, workspaces } = runtime;
    await changeRuntime(deps, "connect", {
      id,
      machine,
      kind,
      session,
      socketPath,
      ...(runtime.capacitySource === "default" ? {} : { capacity }),
      capabilities,
      workspaces,
    });
  }
  if (command.action === "disconnect_runtime") await changeRuntime(deps, "disconnect", command.id);
  if (command.action === "set_runtime_capacity")
    await changeRuntime(deps, "connect", { action: "capacity", id: command.id, capacity: command.capacity });
  return connectionInventory(deps);
}
