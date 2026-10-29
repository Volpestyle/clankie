import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { HerdrWatchStore, type HerdrAgentSnapshot } from "../src/captain/herdr-watch.ts";
import { SeatOutbox } from "../src/captain/seat-outbox.ts";
import { capabilities, leadChatFixture } from "./fixtures/lead-chats.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const step of cleanup.splice(0).reverse()) await step();
  vi.restoreAllMocks();
});

// VUH-2975: a restarted service still remembers its ended native lead. Exercise
// the actual hire_agent -> captain project policy -> launch-admission path, not
// a copied project resolver. The fixture deliberately has no harness adapter.
it("lets only the proven service body hire for its routed project after its native source is gone", async () => {
  let local: HerdrAgentSnapshot[] | undefined;
  let remote: HerdrAgentSnapshot[] = [];
  let failedFleet: string | undefined;
  const f = await leadChatFixture(false, cleanup, {
    defaultLead: true,
    nativeSourceProof: true,
    additionalFleet: true,
    remoteShell: () => async () => JSON.stringify({ outcome: "not-repository", path: "/not-registered" }),
    projectHireIdentity: async () => undefined,
    inventoryAgents: (fleet) => (fleet === "pc" ? remote : local),
    inventory: async (fleet) => {
      if ((fleet ?? "default") === failedFleet) throw new Error("Inventory unavailable");
    },
  });
  const conversation = "global-default";
  await f.captain.pollSeatEvents(50, undefined, conversation, capabilities);
  const meta = async () =>
    JSON.parse(await readFile(join(f.root, "conversations", conversation, "meta.json"), "utf8")) as {
      nativeSource?: { terminalId: string; session?: { value: string } };
    };
  expect((await meta()).nativeSource).toMatchObject({
    terminalId: f.head.terminalId,
    session: { value: f.head.session!.value },
  });
  await mkdir(join(f.root, "clankie"));
  await mkdir(join(f.root, "unrouted"));
  const clankie = await realpath(join(f.root, "clankie"));
  const unrouted = await realpath(join(f.root, "unrouted"));
  await f.settings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "clankie",
          name: "Clankie",
          auto: true,
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: clankie }],
        },
        {
          id: "unrouted",
          name: "Unrouted",
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: unrouted }],
        },
      ],
    }),
  }));
  await f.captain.close();
  // The outbox captures Date.now at construction, so install the controlled
  // Date before reopening; real timers still drive the native fixture.
  vi.useFakeTimers({ toFake: ["Date"] });
  // Restart, preserving nativeSource but not the old bridge's live poll/outbox.
  local = [];
  const service = f.open();
  const bank = await service.laneToolBank("operator", conversation);
  const spawn = vi.spyOn(HerdrWatchStore.prototype, "spawnSeat");
  const hire = async (overrides: Record<string, unknown> = {}) => {
    const result = await bank.tools
      .find((tool) => tool.name === "hire_agent")!
      .call({
        harness: "codex",
        effort: "medium",
        effortReason: "A bounded product fix with a current source proof.",
        title: "Nessa",
        role: "builder",
        projectId: "clankie",
        workingDirectory: clankie,
        brief: "Own the bounded product result.",
        ...overrides,
      });
    const text = result.content.find((part) => part.type === "text");
    return JSON.parse(text?.type === "text" ? text.text : "null") as Record<string, unknown>;
  };
  const refused = (detail: string) => ({
    outcome: "failed",
    reason: "not_ready",
    detail: expect.stringContaining(detail),
  });
  const changed = refused("original agent has changed");

  // A recent native poll still holds its lane across a restart. Only after
  // that grace expires is this an unbound service body.
  expect(await hire()).toMatchObject(changed);
  vi.setSystemTime(Date.now() + 60_000);

  // Requested IDs/folders confer no source project authority.
  expect(await hire({ projectId: "unrouted", workingDirectory: unrouted })).toMatchObject(changed);
  expect(await hire({ projectId: undefined })).toMatchObject(changed);

  // A changed occupant, the old terminal elsewhere, or its old native session
  // anywhere in a complete registered inventory is not an absent source.
  const other = { ...f.head, session: { ...f.head.session!, value: randomUUID() } };
  const otherPane = { ...other, paneId: "w9:p9", terminalId: "term_other" };
  for (const occupant of [other, { ...other, paneId: "w9:p9" }]) {
    local = [occupant];
    expect(await hire()).toMatchObject(changed);
  }
  local = [];
  remote = [{ ...otherPane, paneId: "pc/w9:p9", terminalId: "pc/term_other", session: f.head.session! }];
  expect(await hire()).toMatchObject(changed);
  remote = [];
  const { session: _session, ...unknownNative } = otherPane;
  local = [unknownNative];
  expect(await hire()).toMatchObject(changed);
  local = [];

  for (const fleet of ["default", "pc"]) {
    failedFleet = fleet;
    expect(await hire(), fleet).toMatchObject(changed);
  }
  failedFleet = undefined;
  const assignment = vi.spyOn(HerdrWatchStore.prototype, "projectHireAssignment");
  assignment.mockReturnValue({ state: "invalid" });
  expect(await hire()).toMatchObject(changed);
  assignment.mockRestore();
  expect(spawn).not.toHaveBeenCalled();

  // A different, known native session (the owner's unrelated resumed Claude)
  // is not the old source and does not itself claim this conversation.
  local = [otherPane];
  expect(await hire()).toMatchObject({
    outcome: "failed",
    reason: "harness_unavailable",
    control: { reason: "pane_run_unavailable" },
  });
  expect(spawn).toHaveBeenCalledOnce();
  expect((await meta()).nativeSource).toMatchObject({
    terminalId: f.head.terminalId,
    session: { value: f.head.session!.value },
  });

  // Even an absent source does not authorize another destination or an
  // unregistered remote workspace. Neither refusal reaches another spawn.
  expect(await hire({ workingDirectory: unrouted })).toMatchObject(refused("different projects"));
  expect(await hire({ fleet: "pc", workingDirectory: "/not-registered" })).toMatchObject(
    refused("not a registered workspace"),
  );
  expect(spawn).toHaveBeenCalledOnce();
}, 30_000);

// Current Herdr omits a plain shell's agent field. The raw remote inventory goes
// through the real parser ("unknown") and the real `pane process-info` read.
it("admits an omitted-agent pane only once its own process read proves a plain shell", async () => {
  let local: HerdrAgentSnapshot[] | undefined;
  let remote: HerdrAgentSnapshot[] = [];
  let processes: (() => { shellPid: number; foreground: { pid: number; name: string }[] }) | undefined;
  const reads: string[] = [];
  const f = await leadChatFixture(false, cleanup, {
    defaultLead: true,
    nativeSourceProof: true,
    additionalFleet: true,
    remoteShell: () => async () => JSON.stringify({ outcome: "not-repository", path: "/not-registered" }),
    projectHireIdentity: async () => undefined,
    inventoryAgents: (fleet) => (fleet === "pc" ? remote : local),
    paneShell: (fleet, paneId) => {
      reads.push(fleet === undefined ? paneId : `${fleet}/${paneId}`);
      if (processes === undefined) throw new Error("Herdr process info unavailable");
      return processes();
    },
  });
  const conversation = "global-default";
  await f.captain.pollSeatEvents(50, undefined, conversation, capabilities);
  await mkdir(join(f.root, "clankie"));
  const clankie = await realpath(join(f.root, "clankie"));
  await f.settings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "clankie",
          name: "Clankie",
          auto: true,
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: clankie }],
        },
      ],
    }),
  }));
  await f.captain.close();
  vi.useFakeTimers({ toFake: ["Date"] });
  local = [];
  const service = f.open();
  vi.setSystemTime(Date.now() + 60_000);
  const bank = await service.laneToolBank("operator", conversation);
  const spawn = vi.spyOn(HerdrWatchStore.prototype, "spawnSeat");
  const hire = async () => {
    const result = await bank.tools
      .find((tool) => tool.name === "hire_agent")!
      .call({
        harness: "codex",
        effort: "medium",
        effortReason: "A bounded product fix with a current source proof.",
        title: "Nessa",
        role: "builder",
        projectId: "clankie",
        workingDirectory: clankie,
        brief: "Own the bounded product result.",
      });
    const text = result.content.find((part) => part.type === "text");
    return JSON.parse(text?.type === "text" ? text.text : "null") as Record<string, unknown>;
  };
  const changed = {
    outcome: "failed",
    reason: "not_ready",
    detail: expect.stringContaining("original agent has changed"),
  };
  const shell = (pid = 11) => ({ shellPid: pid, foreground: [{ pid, name: "zsh" }] });
  const plain: HerdrAgentSnapshot = {
    paneId: "pc/w9:p9",
    terminalId: "pc/term_plain",
    agent: "unknown",
    status: "unknown",
    title: "zsh",
  };
  remote = [plain];

  // The old lead's own terminal refuses first, before its process is read.
  processes = () => shell();
  local = [{ ...plain, paneId: "w8:p8", terminalId: f.head.terminalId }];
  expect(await hire()).toMatchObject(changed);
  expect(reads).not.toContain("w8:p8");
  local = [];

  // An unreadable read, a native harness or any other foreground process refuses.
  processes = undefined;
  expect(await hire()).toMatchObject(changed);
  for (const foreground of [
    [{ pid: 12, name: "claude" }],
    [
      { pid: 11, name: "zsh" },
      { pid: 13, name: "node" },
    ],
  ]) {
    processes = () => ({ shellPid: 11, foreground });
    expect(await hire()).toMatchObject(changed);
  }
  expect(reads.length).toBeGreaterThanOrEqual(3);
  expect(new Set(reads)).toEqual(new Set(["pc/w9:p9"]));
  expect(spawn).not.toHaveBeenCalled();

  // A pane whose only foreground process is its own shell is a plain shell.
  processes = () => shell();
  expect(await hire()).toMatchObject({
    outcome: "failed",
    reason: "harness_unavailable",
    control: { reason: "pane_run_unavailable" },
  });
  expect(spawn).toHaveBeenCalledOnce();
}, 30_000);

// A source whose own fleet was unlinked is never listed, so its absence is unproven.
// The stored source is moved onto a fleet between restarts, as a later unlink leaves it.
it("refuses a service body whose original source fleet is no longer registered", async () => {
  const changed = {
    outcome: "failed",
    reason: "not_ready",
    detail: expect.stringContaining("original agent has changed"),
  };
  const reachedLaunch = {
    outcome: "failed",
    reason: "harness_unavailable",
    control: { reason: "pane_run_unavailable" },
  };
  for (const [fleet, expected] of [
    ["gone", changed],
    ["pc", reachedLaunch],
  ] as const) {
    let gone = false;
    const f = await leadChatFixture(false, cleanup, {
      defaultLead: true,
      nativeSourceProof: true,
      additionalFleet: true,
      projectHireIdentity: async () => undefined,
      // The registered "pc" fleet lists nobody: an echo of the local lead there would make
      // its session ambiguous, and no native source would be saved.
      inventoryAgents: (fleet) => (fleet === "pc" || gone ? [] : undefined),
    });
    await f.captain.pollSeatEvents(50, undefined, "global-default", capabilities);
    await mkdir(join(f.root, "clankie"));
    const directory = await realpath(join(f.root, "clankie"));
    await f.settings.update((current) => ({
      ...current,
      projects: ProjectsSettingsSchema.parse({
        projects: [
          {
            id: "clankie",
            name: "Clankie",
            auto: true,
            workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: directory }],
          },
        ],
      }),
    }));
    await f.captain.close();
    const path = join(f.root, "conversations", "global-default", "meta.json");
    const meta = JSON.parse(await readFile(path, "utf8")) as {
      nativeSource: { paneId: string; terminalId: string };
    };
    // The real proven native source the first poll saved, never a synthesized one.
    expect(meta.nativeSource, fleet).toMatchObject({
      paneId: f.head.paneId,
      terminalId: f.head.terminalId,
      session: { value: f.head.session!.value },
    });
    meta.nativeSource = {
      ...meta.nativeSource,
      paneId: `${fleet}/${meta.nativeSource.paneId}`,
      terminalId: `${fleet}/${meta.nativeSource.terminalId}`,
    };
    await writeFile(path, `${JSON.stringify(meta)}\n`);
    vi.useFakeTimers({ toFake: ["Date"] });
    gone = true;
    const service = f.open();
    vi.setSystemTime(Date.now() + 60_000);
    const bank = await service.laneToolBank("operator", "global-default");
    const result = await bank.tools.find((tool) => tool.name === "hire_agent")!.call({
      harness: "codex",
      effort: "medium",
      effortReason: "A bounded product fix with a current source proof.",
      title: "Nessa",
      role: "builder",
      projectId: "clankie",
      workingDirectory: directory,
      brief: "Own the bounded product result.",
    });
    const text = result.content.find((part) => part.type === "text");
    expect(JSON.parse(text?.type === "text" ? text.text : "null"), fleet).toMatchObject(expected);
    await service.close();
    vi.useRealTimers();
  }
}, 60_000);

it("does not treat a bound or uncertain native outbox as a service-driven source", async () => {
  let gone = false;
  const f = await leadChatFixture(false, cleanup, {
    defaultLead: true,
    nativeSourceProof: true,
    projectHireIdentity: async () => undefined,
    inventoryAgents: () => (gone ? [] : undefined),
  });
  await f.captain.pollSeatEvents(50, undefined, "global-default", capabilities);
  await mkdir(join(f.root, "clankie"));
  const directory = await realpath(join(f.root, "clankie"));
  await f.settings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "clankie",
          name: "Clankie",
          auto: true,
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: directory }],
        },
      ],
    }),
  }));
  const bank = await f.captain.laneToolBank("operator", "global-default");
  const spawn = vi.spyOn(HerdrWatchStore.prototype, "spawnSeat");
  const bound = vi.spyOn(SeatOutbox.prototype, "bound").mockReturnValue(true);
  const uncertain = vi.spyOn(SeatOutbox.prototype, "uncertain").mockReturnValue(false);
  gone = true;
  for (const pending of [false, true]) {
    bound.mockReturnValue(!pending);
    uncertain.mockReturnValue(pending);
    const result = await bank.tools
      .find((tool) => tool.name === "hire_agent")!
      .call({
        harness: "codex",
        effort: "medium",
        effortReason: "One bounded source fence.",
        title: "Nessa",
        role: "builder",
        projectId: "clankie",
        workingDirectory: directory,
        brief: "Own the bounded product result.",
      });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("original agent has changed"),
        }),
      ]),
    );
  }
  expect(spawn).not.toHaveBeenCalled();
});
