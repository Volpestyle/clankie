import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const trusted = vi.hoisted(() => ({ proofs: new WeakSet<object>(), sockets: [] as unknown[] }));
vi.mock("../../../scripts/evals/lead-native-capability.mjs", () => ({
  assertNativeRuntimeCapability: async (proof: object) => {
    if (!trusted.proofs.has(proof)) throw Error("untrusted capability");
  },
  nativeRuntimeEvidence: (proof: object) => {
    if (!trusted.proofs.has(proof)) throw Error("untrusted capability");
    return { binaries: { "/opt/codex/bin/codex": "b".repeat(64) } };
  },
}));
vi.mock("../src/captain/codex-app-server.ts", async (original) => ({
  ...(await original<object>()),
  openCodexSocket: async () => trusted.sockets.shift(),
}));
// @ts-expect-error -- explicit manual-only checkout ESM module.
import * as accountObserver from "../../../scripts/evals/lead-account-observer.mjs";
const { createLeadAccountObserver, assertLeadAccountObserver, observerCredential } = accountObserver;
// @ts-expect-error -- fake Docker transport, never a real Docker command.
import { LeadContainer, RUN_LABEL, ROLE_LABEL } from "../../../scripts/evals/lead-containment.mjs";
// @ts-expect-error -- manual-only checkout ESM policy.
import { nativePermissionProfile } from "../../../scripts/evals/lead-native-policy.mjs";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  trusted.sockets.length = 0;
  vi.useRealTimers();
});
async function fixture(options: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "lead-observer-"));
  const hostCwd = join(root, "tasks/lead"),
    accountHome = join(root, "control/lead/auth");
  mkdirSync(hostCwd, { recursive: true, mode: 0o700 });
  mkdirSync(accountHome, { recursive: true, mode: 0o700 });
  const authPath = join(accountHome, "auth.json");
  const auth = {
    auth_mode: "chatgpt",
    tokens: { access_token: "fixture-secret-token", account_id: "account" },
  };
  writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
  const capability = {};
  trusted.proofs.add(capability);
  let running = true;
  let container: InstanceType<typeof LeadContainer>;
  const children: Array<EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough }> = [];
  const command = Object.assign(
    vi.fn(async (args: string[]) => {
      if (args[0] === "image") return JSON.stringify([{ Id: "sha256:" + "b".repeat(64), Os: "linux" }]);
      if (args[0] === "create") return "c".repeat(64);
      if (args[0] === "kill") {
        running = false;
        return "";
      }
      if (args[0] === "inspect")
        return JSON.stringify([
          {
            Id: "c".repeat(64),
            Image: "sha256:" + "b".repeat(64),
            Config: {
              User: container.user,
              Labels: { [RUN_LABEL]: container.runId, [ROLE_LABEL]: "native" },
            },
            HostConfig: {
              Privileged: false,
              ReadonlyRootfs: true,
              NetworkMode: "bridge",
              CapDrop: ["ALL"],
              SecurityOpt: ["no-new-privileges"],
            },
            Mounts: [{ Type: "bind", Source: root, Destination: "/eval", RW: true }],
            State: { Running: running },
          },
        ]);
      return "";
    }),
    {
      spawn: vi.fn(() => {
        const child = Object.assign(new EventEmitter(), {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        });
        children.push(child);
        return child;
      }),
    },
  );
  container = new LeadContainer({ root, image: "sha256:" + "b".repeat(64), command, capability });
  await container.create(["/bin/true"]);
  const locked = {
    approval_policy: "never",
    mcp_servers: {},
    features: { multi_agent: false },
    web_search: "disabled",
    default_permissions: "lead_eval",
    permissions: { lead_eval: nativePermissionProfile("/eval/tasks/lead") },
  };
  const configuration = {
    config: locked,
    origins: {},
    layers: [{ name: { type: "sessionFlags" }, version: "fixture", config: locked }],
  };
  const quota = {
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
  let request: (method: string) => Promise<unknown> = async (method) => {
    if (method === "account/read")
      return { account: { type: "chatgpt", email: "fixture@example.invalid", planType: "pro" } };
    if (method === "account/rateLimits/read") return quota;
    if (method === "config/read") return configuration;
    return {};
  };
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const socket = Object.assign(new EventEmitter(), {
    send: (raw: string, callback?: (error?: Error) => void) => {
      const message = JSON.parse(raw);
      calls.push(message);
      callback?.();
      if (message.id !== undefined)
        void request(message.method).then((result) =>
          socket.emit("message", Buffer.from(JSON.stringify({ id: message.id, result }))),
        );
    },
    close: () => socket.emit("close"),
  });
  trusted.sockets.push(socket);
  const allocation = {
    hostCwd,
    containerCwd: "/eval/tasks/lead",
    accountHome,
    containerAccountHome: "/eval/control/lead/auth",
    accountId: "account",
    email: "fixture@example.invalid",
  };
  const stopped = vi.fn();
  const observer = createLeadAccountObserver({
    container,
    allocation,
    intervalMs: 20,
    maxAgeMs: 100,
    onStop: stopped,
    ...options,
  });
  cleanup.push(async () => {
    await observer.stop().catch(() => {});
    for (const child of children) {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    observer,
    container,
    capability,
    command,
    socket,
    calls,
    children,
    authPath,
    auth,
    quota,
    configuration,
    stopped,
    allocation,
    replaceRequest: (next: typeof request) => {
      const old = request;
      request = next;
      return old;
    },
  };
}

it("is inert until explicit start, uses only the account/config native RPCs, and brands the selected credential", async () => {
  const f = await fixture();
  expect(f.command.spawn).not.toHaveBeenCalled();
  expect(() => f.observer.assertReady()).toThrow(/not ready/);
  expect(() => assertLeadAccountObserver({ ...f.observer })).toThrow(/origin/);
  await f.observer.start();
  expect(assertLeadAccountObserver(f.observer)).toBe(f.observer);
  expect(await observerCredential(f.observer)).toMatchObject({
    accountId: "account",
    accessToken: "fixture-secret-token",
    bindingSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(new Set(f.calls.map((call) => call.method))).toEqual(
    new Set(["initialize", "initialized", "account/read", "account/rateLimits/read", "config/read"]),
  );
  expect(
    f.calls
      .filter((call) => call.method === "account/read")
      .every((call) => call.params.refreshToken === false),
  ).toBe(true);
  expect(JSON.stringify(f.observer.evidence())).not.toContain("fixture-secret-token");
  expect(JSON.stringify(f.command.mock.calls)).not.toContain("fixture-secret-token");
  expect(f.command.spawn.mock.calls).toHaveLength(2);
  expect(f.observer.current()).toBe(true);
});

it("rejects imported capability or container claims before any observer launch", async () => {
  const f = await fixture();
  expect(() =>
    createLeadAccountObserver({ container: { ...f.container }, allocation: f.allocation }),
  ).toThrow();
  f.container.capability = {};
  expect(() => createLeadAccountObserver({ container: f.container, allocation: f.allocation })).toThrow(
    /capability/,
  );
  expect(f.command.spawn).not.toHaveBeenCalled();
});

it.each(["hardlink", "mode", "token"])(
  "latches selected auth %s changes synchronously before physical admission",
  async (change) => {
    const f = await fixture();
    await f.observer.start();
    const order: string[] = [];
    f.observer.signal.addEventListener("abort", () => order.push("abort"));
    if (change === "hardlink") linkSync(f.authPath, join(f.root, "alias"));
    else if (change === "mode") chmodSync(f.authPath, 0o644);
    else writeFileSync(f.authPath, JSON.stringify({ ...f.auth, tokens: { access_token: "other" } }));
    expect(() => f.observer.assertReady()).toThrow();
    expect(f.observer.signal.aborted).toBe(true);
    expect(f.stopped).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["abort"]);
    expect(f.observer.current()).toBe(false);
    expect(await f.observer.stop()).toEqual({ containerId: "c".repeat(64), stopped: true });
  },
);

it("refuses auth mutation while a backend quota observation is suspended", async () => {
  // Coverage expiry is exercised separately; this admission holds its observed clock.
  const f = await fixture({ now: () => 1000 });
  await f.observer.start();
  let resolve!: (value: unknown) => void;
  let requested!: () => void;
  const requestStarted = new Promise<void>((done) => {
    requested = done;
  });
  const original = f.replaceRequest(async (method) =>
    method === "account/rateLimits/read"
      ? new Promise((done) => {
          resolve = done;
          requested();
        })
      : original(method),
  );
  const pending = f.observer.selectedCredential();
  const rejected = expect(pending).rejects.toThrow();
  await requestStarted;
  writeFileSync(f.authPath, JSON.stringify({ ...f.auth, tokens: { access_token: "changed" } }));
  resolve(f.quota);
  await rejected;
  expect(f.observer.signal.aborted).toBe(true);
  expect(JSON.stringify(f.observer.evidence())).not.toContain("changed");
});

it.each(["account", "coverage", "config"])("fails closed on native %s mismatch", async (kind) => {
  const f = await fixture();
  if (kind === "account") f.quota.accountId = "other";
  if (kind === "coverage") f.quota.ordinaryUsageAllowed = false;
  if (kind === "config") f.configuration.config.web_search = "live";
  await expect(f.observer.start()).rejects.toThrow();
  expect(f.observer.signal.aborted).toBe(true);
  expect(f.command.mock.calls.some(([args]) => args[0] === "kill" && args.at(-1) === "c".repeat(64))).toBe(
    true,
  );
});

it("aborts immediately on observer descendant loss without a worker or another provider request", async () => {
  const f = await fixture();
  await f.observer.start();
  f.children[0]!.emit("exit", 1);
  expect(f.observer.signal.aborted).toBe(true);
  expect(f.stopped).toHaveBeenCalledTimes(1);
  await expect(f.observer.selectedCredential()).rejects.toThrow();
  await expect(f.observer.start()).rejects.toThrow(/restart/);
});

it("independently expires hung backend observation coverage", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  await f.observer.start();
  const original = f.replaceRequest(async (method) =>
    method === "account/rateLimits/read" ? new Promise(() => {}) : original(method),
  );
  await vi.advanceTimersByTimeAsync(120);
  expect(f.observer.signal.aborted).toBe(true);
  expect(f.observer.current()).toBe(false);
  await f.observer.stop();
});

it("holds readiness until shared budget admission and fails callback revocation", async () => {
  let allow!: () => void;
  const observed = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        allow = resolve;
      }),
  );
  const f = await fixture({ onSnapshot: observed });
  const starting = f.observer.start();
  await vi.waitFor(() => expect(observed).toHaveBeenCalledTimes(1));
  expect(f.observer.current()).toBe(false);
  allow();
  await starting;
  expect(f.observer.current()).toBe(true);
  observed.mockImplementation(async () => {
    throw Error("private quota revocation");
  });
  await expect(f.observer.snapshot()).rejects.toThrow();
  expect(f.observer.signal.aborted).toBe(true);
  expect(JSON.stringify(f.observer.evidence())).not.toContain("private quota revocation");
});

it("rechecks config after a suspended quota response and refuses changed provenance", async () => {
  const f = await fixture();
  await f.observer.start();
  const _original = f.replaceRequest(async (method) => {
    if (method === "account/rateLimits/read") f.configuration.layers[0]!.version = "changed";
    return _original(method);
  });
  await expect(f.observer.selectedCredential()).rejects.toThrow();
  expect(f.observer.signal.aborted).toBe(true);
});

it("does not report termination when the exact container kill is unconfirmed", async () => {
  const f = await fixture();
  await f.observer.start();
  const stop = vi.spyOn(f.container, "stop").mockResolvedValue({ containerId: "different", stopped: true });
  await expect(f.observer.stop()).rejects.toThrow(/unconfirmed/);
  expect(f.observer.signal.aborted).toBe(true);
  stop.mockRestore();
  // Cleanup still attempts the actual owned fake-container stop, not a forged receipt.
  await f.container.stop("fixture cleanup");
});

it("returns the same confirmed shutdown when a synchronous loss listener reenters stop", async () => {
  const f = await fixture();
  await f.observer.start();
  let nested: Promise<unknown> | undefined;
  f.observer.signal.addEventListener("abort", () => {
    nested = f.observer.stop();
  });
  const result = await f.observer.stop();
  expect(await nested).toEqual(result);
  expect(result).toEqual({ containerId: "c".repeat(64), stopped: true });
});

it("aborts immediately on native account-change notification", async () => {
  const f = await fixture();
  await f.observer.start();
  f.socket.emit("message", Buffer.from(JSON.stringify({ method: "account/updated", params: {} })));
  expect(f.observer.signal.aborted).toBe(true);
  expect(f.observer.current()).toBe(false);
});

it("expires initial admission when the shared quota guard never resolves", async () => {
  vi.useFakeTimers();
  const f = await fixture({ startupTimeoutMs: 120, onSnapshot: () => new Promise(() => {}) });
  const starting = f.observer.start();
  const rejected = expect(starting).rejects.toThrow(/startup/);
  await vi.advanceTimersByTimeAsync(140);
  await rejected;
  expect(f.observer.signal.aborted).toBe(true);
});

it("uses a distinct protected observer socket without accepting arbitrary socket or cwd mappings", async () => {
  const f = await fixture({ observerSlot: "account-worker-2" });
  await f.observer.start();
  expect(f.command.spawn.mock.calls.flat(2).join(" ")).toContain(
    "unix:///eval/control/account-worker-2/account.sock",
  );
  expect(() =>
    createLeadAccountObserver({
      container: f.container,
      allocation: f.allocation,
      observerSlot: "../escape",
    }),
  ).toThrow("allocation");
  expect(() =>
    createLeadAccountObserver({
      container: f.container,
      allocation: { ...f.allocation, hostCwd: "/owner" },
      observerSlot: "account-worker-3",
    }),
  ).toThrow("allocation");
});

// @ts-expect-error -- actual aggregate observer composition; transport remains fake above.
import { createLeadAdmission } from "../../../scripts/evals/lead-admission.mjs";
// @ts-expect-error -- exact owner class, kernel proof replaced explicitly in this fixture.
import { NativeOwnerAttachment } from "../../../scripts/evals/lead-native-attachment.mjs";

it("real observers feed one-use trusted snapshots into real aggregate admission before either is ready", async () => {
  let admission: any;
  const firstPublished = vi.fn(async (value) => admission.observe(value));
  const f = await fixture({ onSnapshot: firstPublished, maxAgeMs: 5000, intervalMs: 1000 });
  const owner = new NativeOwnerAttachment(f.container, { herdrSha256: "b".repeat(64) });
  vi.spyOn(owner, "attached").mockResolvedValue(true);
  admission = createLeadAdmission({
    container: f.container,
    ownerAttachment: owner,
    accountIds: ["account", "second", "account"],
  });
  const home = join(f.root, "control", "second-observer-auth");
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(
    join(home, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "second-fixture-token", account_id: "second" },
    }),
    { mode: 0o600 },
  );
  const socket = Object.assign(new EventEmitter(), {
    send: (raw: string, callback?: (error?: Error) => void) => {
      callback?.();
      const message = JSON.parse(raw);
      const result =
        message.method === "account/read"
          ? { account: { type: "chatgpt", email: "fixture@example.invalid", planType: "pro" } }
          : message.method === "account/rateLimits/read"
            ? { ...f.quota, accountId: "second" }
            : message.method === "config/read"
              ? f.configuration
              : {};
      if (message.id !== undefined)
        queueMicrotask(() => socket.emit("message", Buffer.from(JSON.stringify({ id: message.id, result }))));
    },
    close: () => socket.emit("close"),
  });
  const second = createLeadAccountObserver({
    container: f.container,
    allocation: {
      ...f.allocation,
      accountHome: home,
      containerAccountHome: "/eval/control/second-observer-auth",
      accountId: "second",
    },
    observerSlot: "second-account",
    onSnapshot: admission.observe,
  });
  cleanup.push(async () => {
    await second.stop().catch(() => {});
  });
  admission.registerObserver(f.observer);
  admission.registerObserver(second);
  const firstStart = f.observer.start();
  await vi.waitFor(() => expect(firstPublished).toHaveBeenCalled());
  expect(f.observer.current()).toBe(false);
  trusted.sockets.push(socket);
  await Promise.all([firstStart, second.start()]);
  expect(f.observer.current()).toBe(true);
  expect(second.current()).toBe(true);
  expect(admission.evidence().accounts).toEqual(["account", "second"]);
  expect(admission.evidence().baselines).toHaveLength(2);
  const firstSnapshot = firstPublished.mock.calls[0]![0];
  await expect(admission.observe(firstSnapshot)).rejects.toThrow("Fresh controller-observed");
  expect(f.container.signal.aborted).toBe(true);
});

it("real observer startup cannot hang behind a lost owner-proof admission barrier", async () => {
  let admission: any;
  const f = await fixture({
    onSnapshot: (value: unknown) => admission.observe(value),
    maxAgeMs: 5000,
    intervalMs: 1000,
  });
  const owner = new NativeOwnerAttachment(f.container, { herdrSha256: "b".repeat(64) });
  vi.spyOn(owner, "attached").mockImplementation(() => new Promise(() => {}));
  admission = createLeadAdmission({
    container: f.container,
    ownerAttachment: owner,
    accountIds: ["account"],
  });
  admission.registerObserver(f.observer);
  await expect(f.observer.start()).rejects.toThrow("startup failed");
  expect(f.container.signal.aborted).toBe(true);
  expect(f.observer.current()).toBe(false);
}, 6000);

it("native attach cannot dispatch after stop latches during identity proof", async () => {
  const f = await fixture();
  const input = Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
    output = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  let release!: (value: unknown) => void;
  const inspect = vi.spyOn(f.container, "inspect");
  inspect
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue({ State: { Running: false } });
  try {
    const pending = f.container.attach(["never-launch"]);
    const rejected = expect(pending).rejects.toThrow("Stopped containers");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await f.container.stop("quota lost while attachment proof awaited");
    release({ State: { Running: true } });
    await rejected;
    expect(f.command.spawn).not.toHaveBeenCalled();
  } finally {
    inspect.mockRestore();
    if (input) Object.defineProperty(process.stdin, "isTTY", input);
    else Reflect.deleteProperty(process.stdin, "isTTY");
    if (output) Object.defineProperty(process.stdout, "isTTY", output);
    else Reflect.deleteProperty(process.stdout, "isTTY");
  }
});
