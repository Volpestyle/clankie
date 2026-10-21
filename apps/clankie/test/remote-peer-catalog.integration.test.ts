import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { createCaptain } from "../src/captain/captain.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import type { HerdrAgentSnapshot } from "../src/captain/herdr-watch.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";

// VUH-2616: a seat on a linked machine lists its own fleet's peers. A real
// captain routes Herdr reads to the machine's runner; the machine's Herdr
// replies are the only fixture. Before the fix the catalog read only the local
// fleet, so every remote seat saw no peers and every send was refused.

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

const remote = (name: string, pane: string): HerdrAgentSnapshot => ({
  paneId: `pc/${pane}`,
  terminalId: `pc/term_${name}`,
  agent: "claude",
  status: "idle",
  title: name,
  session: { source: "herdr:claude", kind: "id", value: `pc-${name}` },
  workingDirectory: "/code/kh2",
});

it("lists a remote seat's peers from its own machine", async () => {
  const root = mkdtempSync(join(tmpdir(), "remote-peer-catalog-"));
  cleanup.push(async () => rmSync(root, { recursive: true, force: true }));
  const author = remote("author", "w1:p1");
  const reviewer = remote("reviewer", "w1:p2");
  const local: HerdrAgentSnapshot = {
    paneId: "w2:p1",
    terminalId: "term_local",
    agent: "claude",
    status: "idle",
    title: "local",
    session: { source: "herdr:claude", kind: "id", value: "local" },
  };
  const wire = (agent: HerdrAgentSnapshot) => ({
    pane_id: agent.paneId.slice(3),
    terminal_id: agent.terminalId.slice(3),
    agent: agent.agent,
    agent_status: agent.status,
    title: agent.title,
    agent_session: { ...agent.session! },
    cwd: agent.workingDirectory,
  });
  const herdrResponse = (args: readonly string[]) => {
    const agents = [wire(author), wire(reviewer)];
    let result: unknown;
    if (args[0] === "agent" && args[1] === "list") result = { agents };
    else if (args[0] === "agent" && args[1] === "get")
      result = { agent: agents.find((agent) => args.includes(agent.pane_id)) };
    else if (args[0] === "pane" && args[1] === "list") result = { panes: agents };
    else if (args[0] === "workspace" && args[1] === "list") result = { workspaces: [] };
    else if (args[0] === "api" && args[1] === "snapshot")
      result = { snapshot: { workspaces: [], tabs: [], panes: agents, agents } };
    else throw new Error(`Unexpected Herdr command: ${args.join(" ")}`);
    return JSON.stringify({ result });
  };
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    machines: [{ id: "pc", ssh: "fixture.invalid", shell: "posix", aliases: [] }],
    machineAccess: { pc: "workers" },
    execution: {
      ...current.execution,
      connections: [
        { id: "pc", machine: "pc", session: "default", kind: "herdr", enabled: true, capabilities: [] },
      ],
    },
  }));
  const deps = {
    herdrAvailable: () => false,
    embodiment: {},
    memory: {},
    browser: { catalog: async () => ({ available: false, tools: [] }) },
    mcp: { catalog: async () => [], call: async () => ({ outcome: "ok", content: "", isError: false }) },
    fleets: {
      list: [{ id: "pc", session: "default", ssh: { host: "fixture.invalid", shell: "posix" } }],
      run: () => async (args: readonly string[]) => herdrResponse(args),
    },
  } as unknown as CaptainDeps;
  const captain = createCaptain(deps, {
    repoRoot: root,
    stateDir: root,
    workingDirectory: root,
    nativeHerdrRunner: {
      list: async () => [local],
      get: async (pane) => (pane === local.paneId ? local : Promise.reject(new Error("gone"))),
      resolveTerminal: async (id) => (id === local.terminalId ? local : undefined),
      wait: async () => local,
    },
    nativeCensusRunner: async (_command: string, args: readonly string[]) => ({
      stdout: herdrResponse(args),
      stderr: "",
    }),
    settings,
    discordEnvironment: {},
    seatAdapters: [],
  });
  cleanup.push(() => captain.close());

  const catalog = await captain.listFleetPeerSeats({
    proof: {
      fleet: "pc",
      pane: "w1:p1",
      nativeOccupantId: occupantIdForHerdrSession(author.session!),
      binding: { socketPath: "pipe", session: "default" },
      processes: [{ pid: 456, startTime: "author-start" }],
      shell: { pid: 123, startTime: "shell-start" },
    },
    validate: async () => true,
  });

  expect(catalog?.fleet).toBe("pc");
  expect(catalog?.sender.seatId).toBe("pc/term_author");
  expect(catalog?.seats.map((seat) => seat.seatId)).toEqual(["pc/term_reviewer"]);
});
