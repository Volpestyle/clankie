import { expect, it, vi } from "vitest";
import {
  accountsHint,
  formatTranscript,
  projectLabel,
  relativeAge,
  runConnectionsMenu,
  runMachineConnectionsMenu,
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
      machines: async () => ({
        observedAt: new Date().toISOString(),
        machines: [
          {
            id: "pc",
            transport: "ssh",
            configured: true,
            ssh: "box",
            state: "available",
            workerCount: 0,
            sessions: [],
          },
        ],
      }),
      runtime: async (args: readonly string[]) =>
        args[0] === "inventory"
          ? {
              runtimes: [{ id: "default", state: "healthy", enabled: true }],
              accounts: {},
            }
          : { connections: [] },
      agents,
      now: () => NOW,
      ...overrides,
    } satisfies ConnectionsMenuServices,
  };
}

it("links the hub to machines without separate session sections", async () => {
  const { shell, readSelect } = fakeShell(["machines", undefined, "done"]);
  await runConnectionsMenu(shell, services().services);
  expect(values(readSelect.mock.calls[0]!)).toEqual(["machines", "accounts", "json", "done"]);
  expect(values(readSelect.mock.calls[1]!)).toEqual(["machine:pc", "add"]);
});

it("resumes a saved session through the ordinary native hire endpoint", async () => {
  const { shell, results } = fakeShell([
    "machine:pc",
    "transcripts",
    "pc:79b4e8ec-a455-444c-b285-d01660a1c52d",
    "resume",
    undefined,
    undefined,
  ]);
  const { services: deps, agentsCalls } = services();
  await runMachineConnectionsMenu(shell, deps);
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
    "machine:pc",
    "transcripts",
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
  await runMachineConnectionsMenu(shell, deps);
  expect(lines).toContain("Transcript path outside allowed roots");
});

it("puts an error that ends the menu into the chat, where it outlives the status line", async () => {
  const { shell, results } = fakeShell(["machines"]);
  const { services: deps } = services({
    machines: async () => {
      throw new Error("Runtime connections need the operator credential");
    },
  });
  await runConnectionsMenu(shell, deps);
  expect(results).toEqual([
    { prompt: "/connections", message: "Runtime connections need the operator credential" },
  ]);
});
