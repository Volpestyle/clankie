import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { CaptainModelRuntime } from "../src/captain/model.ts";
import { createEvalResources, createEvalSettings } from "../src/captain/eval-session-boundary.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";

const ordinary = vi.hoisted(() => ({ loader: vi.fn(), runtime: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...(await original<typeof import("@earendil-works/pi-coding-agent")>()),
  DefaultResourceLoader: class {
    constructor() {
      ordinary.loader();
      throw new Error("ordinary resource discovery forbidden");
    }
  },
}));
vi.mock("../src/captain/model.ts", async (original) => ({
  ...(await original<typeof import("../src/captain/model.ts")>()),
  createCaptainModelRuntime: () => {
    ordinary.runtime();
    throw new Error("owner runtime forbidden");
  },
}));

test("captain prompt inspection uses frozen eval context without constructing ordinary loaders or credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "lead-inert-captain-"));
  const resources = createEvalResources({
    systemPrompt: "trusted",
    agentsFiles: [{ path: join(root, "AGENTS.md"), content: "snapshot only" }],
  });
  writeFileSync(join(root, "AGENTS.md"), "candidate mutation must not load");
  const selection = vi.fn(async () => {
    throw new Error("fake selection unavailable");
  });
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  const captain = createCaptain({ herdrAvailable: () => false } as CaptainDeps, {
    repoRoot: root,
    workingDirectory: root,
    stateDir: root,
    settings: new SettingsStore(join(root, "settings.json")),
    evalSessionBoundary: {
      runtime: { resolveSelection: selection } as unknown as CaptainModelRuntime,
      resources: () => resources,
      settings: createEvalSettings,
      tools: () => ({ tools: [], customTools: [] }),
    },
  });
  try {
    const context = captain.seatContext();
    expect(context).toBeDefined();
    for (let i = 0; i < 2; i++) {
      await resources.reload();
      const prompt = await captain.lanePrompt({
        lane: "operator",
        sections: ["model"],
        conversationId: context!.conversationId,
      });
      expect(prompt).toContain("snapshot only");
      expect(prompt).not.toContain("candidate mutation");
    }
    expect(selection).toHaveBeenCalledTimes(2);
    expect(ordinary.loader).not.toHaveBeenCalled();
    expect(ordinary.runtime).not.toHaveBeenCalled();
  } finally {
    await captain.close();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});

const ambientProcess = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("Ambient process access forbidden in isolated Captain fixture");
  }),
);
afterEach(() => {
  expect(ambientProcess).not.toHaveBeenCalled();
  ambientProcess.mockClear();
});
// Test-local tripwire: an omitted native runner cannot reach live owner processes.
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: ambientProcess,
  spawn: ambientProcess,
}));
