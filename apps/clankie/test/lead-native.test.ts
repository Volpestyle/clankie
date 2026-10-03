import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error -- checkout-only manual eval modules are plain ESM.
import { LeadContainer, RUN_LABEL, ROLE_LABEL } from "../../../scripts/evals/lead-containment.mjs";
// @ts-expect-error -- checkout-only manual eval modules are plain ESM.
import * as nativeLedger from "../../../scripts/evals/lead-native-ledger.mjs";
const { CodexAccountSource, NativeUsageLedger, NativeBudgetGuard } = nativeLedger;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});
const root = () => {
  const path = mkdtempSync(join(realpathSync(tmpdir()), "native-fixture-"));
  roots.push(path);
  return path;
};

it("controls only the created container after rechecking image, role and run identity", async () => {
  const id = "a".repeat(64),
    image = `example/runtime@sha256:${"b".repeat(64)}`,
    imageId = `sha256:${"c".repeat(64)}`;
  const calls: string[][] = [];
  let running = false;
  let forged = false;
  const dir = root();
  let boundary: InstanceType<typeof LeadContainer>;
  const command = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "image") return JSON.stringify([{ Id: imageId, Os: "linux", RepoDigests: [image] }]);
    if (args[0] === "create") return id;
    if (args[0] === "inspect")
      return JSON.stringify([
        {
          Id: id,
          Image: forged ? "wrong" : imageId,
          Config: {
            User: `${process.getuid!()}:${process.getgid!()}`,
            Labels: { [RUN_LABEL]: boundary.runId, [ROLE_LABEL]: "verifier" },
          },
          HostConfig: {
            Privileged: false,
            ReadonlyRootfs: true,
            NetworkMode: "none",
            PidMode: "",
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges"],
          },
          Mounts: [{ Type: "bind", Source: dir, Destination: "/eval", RW: true }],
          State: { Running: running },
        },
      ]);
    if (args[0] === "start") running = true;
    if (args[0] === "kill") running = false;
    return "";
  };
  boundary = new LeadContainer({ image, root: dir, command, role: "verifier" });
  await boundary.create(["/opt/native-supervisor"]);
  await boundary.start();
  forged = true;
  await expect(boundary.stop("quota")).rejects.toThrow("identity/isolation");
  expect(calls.some((args) => args[0] === "kill")).toBe(false);
  forged = false;
  await expect(boundary.stop("quota")).rejects.toThrow("identity/isolation");
  expect(calls.filter((args) => args[0] === "kill")).toEqual([]);
  await expect(boundary.start()).rejects.toThrow("never resume");
  await expect(boundary.exec(["codex"])).rejects.toThrow("never dispatch");
  expect(calls.some((args) => args.includes("--privileged"))).toBe(false);
});

it.each(["start", "exec", "pipe"])(
  "refuses %s if stop latches during a suspended identity read",
  async (operation) => {
    const command = Object.assign(
      vi.fn(async () => ""),
      { spawn: vi.fn() },
    );
    const boundary = new LeadContainer({
      image: `sha256:${"b".repeat(64)}`,
      root: root(),
      command,
      role: "verifier",
    });
    let release!: (value: unknown) => void;
    const suspended = new Promise((resolve) => {
      release = resolve;
    });
    vi.spyOn(boundary, "inspect")
      .mockImplementationOnce(() => suspended)
      .mockResolvedValue({ State: { Running: false } });
    const pending = operation === "start" ? boundary.start() : boundary[operation](["fixture"]);
    const rejected = expect(pending).rejects.toThrow("Stopped containers");
    await boundary.stop("independent quota loss");
    expect(boundary.signal.aborted).toBe(true);
    release({ State: { Running: true } });
    await rejected;
    expect(command).not.toHaveBeenCalled();
    expect(command.spawn).not.toHaveBeenCalled();
  },
);

it("refuses create after stop latches during image inspection", async () => {
  const image = `sha256:${"b".repeat(64)}`;
  let release!: (value: string) => void;
  const command = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  );
  const boundary = new LeadContainer({ image, root: root(), command, role: "verifier" });
  const pending = boundary.create(["fixture"]);
  const rejected = expect(pending).rejects.toThrow("Stopped containers never create");
  await expect(boundary.stop("cancel before create")).rejects.toThrow("No controller-created");
  release(JSON.stringify([{ Id: image, Os: "linux" }]));
  await rejected;
  expect(command).toHaveBeenCalledTimes(1);
});

it("rejects symbolic ancestors and nonprivate candidate roots before any Docker command", () => {
  const dir = root();
  mkdirSync(join(dir, "owned"), { mode: 0o700 });
  symlinkSync(join(dir, "owned"), join(dir, "alias"));
  mkdirSync(join(dir, "owned", "child"), { mode: 0o700 });
  const options = { image: `example/runtime@sha256:${"b".repeat(64)}`, command: vi.fn() };
  expect(() => new LeadContainer({ ...options, root: join(dir, "alias", "child") })).toThrow("ancestry");
  mkdirSync(join(dir, "public"), { mode: 0o755 });
  expect(() => new LeadContainer({ ...options, root: join(dir, "public") })).toThrow("private");
  expect(options.command).not.toHaveBeenCalled();
});

it("reads selected account identity around quota and paginates all native sessions", async () => {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const source = new CodexAccountSource(
    async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === "account/read")
        return { account: { type: "chatgpt", email: "fixture@example.invalid" } };
      if (method === "account/rateLimits/read")
        return {
          accountId: "account",
          ordinaryUsageAllowed: true,
          rateLimitsByLimitId: {
            codex: {
              spendControlReached: false,
              primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 9999999999 },
              secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: 9999999999 },
            },
          },
        };
      return {
        data: params.archived
          ? []
          : [{ id: params.cursor ? "child" : "root", cwd: params.cursor ? "/child" : "/root" }],
        nextCursor: !params.archived && !params.cursor ? "next" : null,
      };
    },
    { accountId: "account", email: "fixture@example.invalid" },
  );
  expect((await source.snapshot(() => 1000)).fiveHour.used).toBe(0.1);
  expect((await source.inventory()).threads).toHaveLength(2);
  expect(
    requests
      .filter(({ method }) => method === "thread/list")
      .map(({ params }) => [params.archived, params.cursor]),
  ).toEqual([
    [false, null],
    [false, "next"],
    [true, null],
  ]);
  expect(
    requests
      .filter(({ method }) => method === "account/read")
      .every(({ params }) => params.refreshToken === false),
  ).toBe(true);
});

it("retains every descendant counter once and refuses changed root workspace", () => {
  const ledger = new NativeUsageLedger();
  ledger.authorizeRoot({ sessionId: "root", accountId: "account", cwd: "/root", paneId: "pane" });
  ledger.inventory(
    {
      accountId: "account",
      threads: [
        { id: "root", cwd: "/root" },
        { id: "child", parentThreadId: "root", cwd: "/child" },
      ],
    },
    0,
  );
  const usage = {
    totalTokens: 20,
    inputTokens: 10,
    cachedInputTokens: 5,
    outputTokens: 10,
    reasoningOutputTokens: 5,
  };
  for (const threadId of ["root", "child"])
    ledger.lifecycle("account", { method: "turn/started", params: { threadId, turn: { id: "turn" } } });
  for (const threadId of ["root", "child", "child"])
    ledger.usage("account", {
      method: "thread/tokenUsage/updated",
      params: { threadId, turnId: "turn", tokenUsage: { total: usage } },
    });
  for (const threadId of ["root", "child"])
    ledger.lifecycle("account", {
      method: "turn/completed",
      params: { threadId, turn: { id: "turn", status: "completed" } },
    });
  expect(ledger.result()).toMatchObject({ complete: true, totalTokens: 40, perAccount: { account: 40 } });
  ledger.inventory({ accountId: "account", threads: [{ id: "root", cwd: "/changed" }] }, 1);
  expect(ledger.result()).toMatchObject({ complete: false, totalTokens: null });
  const changed = new NativeUsageLedger();
  changed.authorizeRoot({ sessionId: "root", accountId: "account", cwd: "/root", paneId: "pane" });
  changed.inventory({ accountId: "account", threads: [{ id: "root", cwd: "/changed" }] }, 1);
  expect(changed.result().issues).toContain("wrong account/root for root");
});

it("kills once when a provider stalls beyond telemetry age, never auto-resumes", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const stop = vi.fn(async () => {});
  const guard = new NativeBudgetGuard({ accounts: ["account"], stop, maxAgeMs: 100 });
  guard.observe({
    accountId: "account",
    atMs: 1000,
    identitySha256: "trusted",
    fiveHour: { used: 0.1, resetsAtMs: 10000 },
    sevenDay: { used: 0.1, resetsAtMs: 10000 },
  });
  const monitor = guard.monitor(
    [{ snapshot: () => new Promise(() => {}) }],
    new AbortController().signal,
    25,
  );
  const assertion = expect(monitor).rejects.toThrow("stopped");
  await vi.advanceTimersByTimeAsync(150);
  await assertion;
  expect(stop).toHaveBeenCalledTimes(1);
  await expect(guard.admit()).rejects.toThrow("stop latched");
  expect(stop).toHaveBeenCalledTimes(1);
  expect(() => guard.observe({})).toThrow("Stop latched");
});

it("shares one confirmed exact-container stop across concurrent and reentrant callers", async () => {
  const command = vi.fn(async () => "");
  const boundary = new LeadContainer({
    image: `sha256:${"b".repeat(64)}`,
    root: root(),
    command,
    role: "verifier",
  });
  vi.spyOn(boundary, "inspect")
    .mockResolvedValueOnce({ State: { Running: true } })
    .mockResolvedValue({ State: { Running: false } });
  let reentrant: Promise<unknown> | undefined;
  boundary.signal.addEventListener("abort", () => {
    reentrant = boundary.stop("observer loss");
  });
  const first = boundary.stop("owner stop"),
    second = boundary.stop("quota stop");
  expect(first).toBe(second);
  expect(first).toBe(reentrant);
  const receipts = await Promise.all([first, second, reentrant]);
  expect(receipts[0]).toBe(receipts[1]);
  expect(receipts[0]).toMatchObject({ stopped: true, reason: "owner stop" });
  expect(command.mock.calls).toHaveLength(1);
});

it("later dispatch and active turn remain unknown despite prior cumulative usage", () => {
  const ledger = new NativeUsageLedger();
  ledger.authorizeRoot({ sessionId: "root", accountId: "a", cwd: "/root", paneId: "pane" });
  ledger.inventory({ accountId: "a", threads: [{ id: "root", cwd: "/root" }] }, 1);
  const event = (method: string, id: string, status?: string) => ({
    method,
    params: { threadId: "root", turn: { id, status } },
  });
  const usage = (turnId: string, total: number) => ({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "root",
      turnId,
      tokenUsage: {
        total: {
          totalTokens: total,
          inputTokens: total - 2,
          outputTokens: 2,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
        },
      },
    },
  });
  ledger.dispatch("a", "root");
  ledger.lifecycle("a", event("turn/started", "one"));
  ledger.usage("a", usage("one", 12));
  ledger.lifecycle("a", event("turn/completed", "one", "completed"));
  expect(ledger.result()).toMatchObject({ complete: true, totalTokens: 12 });
  ledger.dispatch("a", "root");
  expect(ledger.result()).toMatchObject({ valid: true, complete: false, totalTokens: null });
  ledger.lifecycle("a", event("turn/started", "two"));
  expect(ledger.result()).toMatchObject({ valid: true, complete: false });
  ledger.usage("a", usage("two", 24));
  expect(ledger.result()).toMatchObject({ valid: true, complete: false });
  ledger.lifecycle("a", event("turn/completed", "two", "completed"));
  expect(ledger.result()).toMatchObject({ complete: true, totalTokens: 24 });
  ledger.dispatch("a", "root");
  ledger.lifecycle("a", event("turn/started", "three"));
  ledger.lifecycle("a", event("turn/completed", "three", "interrupted"));
  expect(ledger.result()).toMatchObject({ valid: false, complete: false, totalTokens: null });
});
