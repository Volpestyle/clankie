import { expect, it, vi } from "vitest";
import {
  accountsHint,
  contactOptions,
  formatTranscript,
  projectLabel,
  relativeAge,
  runConnectionsMenu,
  runConnectionsSection,
  runtimesHint,
  swarmHint,
  type ConnectionsMenuServices,
} from "../src/connections-menu.ts";
import type { ClankieFaceShell } from "../src/shell/shell.ts";

const NOW = Date.parse("2026-09-25T22:00:00Z");

it("formats hints a person can scan", () => {
  expect(relativeAge("2026-09-25T21:59:30Z", NOW)).toBe("just now");
  expect(relativeAge("2026-09-25T21:57:00Z", NOW)).toBe("3m ago");
  expect(relativeAge("2026-09-25T19:00:00Z", NOW)).toBe("3h ago");
  expect(projectLabel("-Users-james-dev-clankie")).toBe("~/dev-clankie");
  expect(projectLabel("--Users-james-dev--")).toBe("~/dev");
  expect(projectLabel("C--Users-volpe-AppData-Local-Temp-x")).toBe("~/AppData-Local-Temp-x");
  expect(projectLabel("/Users/james/dev/rivals-agent")).toBe("~/dev/rivals-agent");
  expect(projectLabel(undefined)).toBe("unknown directory");
  expect(projectLabel("-Users-james--clankie-captain-evaluator")).toBe("~/.clankie-captain-evaluator");
  expect(runtimesHint([])).toBe("none");
  expect(runtimesHint([{ id: "default", state: "healthy", enabled: true }])).toBe("1 configured · 1 healthy");
  expect(swarmHint({ mode: "swarm", conversations: [1, 2, 3], connections: [] })).toBe(
    "3 conversations · 0 external coordinators",
  );
  expect(swarmHint({ mode: "unavailable" })).toBe("unavailable");
  expect(accountsHint({ linear: { status: "connected", account: { name: "James" } } })).toBe(
    "Linear: connected as James",
  );
  expect(
    formatTranscript([
      { type: "message", role: "operator", text: "status?" },
      { type: "tool", name: "bash", phase: "completed", detail: "ls\n-la" },
      { type: "message", role: "agent", text: "all green" },
    ]),
  ).toBe("you: status?\n  · bash completed — ls -la\nagent: all green");
  expect(formatTranscript([])).toBe("(nothing new)");
  expect(
    contactOptions([
      {
        personaId: "a",
        name: "clankie:global-default",
        swarm: { available: false, conversationId: "inbox" },
      },
      { personaId: "b", name: "clankie:global-default", swarm: { available: true, conversationId: "inbox" } },
      { personaId: "c", name: "runtime:claude-code", swarm: { available: false, conversationId: "conv-1" } },
    ]),
  ).toEqual([
    { value: "b", label: "clankie:global-default", hint: "available · inbox · 1 older" },
    { value: "c", label: "runtime:claude-code", hint: "offline · conv-1" },
  ]);
});

function fakeShell(selections: (string | undefined)[], texts: (string | undefined)[] = []) {
  const readSelect = vi.fn(async () => selections.shift());
  const results: { prompt: string; message: string }[] = [];
  const lines: string[] = [];
  const shell = {
    setupFlow: {
      begin: vi.fn(),
      end: vi.fn(),
      setStatus: vi.fn(),
      renderLine: (line: string) => lines.push(line),
      readSelect,
      readText: vi.fn(async () => texts.shift()),
      waitForInterrupt: () => ({ promise: new Promise<void>(() => undefined), dispose: vi.fn() }),
    },
    insertCommandResult: (prompt: string, message: string) => results.push({ prompt, message }),
  } as unknown as ClankieFaceShell;
  return { shell, readSelect, results, lines };
}

const values = (call: unknown[]) => (call[0] as { options: { value: string }[] }).options.map((o) => o.value);

function services(overrides: Partial<ConnectionsMenuServices> = {}) {
  const agentsCalls: string[][] = [];
  const agents = vi.fn(async (args: readonly string[]) => {
    agentsCalls.push([...args]);
    if (args[0] === "hosts" && args.length === 1)
      return { hosts: [{ id: "local" }, { id: "pc", ssh: "volpe@box", shell: "powershell" }] };
    if (args[0] === "list")
      return {
        sessions: [
          {
            ref: "pc:79b4e8ec-a455-444c-b285-d01660a1c52d",
            harness: "claude",
            sessionId: "79b4e8ec-a455-444c-b285-d01660a1c52d",
            project: "C--Users-volpe-dev-game",
            size: 4096,
            modifiedAt: "2026-09-25T21:50:00Z",
          },
        ],
        errors: [],
      };
    if (args[0] === "read" && args[2] === "--tail")
      return { entries: [{ type: "message", role: "agent", text: "last words" }] };
    if (args[0] === "read") return { entries: [{ type: "message", role: "agent", text: "ACK" }] };
    if (args[0] === "resume") return { outcome: "spawned", seat: { seatId: "pc/term_native" } };
    return {};
  });
  return {
    agentsCalls,
    services: {
      runtime: async (args: readonly string[]) =>
        args[0] === "inventory"
          ? {
              runtimes: [{ id: "default", state: "healthy", enabled: true }],
              swarms: { mode: "swarm", conversations: [], connections: [] },
              accounts: {},
            }
          : { connections: [] },
      swarm: async () => ({}),
      agents,
      now: () => NOW,
      ...overrides,
    } satisfies ConnectionsMenuServices,
  };
}

it("drills from the hub to a remote session and shows its latest turns", async () => {
  const { shell, readSelect, results } = fakeShell([
    "agents",
    "host:pc",
    "pc:79b4e8ec-a455-444c-b285-d01660a1c52d",
    "read",
    undefined, // back out of the session
    undefined, // back out of the host
    undefined, // back out of agents
    "done",
  ]);
  const { services: deps, agentsCalls } = services();
  await runConnectionsMenu(shell, deps);
  expect(values(readSelect.mock.calls[0]!)).toEqual([
    "runtimes",
    "swarm",
    "agents",
    "accounts",
    "json",
    "done",
  ]);
  expect(values(readSelect.mock.calls[1]!)).toEqual(["host:local", "host:pc", "add"]);
  expect(values(readSelect.mock.calls[2]!)).toEqual(["pc:79b4e8ec-a455-444c-b285-d01660a1c52d", "remove"]);
  expect(agentsCalls).toContainEqual(["list", "--host", "pc", "--limit", "30"]);
  expect(results).toEqual([
    { prompt: "/agents read pc:79b4e8ec-a455-444c-b285-d01660a1c52d", message: "agent: last words" },
  ]);
});

it("adds an SSH host from three answers", async () => {
  const { shell } = fakeShell(["add", "powershell", undefined], ["pc", "volpe@supedupsilly"]);
  const { services: deps, agentsCalls } = services();
  await runConnectionsSection("agents", shell, deps);
  expect(agentsCalls).toContainEqual([
    "hosts",
    "add",
    "pc",
    "--ssh",
    "volpe@supedupsilly",
    "--shell",
    "powershell",
  ]);
});

it("resumes a saved session through the ordinary native hire endpoint", async () => {
  const { shell, results } = fakeShell([
    "host:pc",
    "pc:79b4e8ec-a455-444c-b285-d01660a1c52d",
    "resume",
    undefined,
    undefined,
  ]);
  const { services: deps, agentsCalls } = services();
  await runConnectionsSection("agents", shell, deps);
  expect(agentsCalls).toContainEqual(["resume", "pc:79b4e8ec-a455-444c-b285-d01660a1c52d"]);
  expect(results).toEqual([
    {
      prompt: "/agents resume pc:79b4e8ec-a455-444c-b285-d01660a1c52d",
      message: "Native seat pc/term_native is ready.",
    },
  ]);
});

it("reports a refused read in place instead of leaving the modal", async () => {
  const { shell, lines } = fakeShell([
    "host:pc",
    "pc:79b4e8ec-a455-444c-b285-d01660a1c52d",
    "read",
    undefined,
    undefined,
    undefined,
  ]);
  const { services: deps } = services();
  const agents = deps.agents;
  deps.agents = vi.fn(async (args: readonly string[]) => {
    if (args[0] === "read") throw new Error("Transcript path outside allowed roots");
    return agents(args);
  });
  await runConnectionsSection("agents", shell, deps);
  expect(lines).toContain("Transcript path outside allowed roots");
});

it("puts an error that ends the menu into the chat, where it outlives the status line", async () => {
  const { shell, results } = fakeShell(["runtimes"]);
  const { services: deps } = services({
    runtime: async (args: readonly string[]) => {
      if (args[0] === "inventory") return { runtimes: [], swarms: {}, accounts: {} };
      throw new Error("Runtime connections need the operator credential");
    },
  });
  await runConnectionsMenu(shell, deps);
  expect(results).toEqual([
    { prompt: "/connections", message: "Runtime connections need the operator credential" },
  ]);
});

it("shows each runtime's worker mode and changes it through the runtime command", async () => {
  const { shell, readSelect, lines } = fakeShell(["runtime:named", "mode", "interactive", undefined]);
  const calls: string[][] = [];
  const { services: deps } = services({
    runtime: async (args: readonly string[]) => {
      calls.push([...args]);
      return args[0] === "list"
        ? {
            connections: [
              { id: "named", state: "healthy", enabled: true, capacity: 2, workerMode: "stream" },
              { id: "pc", state: "healthy", enabled: true, transport: "ssh" },
            ],
          }
        : { id: "named", workerMode: "interactive" };
    },
  });
  await runConnectionsSection("runtimes", shell, deps);
  const list = (readSelect.mock.calls[0] as unknown[])[0] as { options: { value: string; hint?: string }[] };
  expect(list.options[0]!.hint).toBe("healthy · 2 workers per coordinator · stream workers");
  // An ssh fleet's peers enroll themselves: no worker mode to show or change.
  expect(list.options[1]!.hint).toBe("healthy");
  expect(values(readSelect.mock.calls[1]!)).toContain("mode");
  expect(values(readSelect.mock.calls[2]!)).toEqual(["interactive"]);
  expect(calls).toContainEqual(["mode", "named", "interactive"]);
  expect(lines).toContain("named runs interactive workers.");
});

it("selects a managed harness through the runtime CLI", async () => {
  const { shell, readSelect, lines } = fakeShell(["runtime:default", "harness", "codex", undefined]);
  const calls: string[][] = [];
  const { services: deps } = services({
    runtime: async (args: readonly string[]) => {
      calls.push([...args]);
      return args[0] === "list"
        ? {
            connections: [{ id: "default", state: "healthy", workerHarness: "claude", workerMode: "stream" }],
          }
        : { id: "default", workerHarness: "codex" };
    },
  });
  await runConnectionsSection("runtimes", shell, deps);
  expect(values(readSelect.mock.calls[2]!)).toEqual(["codex", "pi", "claude"]);
  expect(calls).toContainEqual(["harness", "default", "codex"]);
  expect(lines).toContain("default uses codex workers.");
});
