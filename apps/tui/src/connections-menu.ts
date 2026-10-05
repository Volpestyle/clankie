import { machinesSection, runMachinesMenu } from "./machines-menu.ts";
/**
 * `/connections` as a modal: machines and accounts,
 * with saved agent sessions available from each machine — as
 * menus you drill into instead of one JSON blob. `/runtime` and
 * `/sessions` open the same machines menu. Every read goes through the same command
 * clients the CLI uses, so the modal and `clankie connections` never disagree.
 */
import type { ClankieFaceShell } from "./shell/shell.ts";
import type { MenuOption, SetupFlow } from "./shell/setup-flow.ts";
import {
  AccountsResponseSchema,
  AccountGithubStartResultSchema,
  AccountGithubPollResultSchema,
  AccountLinearStartResultSchema,
  AccountDisconnectResultSchema,
  AccountLinearCompleteResultSchema,
} from "@clankie/protocol/accounts";
import { parseLinearAccountCallback, validateLinearAccountStart } from "@clankie/api-client/accounts";

type Json = Record<string, unknown>;
type Run = (args: readonly string[]) => Promise<unknown>;

export interface ConnectionsMenuServices {
  readonly machines: Run;
  readonly runtime: Run;
  readonly agents: Run;
  readonly accounts?: (args: readonly string[], input?: string) => Promise<unknown>;
  /** Injected for tests; how often a reply wait re-checks its run. */
  readonly now?: () => number;
}

interface AgentSession {
  readonly ref: string;
  readonly harness: string;
  readonly sessionId: string;
  readonly project?: string;
  readonly size?: number;
  readonly source?: { readonly kind: "opencode-sqlite" };
  readonly modifiedAt: string;
}
interface AgentHost {
  readonly id: string;
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
    hint: `${relativeAge(session.modifiedAt, now)} · ${session.sessionId.slice(0, 8)}${session.source ? " · stored native history" : ""}`,
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
      else if (choice === "accounts") {
        if (services.accounts) await providerAccountsSection(flow, services.accounts);
        else await accountsSection(flow, record(inventory.accounts));
      } else shell.insertCommandResult("/connections json", JSON.stringify(inventory, null, 2), "success");
    }
  } catch (error) {
    // Closing the flow resets the status line, so a fatal error goes to the chat.
    shell.insertCommandResult("/connections", message(error), "error");
  } finally {
    flow.end();
  }
}

async function providerAccountsSection(
  flow: SetupFlow,
  run: NonNullable<ConnectionsMenuServices["accounts"]>,
): Promise<void> {
  for (;;) {
    const parsed = AccountsResponseSchema.safeParse(await run([]));
    if (!parsed.success) throw new Error("Account connections unavailable");
    const choice = await flow.readSelect({
      message: "Account connections",
      options: parsed.data.connections.map((connection) => ({
        value: connection.provider,
        label: connection.provider === "github" ? "GitHub" : "Linear",
        hint: `${connection.status.replaceAll("_", " ")}${connection.account ? ` · ${connection.account}` : ""}`,
        description: connection.scopes.length
          ? `Granted scopes: ${connection.scopes.join(", ")}`
          : "No granted scopes",
      })),
      allowBack: true,
    });
    const connection = parsed.data.connections.find((item) => item.provider === choice);
    if (!connection) return;
    if (connection.status === "unconfigured") {
      flow.renderLine("The OAuth application has not been configured for this Clankie.", "info");
      continue;
    }
    const action = await flow.readSelect({
      message: connection.provider === "github" ? "GitHub" : "Linear",
      options: [
        {
          value: connection.status === "connected" ? "disconnect" : "connect",
          label: connection.status === "connected" ? "Disconnect" : "Connect",
        },
      ],
      allowBack: true,
    });
    if (!action) continue;
    try {
      if (action === "disconnect") {
        const result = AccountDisconnectResultSchema.safeParse(
          await run(["disconnect", connection.provider]),
        );
        if (!result.success || !result.data.ok) throw new Error("Account disconnect unavailable");
        flow.renderLine(
          result.data.revoked
            ? "Disconnected and revoked."
            : "Disconnected on this Clankie. Revoke the remaining grant at the provider.",
          result.data.revoked ? "success" : "info",
        );
        if (!result.data.revoked && result.data.manageUrl) flow.renderLine(result.data.manageUrl, "info");
      } else if (connection.provider === "github") {
        const start = AccountGithubStartResultSchema.safeParse(await run(["start", "github"]));
        if (!start.success || !start.data.ok) throw new Error("GitHub connection unavailable");
        flow.renderLine(`Open ${start.data.verificationUri} and enter ${start.data.userCode}`, "info");
        for (;;) {
          const check = await flow.readSelect({
            message: "Authorize GitHub in your browser, then check the connection",
            options: [{ value: "check", label: "Check connection" }],
            allowBack: true,
          });
          if (!check) break;
          const result = AccountGithubPollResultSchema.safeParse(
            await run(["poll", "github", "--flow-id", start.data.flowId]),
          );
          if (!result.success || !result.data.ok) throw new Error("GitHub authorization did not complete");
          if (result.data.status === "connected") {
            flow.renderLine("GitHub connected.", "success");
            break;
          }
          flow.renderLine(`Still waiting; check again after ${result.data.interval} seconds.`, "info");
        }
      } else {
        const start = AccountLinearStartResultSchema.safeParse(await run(["connect", "linear"]));
        if (!start.success || !start.data.ok) throw new Error("Linear connection unavailable");
        validateLinearAccountStart(start.data);
        flow.renderLine(`Open ${start.data.authorizeUrl}`, "info");
        const callback = await flow.readSecret({
          message: "Paste the Open Clankie callback link after authorization",
          allowBack: true,
        });
        if (!callback) continue;
        const input = parseLinearAccountCallback(callback, start.data);
        if ("error" in input) throw new Error("Linear authorization did not complete");
        const result = AccountLinearCompleteResultSchema.safeParse(
          await run(["complete", "linear", "--json-stdin"], JSON.stringify(input)),
        );
        if (!result.success || !result.data.ok) throw new Error("Linear connection unavailable");
        flow.renderLine("Linear connected.", "success");
      }
    } catch {
      flow.renderLine(
        "Account authorization did not complete. Start a fresh connection to try again.",
        "error",
      );
    }
  }
}

/** All no-argument machine aliases share the same menu and saved-session drilldown. */
export async function runMachineConnectionsMenu(
  shell: ClankieFaceShell,
  services: ConnectionsMenuServices,
): Promise<void> {
  await runMachinesMenu(shell, { ...services, openSessions: (id) => hostSessions(shell, services, { id }) });
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
      const result = record(await services.agents(["list", "--host", host.id, "--limit", "30"]));
      sessions = array<AgentSession>(result.sessions);
      for (const error of array<{ host: string; error: string }>(result.errors))
        flow.renderLine(`${error.host}: ${error.error}`, "error");
    } catch (error) {
      flow.renderLine(`${host.id}: ${message(error)}`, "error");
      sessions = [];
    } finally {
      flow.setStatus(host.id);
    }
    const choice = await flow.readSelect({
      message: `Sessions on ${host.id}`,
      options: sessions.map((session) => sessionOption(session, now())),
      allowBack: true,
    });
    if (choice === undefined) return;
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
        {
          value: "resume",
          label: session.source ? "Reuse live native seat" : "Resume in native TUI",
          hint: session.source
            ? "original controller required; no new process"
            : "reuse its live seat or reopen in Herdr",
        },
      ],
      allowBack: true,
    });
    if (action === undefined) return;
    try {
      if (action === "resume") {
        const conversation = session.source
          ? await flow.readText({
              message: "Hiring conversation ID",
              allowBack: true,
              validate: (value) =>
                value.trim() ? undefined : "Enter the conversation that hired this worker.",
            })
          : undefined;
        if (session.source && conversation === undefined) continue;
        const result = record(
          await services.agents([
            "resume",
            session.ref,
            ...(conversation ? ["--conversation", conversation.trim()] : []),
          ]),
        );
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
        `${session.source ? "Stored native history (staged revert may differ from the live TUI).\n" : ""}${formatTranscript(array(page.entries))}`,
        "success",
      );
    } catch (error) {
      flow.renderLine(message(error), "error");
    }
  }
}
