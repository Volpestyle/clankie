import { MACHINE_ACCESS_LEVELS, MachineInventorySchema, type Machine } from "@clankie/protocol";
import type { ClankieFaceShell } from "./shell/shell.ts";
import type { SetupFlow } from "./shell/setup-flow.ts";

type Run = (args: readonly string[]) => Promise<unknown>;
export interface MachinesMenuServices {
  readonly machines: Run;
  readonly runtime: Run;
  readonly openSessions?: (machine: string) => Promise<void>;
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const validId = (value: string) =>
  /^[a-z][a-z0-9-]{0,63}$/u.test(value.trim()) && !["default", "local"].includes(value.trim())
    ? undefined
    : "Lowercase letters, digits and dashes; not 'default' or 'local'.";
async function attempt(flow: SetupFlow, work: () => Promise<unknown>, done: string): Promise<boolean> {
  try {
    await work();
    flow.renderLine(done, "success");
    return true;
  } catch (error) {
    flow.renderLine(message(error), "error");
    return false;
  }
}
export async function runMachinesMenu(
  shell: ClankieFaceShell,
  services: MachinesMenuServices,
): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("machines");
  try {
    await machinesSection(shell, services);
  } catch (error) {
    shell.insertCommandResult("/machines", message(error), "error");
  } finally {
    flow.end();
  }
}
export async function machinesSection(
  shell: ClankieFaceShell,
  services: MachinesMenuServices,
): Promise<void> {
  const flow = shell.setupFlow;
  for (;;) {
    flow.setStatus("Discovering machines…");
    const inventory = MachineInventorySchema.parse(await services.machines(["discover"]));
    flow.setStatus("machines");
    const choice = await flow.readSelect({
      message: "Machines",
      options: [
        ...inventory.machines.map((machine) => ({
          value: `machine:${machine.id}`,
          label: machine.id === "local" ? "This machine" : machine.id,
          hint: `${machine.configured ? "" : "discovered · "}${machine.accessLevel ?? "unreported"} · ${machine.state} · ${machine.workerCount ?? "?"} agents`,
        })),
        { value: "add", label: "Add a machine by name…", hint: "SSH target or config alias" },
      ],
      allowBack: true,
    });
    if (choice === undefined) return;
    if (choice === "add") {
      await addMachine(flow, services);
      continue;
    }
    const machine = inventory.machines.find((entry) => `machine:${entry.id}` === choice);
    if (!machine) continue;
    if (
      !machine.configured &&
      !(await attempt(
        flow,
        () =>
          services.machines(["add", machine.id, "--ssh", machine.ssh!, "--shell", machine.shell ?? "posix"]),
        `Added ${machine.id}.`,
      ))
    )
      continue;
    await machineDetail(shell, services, machine.id);
  }
}
async function addMachine(flow: SetupFlow, services: MachinesMenuServices): Promise<void> {
  const id = await flow.readText({
    message: "Machine name",
    placeholder: "e.g. pc",
    validate: validId,
    allowBack: true,
  });
  if (id === undefined) return;
  const ssh = await flow.readText({
    message: "SSH target (user@host or config alias)",
    allowBack: true,
    validate: (value) => (value.trim() ? undefined : "Enter an SSH target."),
  });
  if (ssh === undefined) return;
  const kind = await flow.readSelect({
    message: "Machine shell",
    options: [
      { value: "posix", label: "macOS / Linux" },
      { value: "powershell", label: "Windows / PowerShell" },
    ],
    allowBack: true,
  });
  if (kind === undefined) return;
  await attempt(
    flow,
    () => services.machines(["add", id.trim(), "--ssh", ssh.trim(), "--shell", kind]),
    `Added ${id.trim()}.`,
  );
}
async function machineDetail(
  shell: ClankieFaceShell,
  services: MachinesMenuServices,
  id: string,
): Promise<void> {
  const flow = shell.setupFlow;
  for (;;) {
    const machine = MachineInventorySchema.parse(await services.machines(["sessions", id])).machines.find(
      (entry) => entry.id === id,
    );
    if (!machine) return;
    const choice = await flow.readSelect({
      message: `${id} · ${machine.state} · ${machine.workerCount ?? "?"} agents`,
      options: [
        {
          value: "access",
          label: "Access level…",
          hint: `${machine.accessLevel ?? "unreported"} · ${machine.accessEnforcement === "os-sandbox" ? `OS sandbox, ceiling ${machine.accessCeiling ?? "unreported"}` : machine.accessEnforcement === "joined-host" ? "joined host" : machine.accessEnforcement === "service-preference" ? "service preference" : "enforcement unreported"}`,
        },
        ...machine.sessions.map((session, index) => ({
          value: `session:${index}`,
          label: session.name,
          hint: `${session.state} · ${session.workerCount ?? "?"} agents`,
        })),
        { value: "connect", label: "Connect a session by name…" },
        ...(services.openSessions ? [{ value: "transcripts", label: "Saved agent sessions…" }] : []),
        ...(id === "local"
          ? []
          : [{ value: "remove", label: "Remove machine…", hint: "workers keep running" }]),
      ],
      allowBack: true,
    });
    if (choice === undefined) return;
    if (choice === "access") {
      const access = await flow.readSelect({
        message: `What may Clankie do on ${id}?`,
        options: MACHINE_ACCESS_LEVELS.map((value) => ({
          value,
          label: value,
          hint: {
            portal: "Talk only",
            workers: "Workers in approved directories",
            shell: "Workers and shell",
            screen: "Workers, shell and desktop control",
          }[value],
        })),
        allowBack: true,
      });
      if (access !== undefined)
        await attempt(
          flow,
          () => services.machines(["access", id, access]),
          machine.accessEnforcement === "os-sandbox"
            ? `${id}: ${access} access saved within its OS boundary. Raising beyond ${machine.accessCeiling} requires an owner relaunch.`
            : `${id}: ${access} access saved. This is an authority preference.`,
        );
      continue;
    }
    if (choice === "transcripts") {
      await services.openSessions?.(id);
      continue;
    }
    if (choice === "remove") {
      const yes = await flow.readSelect({
        message: `Remove ${id} and its connections? Workers keep running.`,
        options: [
          { value: "yes", label: "Remove" },
          { value: "no", label: "Cancel" },
        ],
        allowBack: true,
      });
      if (yes === "yes" && (await attempt(flow, () => services.machines(["remove", id]), `Removed ${id}.`)))
        return;
      continue;
    }
    const session = machine.sessions[Number(choice.replace("session:", ""))];
    if (choice === "connect") await connectSession(flow, services, machine);
    else if (session?.connectionId)
      await connectionDetail(flow, services, session.connectionId, session.name, session.state);
    else if (session) await connectSession(flow, services, machine, session.name);
  }
}
async function connectSession(
  flow: SetupFlow,
  services: MachinesMenuServices,
  machine: Machine,
  discovered?: string,
): Promise<void> {
  const session =
    discovered ??
    (await flow.readText({
      message: "Herdr session name",
      allowBack: true,
      validate: (value) =>
        /^[\w][\w.-]{0,63}$/u.test(value.trim()) ? undefined : "Enter a valid session name.",
    }));
  if (session === undefined) return;
  const id = await flow.readText({
    message: "Connection name",
    placeholder: `${machine.id}-${session}`.toLowerCase(),
    validate: validId,
    allowBack: true,
  });
  if (id === undefined) return;
  await attempt(
    flow,
    () => services.machines(["sessions", machine.id, "--connect", session.trim(), "--id", id.trim()]),
    `Connected ${session}.`,
  );
}
async function connectionDetail(
  flow: SetupFlow,
  services: MachinesMenuServices,
  id: string,
  session: string,
  state: string,
): Promise<void> {
  for (;;) {
    const result = (await services.runtime(["list"])) as {
      connections?: { id: string; capacity?: number | null; workspaces?: { kind: string; path: string }[] }[];
    };
    const connection = result.connections?.find((entry) => entry.id === id);
    const action = await flow.readSelect({
      message: `${session} · ${id}`,
      options: [
        {
          value: "workspaces",
          label: "Workspaces…",
          hint: connection?.workspaces?.map((entry) => entry.path).join(", ") || "none approved",
        },
        {
          value: "capacity",
          label: "Worker capacity…",
          hint: connection?.capacity === null ? "unlimited" : String(connection?.capacity ?? "default"),
        },
        ...(id !== "default" && ["disabled", "unreachable"].includes(state)
          ? [
              {
                value: "reconnect",
                label: state === "disabled" ? "Reconnect" : "Retry connection",
                hint: "Keep this session and its grants",
              },
            ]
          : []),
        ...(id === "default"
          ? []
          : [{ value: "disconnect", label: "Disconnect…", hint: "workers keep running" }]),
      ],
      allowBack: true,
    });
    if (action === undefined) return;
    if (action === "reconnect") {
      if (await attempt(flow, () => services.runtime(["reconnect", id]), `Reconnected ${id}.`)) return;
    } else if (action === "disconnect") {
      const yes = await flow.readSelect({
        message: `Disconnect ${id}?`,
        options: [
          { value: "yes", label: "Disconnect" },
          { value: "no", label: "Cancel" },
        ],
        allowBack: true,
      });
      if (
        yes === "yes" &&
        (await attempt(flow, () => services.runtime(["disconnect", id]), `Disconnected ${id}.`))
      )
        return;
    } else if (action === "capacity") {
      const value = await flow.readText({
        message: "Maximum workers (or unlimited)",
        allowBack: true,
        validate: (value) =>
          value.trim() === "unlimited" || /^\d+$/u.test(value.trim())
            ? undefined
            : "Enter a nonnegative integer or unlimited.",
      });
      if (value !== undefined)
        await attempt(
          flow,
          () => services.runtime(["capacity", id, value.trim() === "unlimited" ? "--clear" : value.trim()]),
          "Capacity saved.",
        );
    } else if (action === "workspaces") {
      const kind = await flow.readSelect({
        message: "Replace approved workspaces",
        options: [
          { value: "--repo", label: "Repository…" },
          { value: "--dir", label: "Directory…" },
          { value: "--clear", label: "Clear grants" },
        ],
        allowBack: true,
      });
      if (!kind) continue;
      const path =
        kind === "--clear"
          ? undefined
          : await flow.readText({
              message: "Absolute path on this machine",
              allowBack: true,
              validate: (value) =>
                /^(?:\/|[A-Za-z]:[\\/])/u.test(value.trim()) ? undefined : "Enter an absolute path.",
            });
      if (kind !== "--clear" && path === undefined) continue;
      await attempt(
        flow,
        () => services.runtime(["workspaces", id, kind, ...(path === undefined ? [] : [path.trim()])]),
        "Workspace grants saved.",
      );
    }
  }
}
