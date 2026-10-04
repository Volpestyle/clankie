import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectsSettingsSchema, type ReadFleetProjectMembership } from "@clankie/protocol/projects";
import type { HerdrBinding, SpawnOperatorSeat } from "@clankie/protocol";
import { ProjectHires } from "../src/captain/project-hires.ts";
import {
  FleetProjectMembership,
  type FleetProjectMembershipOptions,
} from "../src/fleet-project-membership.ts";
import { occupantIdForHerdrSession, type HerdrCensusAgent } from "../src/captain/herdr-census.ts";
import type { ProjectProcessProof } from "../src/project-process-proof.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(count = 1) {
  const directory = await mkdtemp(join(tmpdir(), "membership-"));
  directories.push(directory);
  const path = join(directory, "hires.json");
  const hires = new ProjectHires(path);
  let settings = ProjectsSettingsSchema.parse({
    projects: [{ id: "repo", name: "Repository", roles: [{ role: "Builder" }] }],
  });
  let binding: HerdrBinding | undefined = {
    runtime: "external",
    socketPath: "/private/owned.sock",
    session: "original",
  };
  const agents: HerdrCensusAgent[] = [];
  const proofs: ProjectProcessProof[] = [];
  const allocations: string[] = [];
  const input: ReadFleetProjectMembership = { schemaVersion: 1, seats: [] };
  for (let index = 0; index < count; index++) {
    const session = { source: "herdr:codex", kind: "id" as const, value: `native-${index}` };
    const agent = {
      paneId: `w1:p${index}`,
      terminalId: `seat${index}`,
      agent: "codex",
      status: "idle",
      title: "untrusted title",
      session,
    };
    agents.push(agent);
    const proof: ProjectProcessProof = {
      fleet: "default",
      pane: agent.paneId,
      nativeOccupantId: occupantIdForHerdrSession(session),
      binding: { socketPath: binding.socketPath, session: binding.session },
      shell: { pid: 100 + index, startTime: "Sun Oct  4 10:00:00 2026" },
      processes: [{ pid: 200 + index, startTime: "Sun Oct  4 10:00:01 2026" }],
    };
    proofs.push(proof);
    const request: SpawnOperatorSeat = {
      schemaVersion: 1,
      harness: "codex",
      title: "Build",
      workingDirectory: `/canonical/${index}`,
      role: "Builder",
    };
    const allocation = hires.reserve(settings, "repo", request);
    allocations.push(allocation.id);
    hires.launch(allocation.id, settings);
    hires.pane(allocation.id, agent.paneId);
    hires.observe(allocation.id, agent.terminalId, proof.nativeOccupantId, proof);
    hires.confirmed(allocation.id);
    input.seats.push({ seatId: agent.terminalId, occupantId: proof.nativeOccupantId });
  }
  const observe = vi.fn(async (pane: string) => structuredClone(proofs.find((proof) => proof.pane === pane)));
  const roster = vi.fn(async () => structuredClone(agents));
  const options: FleetProjectMembershipOptions = {
    settings: async () => structuredClone(settings),
    binding: async () => structuredClone(binding),
    roster,
    observe,
    hires: {
      projectHireMembershipCandidate: (fleet, pane) => hires.membershipCandidate(fleet, pane),
      confirmedProjectHireAssignment: (fleet, pane, revision, proof) =>
        hires.confirmedAssignment(fleet, pane, revision, proof),
    },
  };
  return {
    directory,
    path,
    hires,
    agents,
    proofs,
    allocations,
    input,
    options,
    observe,
    roster,
    settings: () => settings,
    changeSettings: (value: typeof settings) => {
      settings = value;
    },
    changeBinding: () => {
      binding = { ...binding!, socketPath: "/private/replacement.sock" };
    },
  };
}
const read = (service: FleetProjectMembership, input: ReadFleetProjectMembership) =>
  service.read(input, new AbortController().signal, async () => true);

it("projects a real confirmed ledger proof independently of any controller and never writes on read", async () => {
  const f = await fixture();
  const before = await readFile(f.path, "utf8");
  const result = await read(new FleetProjectMembership(f.options), f.input);
  expect(result.seats[0]!.membership).toEqual({
    outcome: "member",
    source: "hire",
    projectId: "repo",
    role: "builder",
  });
  expect(f.observe).toHaveBeenCalledTimes(2);
  expect(await readFile(f.path, "utf8")).toBe(before);
  expect(JSON.stringify(result)).not.toMatch(/private|canonical|native-0|startTime|processes|socket|pid/);
  const cold = new ProjectHires(f.path);
  const reboot = new FleetProjectMembership({
    ...f.options,
    hires: {
      projectHireMembershipCandidate: (fleet, pane) => cold.membershipCandidate(fleet, pane),
      confirmedProjectHireAssignment: (fleet, pane, revision, proof) =>
        cold.confirmedAssignment(fleet, pane, revision, proof),
    },
  });
  expect((await read(reboot, f.input)).seats[0]!.membership.outcome).toBe("member");
});
it("preserves omitted hire role and ignores persona/cwd/model/cap changes for original membership", async () => {
  const f = await fixture();
  const allocation = f.hires.reserve(f.settings(), "repo", {
    schemaVersion: 1,
    harness: "codex",
    workingDirectory: "/other",
    title: "No role",
  });
  f.hires.launch(allocation.id, f.settings());
  f.hires.pane(allocation.id, f.agents[0]!.paneId);
  f.hires.observe(allocation.id, f.agents[0]!.terminalId!, f.proofs[0]!.nativeOccupantId, f.proofs[0]);
  f.hires.confirmed(allocation.id);
  f.agents[0] = { ...f.agents[0]!, cwd: "/foreign/project", title: "Tester" };
  f.settings().projects[0]!.workerCap = 0;
  expect((await read(new FleetProjectMembership(f.options), f.input)).seats[0]!.membership).toEqual({
    outcome: "member",
    source: "hire",
    projectId: "repo",
  });
});
it.each(["session", "pid", "birth", "shell", "binding", "pending", "private", "no-proof", "prepared"])(
  "refuses %s proof without cwd fallback",
  async (change) => {
    const f = await fixture();
    const proof = structuredClone(f.proofs[0]!);
    if (change === "session") f.proofs[0] = { ...proof, nativeOccupantId: "claimed" };
    if (change === "pid")
      f.proofs[0] = { ...proof, processes: [{ pid: 999, startTime: proof.processes[0]!.startTime }] };
    if (change === "birth")
      f.proofs[0] = { ...proof, processes: [{ ...proof.processes[0]!, startTime: "later" }] };
    if (change === "shell") f.proofs[0] = { ...proof, shell: { ...proof.shell, startTime: "later" } };
    if (change === "binding") f.proofs[0] = { ...proof, binding: { socketPath: "/other" } };
    if (change === "pending") f.proofs[0] = { ...proof, nativeSessionPending: true };
    if (change === "private") f.proofs[0] = { ...proof, privateSeat: true };
    if (change === "no-proof") f.observe.mockResolvedValue(undefined);
    if (change === "prepared") f.proofs[0] = { ...proof, shell: proof.processes[0]! };
    expect((await read(new FleetProjectMembership(f.options), f.input)).seats[0]!.membership.outcome).toBe(
      "unknown",
    );
  },
);
it.each(["role", "project"])("rejects removed %s policy", async (kind) => {
  const f = await fixture();
  if (kind === "project") f.settings().projects = [];
  else f.settings().projects[0]!.roles = [{ role: "Other" }];
  expect((await read(new FleetProjectMembership(f.options), f.input)).seats[0]!.membership).toEqual({
    outcome: "unknown",
    reason: "invalid_assignment",
  });
});
it.each(["none", "unconfirmed", "prepared", "seat", "harness", "native"])(
  "preflights %s without native proof or reattachment",
  async (kind) => {
    const f = await fixture();
    const candidate = f.hires.membershipCandidate("default", f.agents[0]!.paneId);
    if (candidate.state !== "confirmed") throw new Error("fixture");
    f.options.hires.projectHireMembershipCandidate = () =>
      kind === "none"
        ? { state: "none" }
        : kind === "unconfirmed"
          ? { state: "unconfirmed" }
          : {
              ...candidate,
              ...(kind === "prepared"
                ? { generic: false }
                : kind === "seat"
                  ? { seat: "replacement" }
                  : kind === "harness"
                    ? { harness: "claude" }
                    : { nativeOccupantId: "other" }),
            };
    expect((await read(new FleetProjectMembership(f.options), f.input)).seats[0]!.membership.outcome).toBe(
      "unknown",
    );
    expect(f.observe).not.toHaveBeenCalled();
  },
);
it.each(["occupant", "duplicate", "pane", "native-path"])("refuses roster %s changes", async (kind) => {
  const f = await fixture();
  if (kind === "occupant") f.input.seats[0]!.occupantId = "allocation-derived-hash-is-not-roster-hash";
  if (kind === "duplicate") f.agents.push({ ...f.agents[0]! });
  if (kind === "pane") f.agents[0] = { ...f.agents[0]!, paneId: "w1:p9" };
  if (kind === "native-path")
    f.agents[0] = { ...f.agents[0]!, session: { ...f.agents[0]!.session!, kind: "path" } };
  expect((await read(new FleetProjectMembership(f.options), f.input)).seats[0]!.membership.outcome).toBe(
    "unknown",
  );
});
it.each(["proof", "native", "settings", "allocation", "binding", "authority"])(
  "fences %s replacement held across final authorization",
  async (kind) => {
    const f = await fixture();
    let calls = 0;
    const result = new FleetProjectMembership(f.options).read(
      f.input,
      new AbortController().signal,
      async () => {
        if (++calls === 2) {
          if (kind === "proof")
            f.proofs[0] = { ...f.proofs[0]!, processes: [{ pid: 999, startTime: "later" }] };
          if (kind === "native")
            f.agents[0] = { ...f.agents[0]!, session: { ...f.agents[0]!.session!, value: "replacement" } };
          if (kind === "settings") f.settings().projects[0]!.name = "Edited";
          if (kind === "allocation") f.hires.pane(f.allocations[0]!, "w1:p9");
          if (kind === "binding") f.changeBinding();
          if (kind === "authority") return "forbidden";
        }
        return true;
      },
    );
    await expect(result).rejects.toThrow(kind === "authority" ? "forbidden" : "changed");
  },
);
it("keeps remote unsupported without invoking a remote observer", async () => {
  const f = await fixture();
  f.input.seats[0]!.fleet = "pc";
  expect((await read(new FleetProjectMembership(f.options), f.input)).seats[0]!.membership).toEqual({
    outcome: "unknown",
    reason: "unsupported_host",
  });
  expect(f.observe).not.toHaveBeenCalled();
});
it("a failed final census discards positive membership", async () => {
  const f = await fixture();
  f.roster.mockResolvedValueOnce(f.agents).mockRejectedValue(new Error("disconnected"));
  expect((await read(new FleetProjectMembership(f.options), f.input)).seats[0]!.membership.outcome).toBe(
    "unknown",
  );
});

it("globally caps observations at four across batches and refuses a fifth batch", async () => {
  const f = await fixture(20);
  let active = 0,
    peak = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.options.observe = async (pane, _binding, signal) => {
    active++;
    peak = Math.max(peak, active);
    try {
      await held;
      signal.throwIfAborted();
      return f.proofs.find((proof) => proof.pane === pane);
    } finally {
      active--;
    }
  };
  const service = new FleetProjectMembership(f.options);
  const requests = Array.from({ length: 5 }, (_, i) => ({
    ...f.input,
    seats: f.input.seats.slice(i * 4, i * 4 + 4),
  }));
  const pending = requests.slice(0, 4).map((input) => read(service, input));
  await vi.waitFor(() => expect(active).toBe(4));
  await expect(read(service, requests[4]!)).rejects.toThrow("busy");
  release();
  const results = await Promise.all(pending);
  expect(peak).toBe(4);
  expect(active).toBe(0);
  expect(
    results.flatMap((result) => result.seats).every((seat) => seat.membership.outcome === "member"),
  ).toBe(true);
});
it("coalesces initial observations but independently reauthorizes each waiter", async () => {
  const f = await fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.observe.mockImplementation(async () => {
    await held;
    return f.proofs[0];
  });
  const service = new FleetProjectMembership(f.options);
  let calls = 0;
  const revoked = service.read(f.input, new AbortController().signal, async () =>
    ++calls === 2 ? "forbidden" : true,
  );
  const current = read(service, f.input);
  await vi.waitFor(() => expect(f.observe).toHaveBeenCalledTimes(1));
  release();
  await expect(revoked).rejects.toThrow("forbidden");
  expect((await current).seats[0]!.membership.outcome).toBe("member");
  expect(f.observe).toHaveBeenCalledTimes(2); // one shared initial, one authorized final
  await read(service, f.input);
  expect(f.observe).toHaveBeenCalledTimes(4); // no positive cache
});
it("last-waiter abort holds permits and batch until owned cleanup settles", async () => {
  const f = await fixture(4);
  let entered = 0,
    cleanup = 0;
  let finish!: () => void;
  const cleaned = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.options.observe = async (_pane, _binding, signal) => {
    entered++;
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    cleanup++;
    await cleaned;
    return undefined;
  };
  const service = new FleetProjectMembership(f.options);
  const abort = new AbortController();
  let settled = false;
  const pending = service
    .read(f.input, abort.signal, async () => true)
    .finally(() => {
      settled = true;
    });
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(entered).toBe(4));
  abort.abort();
  await vi.waitFor(() => expect(cleanup).toBe(4));
  expect(settled).toBe(false);
  await expect(read(service, f.input)).rejects.toThrow("busy");
  finish();
  await rejected;
  expect(settled).toBe(true);
});
it("aborting one coalesced waiter does not cancel another owner read", async () => {
  const f = await fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.options.observe = async (_pane, _binding, signal) => {
    await held;
    signal.throwIfAborted();
    return f.proofs[0];
  };
  const service = new FleetProjectMembership(f.options);
  const abort = new AbortController();
  const first = service.read(f.input, abort.signal, async () => true);
  const rejected = expect(first).rejects.toThrow();
  const second = read(service, f.input);
  await vi.waitFor(() => expect(f.roster).toHaveBeenCalled());
  abort.abort();
  release();
  await rejected;
  expect((await second).seats[0]!.membership.outcome).toBe("member");
});
it("deadline cancels native work and reports unknown, without a late positive", async () => {
  const f = await fixture();
  let finished = false;
  f.options.deadlineMs = 15;
  f.options.observe = async (_pane, _binding, signal) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    finished = true;
    return f.proofs[0];
  };
  expect((await read(new FleetProjectMembership(f.options), f.input)).seats[0]!.membership).toEqual({
    outcome: "unknown",
    reason: "timeout",
  });
  expect(finished).toBe(true);
});
it("a latest speculative allocation never inherits an earlier valid hire or gets repaired by a later proof", async () => {
  const f = await fixture();
  const allocation = f.hires.reserve(f.settings(), "repo", {
    schemaVersion: 1,
    harness: "codex",
    workingDirectory: "/pending",
    title: "Pending",
  });
  f.hires.launch(allocation.id, f.settings());
  f.hires.pane(allocation.id, f.agents[0]!.paneId);
  f.hires.observe(allocation.id, f.agents[0]!.terminalId!, f.proofs[0]!.nativeOccupantId); // first observation missing proof
  expect(f.hires.membershipCandidate("default", f.agents[0]!.paneId).state).toBe("unconfirmed");
  f.hires.observe(allocation.id, f.agents[0]!.terminalId!, f.proofs[0]!.nativeOccupantId, f.proofs[0]);
  f.hires.confirmed(allocation.id);
  expect((await read(new FleetProjectMembership(f.options), f.input)).seats[0]!.membership).toEqual({
    outcome: "unknown",
    reason: "no_confirmed_hire",
  });
  expect(f.observe).not.toHaveBeenCalled();
});
it("reauthorizes after final native work before publication", async () => {
  const f = await fixture();
  let calls = 0;
  await expect(
    new FleetProjectMembership(f.options).read(f.input, new AbortController().signal, async () =>
      ++calls === 3 ? "forbidden" : true,
    ),
  ).rejects.toThrow("forbidden");
  expect(f.observe).toHaveBeenCalledTimes(2);
});
it("settings await cannot hide a late allocation or binding replacement", async () => {
  const f = await fixture();
  let loads = 0;
  const original = f.options.settings;
  f.options.settings = async () => {
    const value = await original();
    if (++loads === 2) f.hires.pane(f.allocations[0]!, "w1:p9");
    return value;
  };
  await expect(read(new FleetProjectMembership(f.options), f.input)).rejects.toThrow("changed");
});
it("reproduces the saved generic foreground proof through the actual observer implementation", async () => {
  const { createProjectProcessObserver } = await import("../src/project-process-proof.ts");
  const f = await fixture();
  const native = f.agents[0]!;
  const expected = f.proofs[0]!;
  const run = vi.fn(async (file: string, args: string[]) => {
    if (file === "herdr" && args[0] === "agent")
      return JSON.stringify({
        result: {
          agent: {
            pane_id: native.paneId,
            terminal_id: native.terminalId,
            agent: native.agent,
            agent_session: native.session,
          },
        },
      });
    if (file === "herdr")
      return JSON.stringify({
        result: {
          process_info: {
            pane_id: native.paneId,
            shell_pid: expected.shell.pid,
            foreground_process_group_id: expected.processes[0]!.pid,
          },
        },
      });
    if (file === "/usr/sbin/lsof") return `p${expected.processes[0]!.pid}\nftxt\nn/trusted/codex\n`;
    if (file === "/bin/ps") {
      const shell = Number(args[1]) === expected.shell.pid;
      return `${shell ? expected.shell.startTime : expected.processes[0]!.startTime} ${shell ? "/bin/zsh" : "/trusted/codex"}\n`;
    }
    throw new Error("Unexpected observer command");
  });
  const observe = createProjectProcessObserver({
    platform: "darwin",
    herdrBinary: "herdr",
    binding: f.options.binding,
    run,
    canonical: async (path) => path,
    launcher: async () => ({ executable: "/trusted/codex" }),
  });
  f.options.observe = (pane) => observe("default", pane);
  expect((await read(new FleetProjectMembership(f.options), f.input)).seats[0]!.membership.outcome).toBe(
    "member",
  );
  expect(run.mock.calls.filter(([file, args]) => file === "herdr" && args[0] === "agent")).toHaveLength(4);
});
it("keeps the batch registered through canceled final-proof cleanup", async () => {
  const f = await fixture();
  let calls = 0;
  let closing = false;
  let finish!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.options.observe = async (_pane, _binding, signal) => {
    if (++calls === 1) return f.proofs[0];
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    closing = true;
    await cleanup;
    return undefined;
  };
  const service = new FleetProjectMembership(f.options);
  const controller = new AbortController();
  const pending = service.read(f.input, controller.signal, async () => true);
  const refused = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(calls).toBe(2));
  controller.abort();
  await vi.waitFor(() => expect(closing).toBe(true));
  await expect(read(service, f.input)).rejects.toThrow("busy");
  finish();
  await refused;
});

it("counts held roster and process reads together across batches under the global four-slot cap", async () => {
  const f = await fixture(16);
  let active = 0;
  let peak = 0;
  let rosterCalls = 0;
  let processCalls = 0;
  let firstRoster!: () => void;
  let otherRosters!: () => void;
  let processes!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    firstRoster = resolve;
  });
  const rosterGate = new Promise<void>((resolve) => {
    otherRosters = resolve;
  });
  const processGate = new Promise<void>((resolve) => {
    processes = resolve;
  });
  const enter = () => {
    active++;
    peak = Math.max(peak, active);
  };
  f.options.roster = async (_binding, signal) => {
    enter();
    const call = ++rosterCalls;
    try {
      await (call === 1 ? firstGate : rosterGate);
      signal.throwIfAborted();
      return structuredClone(f.agents);
    } finally {
      active--;
    }
  };
  f.options.observe = async (pane, _binding, signal) => {
    enter();
    processCalls++;
    try {
      await processGate;
      signal.throwIfAborted();
      return f.proofs.find((proof) => proof.pane === pane);
    } finally {
      active--;
    }
  };
  const service = new FleetProjectMembership(f.options);
  const reads = Array.from({ length: 4 }, (_, index) =>
    read(service, { ...f.input, seats: f.input.seats.slice(index * 4, index * 4 + 4) }),
  );
  try {
    await vi.waitFor(() => expect(rosterCalls).toBe(4));
    expect(active).toBe(4);
    firstRoster(); // Three roster readers remain held while the first batch starts its seat proofs.
    await vi.waitFor(() => expect(processCalls).toBeGreaterThan(0));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(peak).toBeLessThanOrEqual(4);
  } finally {
    firstRoster();
    otherRosters();
    processes();
    await Promise.all(reads);
  }
  expect(active).toBe(0);
  expect(peak).toBe(4);
  expect(rosterCalls).toBe(12); // Initial + shared-final + per-reader final for every batch.
  expect(processCalls).toBe(32); // Both proofs for all sixteen seats.
});

it("holds shared-final roster reads behind other batches' active process proofs", async () => {
  const f = await fixture(5);
  let active = 0,
    peak = 0,
    rosterCalls = 0,
    firstProcesses = 0,
    otherProcesses = 0;
  let firstProcess!: () => void, otherProcess!: () => void, finalRoster!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    firstProcess = resolve;
  });
  const processGate = new Promise<void>((resolve) => {
    otherProcess = resolve;
  });
  const rosterGate = new Promise<void>((resolve) => {
    finalRoster = resolve;
  });
  const enter = () => {
    active++;
    peak = Math.max(peak, active);
  };
  f.options.roster = async (_binding, signal) => {
    enter();
    try {
      if (++rosterCalls === 3) await rosterGate;
      signal.throwIfAborted();
      return f.agents;
    } finally {
      active--;
    }
  };
  f.options.observe = async (pane, _binding, signal) => {
    enter();
    try {
      if (pane === f.agents[0]!.paneId) {
        firstProcesses++;
        await firstGate;
      } else {
        otherProcesses++;
        await processGate;
      }
      signal.throwIfAborted();
      return f.proofs.find((proof) => proof.pane === pane);
    } finally {
      active--;
    }
  };
  const service = new FleetProjectMembership(f.options);
  const first = read(service, { ...f.input, seats: f.input.seats.slice(0, 1) });
  let others: Promise<unknown> | undefined;
  try {
    await vi.waitFor(() => expect(firstProcesses).toBe(1));
    others = read(service, { ...f.input, seats: f.input.seats.slice(1) });
    await vi.waitFor(() => expect(otherProcesses).toBe(3));
    firstProcess(); // The queued fourth process gets the released slot before the shared-final census.
    await vi.waitFor(() => expect(otherProcesses).toBe(4));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(peak).toBe(4);
  } finally {
    firstProcess();
    otherProcess();
    finalRoster();
    await Promise.all([first, others]);
  }
  expect(active).toBe(0);
});
