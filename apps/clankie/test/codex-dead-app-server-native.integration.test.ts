// Manual native proof (#362): a real `codex app-server`, started by the real hire path, is
// killed under its hire. Only the Herdr pane and the native TUI are stood in for: the view
// is a second client on the same server that creates the thread, as `codex --remote` does.
// Credential-free: the server gets an empty CODEX_HOME, so no model is ever reached.
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { OperatorFleetSeatSchema } from "@clankie/protocol";
import {
  CodexAppServerClient,
  openCodexSocket,
  startCodexAppServerSeat,
} from "../src/captain/codex-app-server.ts";
import { createCodexSeatAdapter } from "../src/captain/codex-seat-adapter.ts";
import type { ConversationAuthority } from "../src/captain/conversation-owner.ts";
import { readFleet } from "../src/captain/herdr-census.ts";
import { HerdrWatchStore, parseHerdrAgentResult } from "../src/captain/herdr-watch.ts";

const nativeIt = it.skipIf(process.platform === "win32" || process.env.CODEX_DEAD_SERVER_NATIVE_TEST !== "1");

async function deadServerFixture(killBeforeBrief: boolean) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "codex-dead-server-")));
  const codexHome = join(directory, "codex-home");
  await mkdir(codexHome, { mode: 0o700 });
  let serverPid: number | undefined;
  let serverStopped!: () => void;
  const stopped = new Promise<void>((resolve) => {
    serverStopped = resolve;
  });
  let view: CodexAppServerClient | undefined;
  const kill = async () => {
    process.kill(serverPid!, "SIGKILL");
    await stopped;
  };
  const pane = {
    pane_id: "w1:p1",
    terminal_id: "term_dead_server",
    name: "dead-server",
    agent: "codex",
    // Herdr's own reading of the TUI left in the pane; the bug was trusting it.
    agent_status: "working",
    terminal_title: "Dead server hire",
    cwd: directory,
    agent_session: undefined as undefined | { source: string; kind: "id"; value: string },
  };
  const snapshot = () => parseHerdrAgentResult(JSON.stringify({ result: { agent: pane } }));
  const adapter = createCodexSeatAdapter({
    trackerOverrides: async () => [],
    // The real local launcher and seat; only the server's pid and exit are observed.
    start: (options) =>
      startCodexAppServerSeat({
        ...options,
        onServerStarted: (pid) => {
          serverPid = pid;
          options.onServerStarted?.(pid);
        },
        onServerStopped: () => {
          options.onServerStopped?.();
          serverStopped();
        },
      }),
    herdr: async (args) => {
      if (args[1] === "report-agent" && pane.agent_session === undefined)
        pane.agent_session = {
          source: "herdr:codex",
          kind: "id",
          value: args[args.indexOf("--agent-session-id") + 1]!,
        };
    },
  });
  const unexpected = vi.fn(async () => {
    throw new Error("No terminal or native queue fallback is permitted");
  });
  const store = new HerdrWatchStore(join(directory, "watches.json"), {
    // Fixture plan headroom so hiring is admitted; no account is probed or signed in.
    workerAccountsReport: async () => ({
      machine: "local",
      shell: "posix",
      observedAt: new Date().toISOString(),
      accounts: [
        {
          harness: "codex",
          label: "dead-server-fixture",
          home: codexHome,
          signedIn: true,
          usable: true,
          plan: "pro",
          headroom: 0.8,
          usage: {
            source: "codex-rate-limits",
            observedAt: new Date().toISOString(),
            windows: [{ id: "week", label: "Week", usedPercent: 20 }],
          },
        },
      ],
    }),
    seatAdapters: [adapter],
    summariesPath: join(directory, "summaries.json"),
    nativeLaunchPolicy: {
      admit: async () => {},
      prepare: async () => ({
        account: { label: "dead-server-fixture", home: codexHome },
        args: [],
        env: { CODEX_HOME: codexHome, HOME: directory },
      }),
    },
    runner: {
      createTab: async () => pane.pane_id,
      startAgent: async ({ args, name }) => {
        pane.name = name;
        // The native view: a second client of the dedicated server creates its thread.
        const endpoint = args![args!.indexOf("--remote") + 1]!;
        const socket = await openCodexSocket(`ws+unix://${endpoint.slice("unix://".length)}:/`);
        if (!socket) throw new Error("The view could not reach its app-server");
        view = new CodexAppServerClient(socket, () => {}, 15_000);
        await view.initialize(true);
        const thread = (await view.request("thread/start", { cwd: directory })) as { thread: { id: string } };
        if (killBeforeBrief) return kill();
        // The owner typed first, and that turn has ended: codex 0.166 can refuse a
        // metadata-only resume while a fresh thread's first turn runs (filed separately).
        const threadId = thread.thread.id;
        await view.request("turn/start", {
          threadId,
          input: [{ type: "text", text: "Owner's first line.", text_elements: [] }],
        });
        await vi.waitFor(
          async () => {
            const read = (await view!.request("thread/read", { threadId, includeTurns: true })) as {
              thread: { status: { type: string }; turns: { status: string }[] };
            };
            expect(read.thread.status.type).not.toBe("active");
            expect(read.thread.turns.at(-1)?.status).not.toBe("inProgress");
          },
          { timeout: 20_000, interval: 100 },
        );
      },
      get: async () => snapshot(),
      resolveTerminal: async () => snapshot(),
      wait: unexpected,
      runInPane: unexpected,
      codexQueue: unexpected,
      paneProcesses: async () => [{ pid: 12345, name: "codex", argv: ["codex", "--remote", "fixture"] }],
      closePane: async () => {},
    },
  } satisfies NonNullable<ConstructorParameters<typeof HerdrWatchStore>[1]>);
  store.start(async () => {});
  const owner: ConversationAuthority = {
    owner: { conversationId: "dead-server-lead" },
    current: () => true,
    authorize: async () => true,
  };
  const close = async () => {
    store.close();
    view?.close();
    if (serverPid !== undefined)
      try {
        process.kill(serverPid, "SIGKILL");
      } catch {
        /* already gone */
      }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const hire = await store.spawnSeat(
      {
        schemaVersion: 1,
        harness: "codex",
        title: "Dead server hire",
        workingDirectory: directory,
        effort: "low",
        effortReason: "Prove a dead app-server stops its hire.",
      },
      undefined,
      "Initial brief",
      undefined,
      owner,
    );
    const roster = async () => {
      const observed = await readFleet({
        summaries: {},
        runCommand: async (_command, args) => ({
          stdout:
            args[0] === "agent"
              ? JSON.stringify({ result: { agents: [pane] } })
              : JSON.stringify({ result: { snapshot: {} } }),
          stderr: "",
        }),
      });
      return store.withNativeStatus(
        observed.seats.map((seat) =>
          OperatorFleetSeatSchema.parse({
            seatId: seat.seatId,
            occupantId: seat.occupantId,
            personaId: seat.subject,
            harness: seat.harness,
            status: seat.status,
            title: seat.title,
          }),
        ),
        observed.seats,
      );
    };
    return { hire, kill, roster, snapshot, store, close };
  } catch (error) {
    await close();
    throw error;
  }
}

nativeIt(
  "shows a hire whose real app-server was killed as stopped, not working",
  async () => {
    const f = await deadServerFixture(false);
    try {
      expect(f.hire, JSON.stringify(f.hire)).toMatchObject({
        outcome: "spawned",
        control: { mode: "adapter" },
      });
      // The brief reached the live server; Herdr still reads the TUI as working.
      expect(await f.roster()).not.toMatchObject([{ status: "stopped" }]);
      await f.kill();
      await vi.waitFor(async () =>
        expect(await f.roster()).toMatchObject([
          { status: "stopped", summary: expect.stringContaining("Codex app-server stopped") },
        ]),
      );
      // read_agent's note for the same pane.
      expect(await f.store.stoppedReason(f.snapshot()!)).toContain("Close it and hire again.");
    } finally {
      await f.close();
    }
  },
  60_000,
);

nativeIt(
  "reports a first brief as not sent when the real app-server died before it",
  async () => {
    const f = await deadServerFixture(true);
    try {
      expect(f.hire).toMatchObject({ outcome: "failed", reason: "not_ready", briefDelivery: "not_sent" });
    } finally {
      await f.close();
    }
  },
  60_000,
);
