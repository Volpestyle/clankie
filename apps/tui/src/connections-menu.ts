/**
 * `/connections` as a modal: what Clankie is connected to — execution runtimes,
 * Swarm, the agent sessions he can read and resume, and linked accounts — as
 * menus you drill into instead of one JSON blob. `/runtime`, `/swarm` and
 * `/agents` open their own section. Every read goes through the same command
 * clients the CLI uses, so the modal and `clankie connections` never disagree.
 */
import type { ClankieFaceShell } from "./shell/shell.ts";
import type { MenuOption, SetupFlow } from "./shell/setup-flow.ts";

type Json = Record<string, unknown>;
type Run = (args: readonly string[]) => Promise<unknown>;

export interface ConnectionsMenuServices {
  readonly runtime: Run;
  readonly swarm: Run;
  readonly agents: Run;
  /** The existing `/herdr` menu, for the runtime Clankie runs his own workers in. */
  readonly openHerdrSettings?: () => Promise<void>;
  /** Injected for tests; how often a reply wait re-checks its run. */
  readonly now?: () => number;
}

interface Runtime {
  readonly id: string;
  readonly kind?: string;
  readonly session?: string;
  readonly socketPath?: string;
  readonly state?: string;
  readonly enabled?: boolean;
  readonly capacity?: number | null;
  readonly capacitySource?: string;
  /** How Swarm runs the workers it dispatches here (ADR 0194); absent for an ssh fleet. */
  readonly workerHarness?: "claude" | "codex" | "pi";
  readonly workerMode?: "stream" | "interactive";
  readonly budget?: number | null;
  readonly budgetSource?: string;
  readonly capabilities?: readonly string[];
}
interface AgentSession {
  readonly ref: string;
  readonly harness: string;
  readonly sessionId: string;
  readonly project?: string;
  readonly size: number;
  readonly modifiedAt: string;
}
interface AgentHost {
  readonly id: string;
  readonly ssh?: string;
  readonly shell?: string;
}
interface TranscriptEntry {
  readonly type: string;
  readonly role?: string;
  readonly text?: string;
  readonly name?: string;
  readonly phase?: string;
  readonly detail?: string;
}
interface Contact {
  readonly personaId: string;
  readonly name: string;
  readonly updatedAt?: string;
  readonly swarm?: { readonly available?: boolean; readonly conversationId?: string };
}

const array = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const record = (value: unknown): Json => (value !== null && typeof value === "object" ? (value as Json) : {});
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ─── Formatting (pure; unit-tested) ────────────────────────────────────────

export function relativeAge(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return "unknown";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/** Harnesses encode the launch directory lossily; show it the way a person would type it. */
export function projectLabel(project: string | undefined): string {
  if (project === undefined || project === "") return "unknown directory";
  if (project.startsWith("/") || /^[A-Za-z]:\\/u.test(project))
    return project.replace(/^\/(?:Users|home)\/[^/]+/u, "~").replace(/^[A-Za-z]:\\Users\\[^\\]+/u, "~");
  const trimmed = project.replace(/^-+|-+$/gu, "");
  // Claude writes `/.` as `--`, so a leading dash after home was a dot-folder.
  const label = trimmed
    .replace(/^(?:[A-Za-z]-+)?(?:Users|home)-[^-]+-?/u, "~/")
    .replace(/^~\/-/u, "~/.")
    .replace(/\/$/u, "");
  return label || "~";
}

function runtimeHint(runtime: Runtime): string {
  const parts = [
    runtime.enabled === false ? "disabled" : (runtime.state ?? "unknown"),
    runtime.session === undefined ? undefined : `session ${runtime.session}`,
    runtime.capacity === undefined
      ? undefined
      : runtime.capacity === null
        ? "unlimited workers"
        : `${runtime.capacity} workers per coordinator${runtime.capacitySource === "default" ? " (default)" : ""}`,
    runtime.workerHarness === undefined ? undefined : `${runtime.workerHarness} harness`,
    runtime.workerMode === undefined ? undefined : `${runtime.workerMode} workers`,
  ];
  return parts.filter(Boolean).join(" · ");
}

export function runtimesHint(runtimes: readonly Runtime[]): string {
  if (runtimes.length === 0) return "none";
  const healthy = runtimes.filter((runtime) => runtime.state === "healthy" && runtime.enabled !== false);
  return `${runtimes.length} configured · ${healthy.length} healthy`;
}

export function swarmHint(swarm: Json): string {
  if (swarm.mode === "unavailable") return "unavailable";
  const conversations = array(swarm.conversations).length;
  const external = array(swarm.connections).length;
  return `${conversations} conversation${conversations === 1 ? "" : "s"} · ${external} external coordinator${external === 1 ? "" : "s"}`;
}

export function accountsHint(accounts: Json): string {
  const linear = record(accounts.linear);
  if (linear.status === undefined) return "none";
  const account = record(linear.account);
  const who =
    typeof account.name === "string"
      ? account.name
      : typeof account.email === "string"
        ? account.email
        : undefined;
  return `Linear: ${String(linear.status)}${who ? ` as ${who}` : ""}`;
}

function hostsHint(hosts: readonly AgentHost[]): string {
  return hosts.map((host) => host.id).join(" + ");
}

function sessionOption(session: AgentSession, now: number): MenuOption {
  return {
    value: session.ref,
    label: `${session.harness.padEnd(6)} ${session.project === undefined ? "—" : projectLabel(session.project)}`,
    hint: `${relativeAge(session.modifiedAt, now)} · ${session.sessionId.slice(0, 8)}`,
  };
}

/**
 * One row per actor: Swarm keeps each re-enrolled generation as its own
 * contact, so prefer the one that is available, else the newest, and say how
 * many older ones were folded in.
 */
export function contactOptions(contacts: readonly Contact[]): MenuOption[] {
  const groups = new Map<string, Contact[]>();
  for (const contact of contacts) {
    const key = `${contact.name}\u0000${contact.swarm?.conversationId ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), contact]);
  }
  return [...groups.values()].map((group) => {
    const chosen =
      group.find((contact) => contact.swarm?.available === true) ??
      [...group].sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))[0]!;
    const older = group.length - 1;
    return {
      value: chosen.personaId,
      label: chosen.name,
      hint: [
        chosen.swarm?.available === true ? "available" : "offline",
        chosen.swarm?.conversationId,
        older > 0 ? `${older} older` : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  });
}

/** A transcript page as readable lines: who said what, and which tools ran. */
export function formatTranscript(entries: readonly TranscriptEntry[]): string {
  if (entries.length === 0) return "(nothing new)";
  return entries
    .map((entry) => {
      if (entry.type === "message") {
        const who = entry.role === "operator" ? "you" : "agent";
        return `${who}: ${(entry.text ?? "").trim()}`;
      }
      if (entry.type === "tool") {
        const detail = (entry.detail ?? "").replace(/\s+/gu, " ").slice(0, 100);
        return `  · ${entry.name ?? "tool"} ${entry.phase ?? ""}${detail ? ` — ${detail}` : ""}`;
      }
      return "  · viewed an image";
    })
    .join("\n");
}

// ─── Menus ─────────────────────────────────────────────────────────────────

export async function runConnectionsMenu(
  shell: ClankieFaceShell,
  services: ConnectionsMenuServices,
): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("connections");
  try {
    for (;;) {
      flow.setStatus("Reading connections…");
      const [inventory, hosts] = await Promise.all([
        services.runtime(["inventory"]).then(record, (error: unknown): Json => ({ error: message(error) })),
        services.agents(["hosts"]).then(
          (result) => array<AgentHost>(record(result).hosts),
          () => [] as AgentHost[],
        ),
      ]);
      flow.setStatus("connections");
      if (typeof inventory.error === "string") flow.renderLine(inventory.error, "error");
      const choice = await flow.readSelect({
        message: "Connections",
        options: [
          {
            value: "runtimes",
            label: "Execution runtimes",
            hint: runtimesHint(array<Runtime>(inventory.runtimes)),
          },
          {
            value: "swarm",
            label: "Swarm",
            hint: swarmHint(record(inventory.swarms)),
          },
          {
            value: "agents",
            label: "Agent sessions",
            hint: hosts.length === 0 ? "unavailable" : hostsHint(hosts),
          },
          {
            value: "accounts",
            label: "Accounts",
            hint: accountsHint(record(inventory.accounts)),
          },
          { value: "json", label: "Raw inventory", hint: "JSON" },
          { value: "done", label: "Done" },
        ],
      });
      if (choice === undefined || choice === "done") return;
      if (choice === "runtimes") await runtimesSection(shell, services);
      else if (choice === "swarm") await swarmSection(shell, services);
      else if (choice === "agents") await agentsSection(shell, services);
      else if (choice === "accounts") await accountsSection(flow, record(inventory.accounts));
      else shell.insertCommandResult("/connections json", JSON.stringify(inventory, null, 2), "success");
    }
  } catch (error) {
    // Closing the flow resets the status line, so a fatal error goes to the chat.
    shell.insertCommandResult("/connections", message(error), "error");
  } finally {
    flow.end();
  }
}

/** One section on its own, for `/runtime`, `/swarm` and `/agents` with no argument. */
export async function runConnectionsSection(
  section: "runtimes" | "swarm" | "agents",
  shell: ClankieFaceShell,
  services: ConnectionsMenuServices,
): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin(section);
  try {
    if (section === "runtimes") await runtimesSection(shell, services);
    else if (section === "swarm") await swarmSection(shell, services);
    else await agentsSection(shell, services);
  } catch (error) {
    // Closing the flow resets the status line, so a fatal error goes to the chat.
    shell.insertCommandResult("/connections", message(error), "error");
  } finally {
    flow.end();
  }
}

async function accountsSection(flow: SetupFlow, accounts: Json): Promise<void> {
  const linear = record(accounts.linear);
  const account = record(linear.account);
  const who =
    typeof account.name === "string"
      ? account.name
      : typeof account.email === "string"
        ? account.email
        : undefined;
  await flow.readSelect({
    message: "Accounts — add or change them with /connect",
    options: [
      {
        value: "linear",
        label: "Linear",
        hint:
          linear.status === undefined
            ? "not connected"
            : `${String(linear.status)}${who ? ` as ${who}` : ""}`,
      },
    ],
    allowBack: true,
  });
}

async function confirm(flow: SetupFlow, question: string, yes: string): Promise<boolean> {
  const answer = await flow.readSelect({
    message: question,
    options: [
      { value: "yes", label: yes },
      { value: "no", label: "Cancel" },
    ],
    allowBack: true,
  });
  return answer === "yes";
}

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

async function runtimesSection(shell: ClankieFaceShell, services: ConnectionsMenuServices): Promise<void> {
  const flow = shell.setupFlow;
  for (;;) {
    const runtimes = array<Runtime>(record(await services.runtime(["list"])).connections);
    const choice = await flow.readSelect({
      message: "Execution runtimes",
      options: [
        ...runtimes.map((runtime) => ({
          value: `runtime:${runtime.id}`,
          label: runtime.id,
          hint: runtimeHint(runtime),
        })),
        {
          value: "connect",
          label: "Connect a Herdr session…",
          hint: "name it, point at a session",
        },
        ...(services.openHerdrSettings
          ? [{ value: "herdr", label: "Herdr settings…", hint: "Clankie's own runtime" }]
          : []),
      ],
      allowBack: true,
    });
    if (choice === undefined) return;
    if (choice === "herdr") {
      await services.openHerdrSettings?.();
      continue;
    }
    if (choice === "connect") {
      const id = await flow.readText({
        message: "Name for this runtime",
        placeholder: "e.g. build",
        allowBack: true,
        validate: (value) =>
          /^[a-z][a-z0-9-]{0,63}$/u.test(value.trim()) && value.trim() !== "default"
            ? undefined
            : "Lowercase letters, digits and dashes; not 'default'.",
      });
      if (id === undefined) continue;
      const session = await flow.readText({
        message: "Herdr session name",
        placeholder: "e.g. workers",
        allowBack: true,
        validate: (value) => (value.trim() ? undefined : "Enter a session name."),
      });
      if (session === undefined) continue;
      await attempt(
        flow,
        () => services.runtime(["connect", id.trim(), "--session", session.trim()]),
        `Connected ${id.trim()}.`,
      );
      continue;
    }
    const runtime = runtimes.find((entry) => `runtime:${entry.id}` === choice);
    if (runtime !== undefined) await runtimeDetail(flow, services, runtime);
  }
}

/** Details as rows of the menu itself: status lines only hold one line. */
async function runtimeDetail(
  flow: SetupFlow,
  services: ConnectionsMenuServices,
  runtime: Runtime,
): Promise<void> {
  const info: MenuOption[] = [
    {
      value: "info:state",
      label: "State",
      hint: runtime.enabled === false ? "disabled" : (runtime.state ?? "unknown"),
    },
    ...(runtime.session ? [{ value: "info:session", label: "Session", hint: runtime.session }] : []),
    ...(runtime.socketPath ? [{ value: "info:socket", label: "Socket", hint: runtime.socketPath }] : []),
    ...(runtime.capacity === undefined
      ? []
      : [
          {
            value: "info:capacity",
            label: "Capacity per coordinator",
            hint:
              runtime.capacity === null
                ? "unlimited"
                : `${runtime.capacity} (${runtime.capacitySource ?? "owner"})`,
          },
        ]),
    ...(runtime.budget === undefined
      ? []
      : [
          {
            value: "info:budget",
            label: "Budget per coordinator",
            hint:
              runtime.budget === null
                ? "unlimited"
                : `${runtime.budget} (${runtime.budgetSource ?? "owner"})`,
          },
        ]),
    ...(runtime.capabilities?.length
      ? [{ value: "info:capabilities", label: "Capabilities", hint: runtime.capabilities.join(", ") }]
      : []),
    ...(runtime.workerHarness === undefined
      ? []
      : [{ value: "harness", label: "Worker harness…", hint: runtime.workerHarness }]),
    ...(runtime.workerMode === undefined
      ? []
      : [{ value: "mode", label: "Worker mode…", hint: runtime.workerMode }]),
  ];
  for (;;) {
    const action = await flow.readSelect({
      message: runtime.id,
      options: [
        ...info,
        // The fleet's own runtime is managed from Herdr settings, not disconnected here.
        ...(runtime.id === "default"
          ? []
          : [{ value: "disconnect", label: "Disconnect…", hint: "workers keep running" }]),
      ],
      allowBack: true,
    });
    if (action === undefined) return;
    if (action === "harness") {
      const harness = await flow.readSelect({
        message: `Worker harness in ${runtime.id}`,
        options: [
          { value: "codex", label: "Codex", hint: "gpt-6-astra; stream workers" },
          { value: "pi", label: "pi", hint: "native model preference; stream workers" },
          { value: "claude", label: "Claude", hint: "stream or supported interactive workers" },
        ],
        allowBack: true,
      });
      if (harness === undefined || harness === runtime.workerHarness) continue;
      if (
        await attempt(
          flow,
          () => services.runtime(["harness", runtime.id, harness]),
          `${runtime.id} uses ${harness} workers.`,
        )
      )
        return;
      continue;
    }
    if (action === "mode") {
      const mode = await flow.readSelect({
        message: `How Swarm runs workers in ${runtime.id}`,
        options: [
          { value: "stream", label: "Stream", hint: "unattended; the default" },
          {
            value: "interactive",
            label: "Interactive",
            hint: "Claude in the pane; needs the clankie-worker plugin",
          },
        ],
        allowBack: true,
      });
      if (mode === undefined || mode === runtime.workerMode) continue;
      if (
        await attempt(
          flow,
          () => services.runtime(["mode", runtime.id, mode]),
          `${runtime.id} runs ${mode} workers.`,
        )
      )
        return;
      continue;
    }
    if (action !== "disconnect") continue;
    if (!(await confirm(flow, `Disconnect ${runtime.id}?`, "Disconnect"))) continue;
    if (
      await attempt(flow, () => services.runtime(["disconnect", runtime.id]), `Disconnected ${runtime.id}.`)
    )
      return;
  }
}

async function swarmSection(shell: ClankieFaceShell, services: ConnectionsMenuServices): Promise<void> {
  const flow = shell.setupFlow;
  for (;;) {
    const status = record(await services.swarm(["status"]));
    const external = array<Json>(status.connections);
    const choice = await flow.readSelect({
      message: `Swarm — ${swarmHint(status)}`,
      options: [
        { value: "contacts", label: "Contacts", hint: "message an agent" },
        ...external.map((connection) => ({
          value: `connection:${String(connection.id)}`,
          label: `Coordinator ${String(connection.id)}`,
          hint: connection.enabled === false ? "disabled" : "connected",
        })),
      ],
      allowBack: true,
    });
    if (choice === undefined) return;
    if (choice === "contacts") {
      await contactsSection(flow, services);
      continue;
    }
    const id = choice.slice("connection:".length);
    if (await confirm(flow, `Disconnect coordinator ${id}?`, "Disconnect"))
      await attempt(flow, () => services.swarm(["disconnect", id]), `Disconnected ${id}.`);
  }
}

async function contactsSection(flow: SetupFlow, services: ConnectionsMenuServices): Promise<void> {
  const contacts = array<Contact>(await services.swarm(["contacts"]));
  if (contacts.length === 0) {
    flow.renderLine("No Swarm contacts yet.", "info");
    return;
  }
  const personaId = await flow.readSelect({
    message: "Swarm contacts",
    options: contactOptions(contacts),
    allowBack: true,
  });
  if (personaId === undefined) return;
  const contact = contacts.find((entry) => entry.personaId === personaId)!;
  const text = await flow.readText({
    message: `Message ${contact.name}`,
    multiline: true,
    allowBack: true,
    validate: (value) => (value.trim() ? undefined : "Write a message."),
  });
  if (text === undefined) return;
  await attempt(flow, () => services.swarm(["message", personaId, text.trim()]), `Sent to ${contact.name}.`);
}

async function agentsSection(shell: ClankieFaceShell, services: ConnectionsMenuServices): Promise<void> {
  const flow = shell.setupFlow;
  for (;;) {
    const hosts = array<AgentHost>(record(await services.agents(["hosts"])).hosts);
    const choice = await flow.readSelect({
      message: "Agent hosts",
      options: [
        ...hosts.map((host) => ({
          value: `host:${host.id}`,
          label: host.id,
          hint: host.id === "local" ? "this machine" : `${host.ssh} · ${host.shell}`,
        })),
        { value: "add", label: "Add an SSH host…", hint: "a PC or server with sshd" },
      ],
      allowBack: true,
    });
    if (choice === undefined) return;
    if (choice === "add") {
      await addHost(flow, services);
      continue;
    }
    const host = hosts.find((entry) => `host:${entry.id}` === choice);
    if (host !== undefined) await hostSessions(shell, services, host);
  }
}

async function addHost(flow: SetupFlow, services: ConnectionsMenuServices): Promise<void> {
  const id = await flow.readText({
    message: "Short name for the host",
    placeholder: "e.g. pc",
    allowBack: true,
    validate: (value) =>
      /^[a-z][a-z0-9-]{0,63}$/u.test(value.trim()) && value.trim() !== "local"
        ? undefined
        : "Lowercase letters, digits and dashes; not 'local'.",
  });
  if (id === undefined) return;
  const ssh = await flow.readText({
    message: "SSH target (user@host or an ~/.ssh/config alias)",
    placeholder: "e.g. volpe@supedupsilly",
    allowBack: true,
    validate: (value) => (value.trim() ? undefined : "Enter an SSH target."),
  });
  if (ssh === undefined) return;
  const shellKind = await flow.readSelect({
    message: "Its default shell",
    options: [
      { value: "posix", label: "macOS / Linux", hint: "sh" },
      { value: "powershell", label: "Windows", hint: "PowerShell" },
    ],
    allowBack: true,
  });
  if (shellKind === undefined) return;
  await attempt(
    flow,
    () => services.agents(["hosts", "add", id.trim(), "--ssh", ssh.trim(), "--shell", shellKind]),
    `Added ${id.trim()}. Nothing is installed there; reads use SSH.`,
  );
}

async function hostSessions(
  shell: ClankieFaceShell,
  services: ConnectionsMenuServices,
  host: AgentHost,
): Promise<void> {
  const flow = shell.setupFlow;
  const now = services.now ?? Date.now;
  for (;;) {
    flow.setStatus(`Listing sessions on ${host.id}…`);
    let sessions: AgentSession[];
    try {
      sessions = array<AgentSession>(
        record(await services.agents(["list", "--host", host.id, "--limit", "30"])).sessions,
      );
    } catch (error) {
      flow.renderLine(`${host.id}: ${message(error)}`, "error");
      sessions = [];
    } finally {
      flow.setStatus(host.id);
    }
    const choice = await flow.readSelect({
      message: `Sessions on ${host.id}`,
      options: [
        ...sessions.map((session) => sessionOption(session, now())),
        ...(host.id === "local" ? [] : [{ value: "remove", label: `Remove ${host.id}…` }]),
      ],
      allowBack: true,
    });
    if (choice === undefined) return;
    if (choice === "remove") {
      if (await confirm(flow, `Stop reading sessions on ${host.id}?`, "Remove host")) {
        if (await attempt(flow, () => services.agents(["hosts", "remove", host.id]), `Removed ${host.id}.`))
          return;
      }
      continue;
    }
    const session = sessions.find((entry) => entry.ref === choice);
    if (session !== undefined) await sessionActions(shell, services, session);
  }
}

async function sessionActions(
  shell: ClankieFaceShell,
  services: ConnectionsMenuServices,
  session: AgentSession,
): Promise<void> {
  const flow = shell.setupFlow;
  const title = `${session.harness} · ${projectLabel(session.project)}`;
  for (;;) {
    const action = await flow.readSelect({
      message: title,
      options: [
        { value: "read", label: "Read latest", hint: "last 20 entries" },
        { value: "resume", label: "Resume in native TUI", hint: "reuse its live seat or reopen in Herdr" },
      ],
      allowBack: true,
    });
    if (action === undefined) return;
    try {
      if (action === "resume") {
        const result = record(await services.agents(["resume", session.ref]));
        if (result.outcome !== "spawned")
          throw new Error(String(result.detail ?? result.reason ?? "Could not resume session"));
        shell.insertCommandResult(
          `/agents resume ${session.ref}`,
          `Native seat ${String(record(result.seat).seatId)} is ready.`,
          "success",
        );
        return;
      }
      const page = record(await services.agents(["read", session.ref, "--tail", "20"]));
      shell.insertCommandResult(
        `/agents read ${session.ref}`,
        formatTranscript(array(page.entries)),
        "success",
      );
    } catch (error) {
      flow.renderLine(message(error), "error");
    }
  }
}
