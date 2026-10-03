import { machinesSection } from "./machines-menu.ts";
/**
 * `/connections` as a modal: machines and accounts,
 * with saved agent sessions available from each machine — as
 * menus you drill into instead of one JSON blob. `/sessions` and
 * `/agents` open their own section. Every read goes through the same command
 * clients the CLI uses, so the modal and `clankie connections` never disagree.
 */
import type { ClankieFaceShell } from "./shell/shell.ts";
import type { MenuOption, SetupFlow } from "./shell/setup-flow.ts";

type Json = Record<string, unknown>;
type Run = (args: readonly string[]) => Promise<unknown>;

export interface ConnectionsMenuServices {
  readonly machines: Run;
  readonly runtime: Run;
  readonly agents: Run;
  /** The existing `/herdr` menu, for the runtime Clankie runs his own workers in. */
  readonly openHerdrSettings?: () => Promise<void>;
  /** Injected for tests; how often a reply wait re-checks its run. */
  readonly now?: () => number;
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

function sessionOption(session: AgentSession, now: number): MenuOption {
  return {
    value: session.ref,
    label: `${session.harness.padEnd(6)} ${session.project === undefined ? "—" : projectLabel(session.project)}`,
    hint: `${relativeAge(session.modifiedAt, now)} · ${session.sessionId.slice(0, 8)}`,
  };
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
      const inventory = await services
        .runtime(["inventory"])
        .then(record, (error: unknown): Json => ({ error: message(error) }));
      flow.setStatus("connections");
      if (typeof inventory.error === "string") flow.renderLine(inventory.error, "error");
      const choice = await flow.readSelect({
        message: "Connections",
        options: [
          {
            value: "machines",
            label: "Machines",
            hint: "/machines · sessions and workers",
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
      if (choice === "machines")
        await machinesSection(shell, {
          ...services,
          openSessions: (id) => hostSessions(shell, services, { id }),
        });
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

/** One section on its own, for `/runtime` and `/agents` with no argument. */
export async function runConnectionsSection(
  section: "agents",
  shell: ClankieFaceShell,
  services: ConnectionsMenuServices,
): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin(section);
  try {
    await agentsSection(shell, services);
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
