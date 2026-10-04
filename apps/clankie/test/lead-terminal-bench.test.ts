/** Synthetic source/container fixtures only; this does not run or certify a benchmark task. */
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ manifest: {} as unknown }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]).endsWith("/scripts/evals/lead-tasks.json")) return JSON.stringify(state.manifest);
      return fs.readFileSync(...args);
    },
  };
});
vi.mock("node:child_process", async (original) => {
  const cp = await original<typeof import("node:child_process")>();
  return {
    ...cp,
    execFileSync: (command: string, args: string[]) => {
      if (command !== "git") throw Error("No real child process is allowed in this fixture");
      return args.at(-1)?.startsWith("HEAD:tasks/") ? "b".repeat(40) : "a".repeat(40);
    },
  };
});
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture(symlinkReport = false) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "terminal-bridge-fixture-"));
  roots.push(root);
  const sourceRoot = join(root, "source");
  mkdirSync(sourceRoot, { mode: 0o700 });
  const files = {
    "environment/Dockerfile": "FROM fixture\n",
    "environment/check_routing.py": "# trusted initial checker\n",
    "environment/layout_spec.json": '{"trusted":"layout"}\n',
    "tests/Dockerfile": "FROM fixture\nCOPY . /tests\n",
    "tests/test_fixture.py": "def test_fixture():\n    assert True\n",
    "tests/test.sh": "#!/bin/sh\nexit 0\n",
    "instruction.md": "Synthetic fixture",
    "task.toml": "Synthetic fixture",
    "solution/solve.sh": "Never copied",
  };
  writeFileSync(join(sourceRoot, "LICENSE"), "fixture license");
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(sourceRoot, "tasks/photonic-waveguide-routing", path);
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    writeFileSync(absolute, content);
  }
  state.manifest = {
    neutral: [
      {
        id: "photonic-waveguide-routing",
        commit: "a".repeat(40),
        tree: "b".repeat(40),
        licenseSha256: sha("fixture license"),
        files: Object.entries(files).map(([path, content]) => ({
          path: `tasks/photonic-waveguide-routing/${path}`,
          sha256: sha(content),
        })),
      },
    ],
  };
  // @ts-expect-error -- manual checkout-only ESM module, synthetic pinned manifest above.
  const bench = await import("../../../scripts/evals/lead-terminal-bench.mjs");
  const { stageTerminalBench, TerminalBenchBridge } = bench;
  const staged = stageTerminalBench({
    sourceRoot,
    taskId: "photonic-waveguide-routing",
    output: join(root, "staged"),
  });
  const id = "c".repeat(64),
    image = `sha256:${"d".repeat(64)}`;
  let running = false;
  let labels: Record<string, string> = {},
    mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }> = [];
  const command = vi.fn(async (args: string[]) => {
    if (args[0] === "build") {
      writeFileSync(args[args.indexOf("--iidfile") + 1]!, image);
      return "";
    }
    if (args[0] === "image") return JSON.stringify([{ Id: image, Os: "linux", RepoDigests: [] }]);
    if (args[0] === "create") {
      labels = {};
      mounts = [];
      args.forEach((arg, index) => {
        if (arg === "--label") {
          const [key, value] = args[index + 1]!.split("=");
          labels[key!] = value!;
        }
        if (arg === "--mount") {
          const text = args[index + 1]!;
          mounts.push({
            Type: "bind",
            Source: /src=([^,]+)/u.exec(text)![1]!,
            Destination: /dst=([^,]+)/u.exec(text)![1]!,
            RW: !text.endsWith(",readonly"),
          });
        }
      });
      return id;
    }
    if (args[0] === "inspect")
      return JSON.stringify([
        {
          Id: id,
          Image: image,
          Config: { User: `${process.getuid!()}:${process.getgid!()}`, Labels: labels },
          HostConfig: {
            Privileged: false,
            ReadonlyRootfs: true,
            NetworkMode: "none",
            PidMode: "",
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges"],
          },
          Mounts: mounts,
          State: { Running: running },
        },
      ]);
    if (args[0] === "start") running = true;
    if (args[0] === "wait") {
      running = false;
      const logs = mounts.find((mount) => mount.Destination === "/logs/verifier")!.Source;
      const report = JSON.stringify({
        results: {
          summary: { tests: 1, passed: 1, failed: 0 },
          tests: [{ name: "test_fixture.py::test_fixture", status: "passed" }],
        },
      });
      writeFileSync(join(logs, "reward.txt"), "1\n");
      if (symlinkReport) {
        writeFileSync(join(root, "external.json"), report);
        symlinkSync(join(root, "external.json"), join(logs, "ctrf.json"));
      } else writeFileSync(join(logs, "ctrf.json"), report);
      return "0";
    }
    if (args[0] === "kill") running = false;
    return "";
  });
  const candidateRoot = join(root, "candidate");
  mkdirSync(candidateRoot, { mode: 0o700 });
  writeFileSync(join(candidateRoot, "routing_result_1.json"), '{"fixture":"never executed"}\n');
  return { root, staged, candidateRoot, command, bridge: new TerminalBenchBridge({ staged, command }) };
}

it("uses separate exact build contexts and transfers only the declared artifact", async () => {
  const f = await fixture();
  const built = await f.bridge.build("tests");
  const result = await f.bridge.verify({
    image: built.image,
    candidateRoot: f.candidateRoot,
    output: join(f.root, "verification"),
  });
  expect(result).toMatchObject({ status: "passed", tests: 1, sourceCommit: "a".repeat(40) });
  expect(f.command.mock.calls[0]![0].at(-1)).toBe(join(f.root, "staged/tests"));
  expect(f.command.mock.calls.find(([args]) => args[0] === "create")![0]).toContain("--network=none");
  expect(readFileSync(join(f.root, "verification/app/routing_result_1.json"), "utf8")).toContain(
    "never executed",
  );
});

it("rejects post-staging context injection before any container build", async () => {
  const f = await fixture();
  writeFileSync(join(f.root, "staged/tests/.dockerignore"), "test_fixture.py\n");
  await expect(f.bridge.build("tests")).rejects.toThrow("unpinned");
  expect(f.command).not.toHaveBeenCalled();
});

it("rejects external report symlinks despite successful exit/reward and retains exact stop checks", async () => {
  const f = await fixture(true);
  const built = await f.bridge.build("tests");
  await expect(
    f.bridge.verify({
      image: built.image,
      candidateRoot: f.candidateRoot,
      output: join(f.root, "verification"),
    }),
  ).rejects.toThrow();
  expect(f.command.mock.calls.filter(([args]) => args[0] === "inspect").length).toBeGreaterThanOrEqual(4);
});

it("stages pinned initial task inputs without exposing held-out verifier files", async () => {
  const f = await fixture();
  const workspace = join(f.root, "workspace");
  mkdirSync(workspace, { mode: 0o700 });
  expect(f.bridge.stageWorkspaceInputs(workspace).map((entry: { name: string }) => entry.name)).toEqual([
    "check_routing.py",
    "layout_spec.json",
  ]);
  expect(readFileSync(join(workspace, "check_routing.py"), "utf8")).toContain("trusted initial");
  expect(() => f.bridge.stageWorkspaceInputs(workspace)).toThrow();
  expect(f.command).not.toHaveBeenCalled();
});

it("owner cancellation stops the exact active verifier and never accepts its later result", async () => {
  const f = await fixture(),
    built = await f.bridge.build("tests"),
    abort = new AbortController();
  const original = f.command.getMockImplementation()!;
  let release!: (value: string) => void;
  f.command.mockImplementation(async (args) =>
    args[0] === "wait"
      ? new Promise<string>((resolve) => {
          release = resolve;
        })
      : original(args),
  );
  const pending = f.bridge.verify({
    image: built.image,
    candidateRoot: f.candidateRoot,
    output: join(f.root, "cancelled"),
    signal: abort.signal,
  });
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  abort.abort();
  await vi.waitFor(() => expect(f.command.mock.calls.filter(([args]) => args[0] === "kill")).toHaveLength(1));
  release("0");
  await rejected;
  expect(f.command.mock.calls.filter(([args]) => args[0] === "kill")).toHaveLength(1);
});

it("cleans up the exact created ID when its first inspection fails, retaining the completion error", async () => {
  const f = await fixture(),
    built = await f.bridge.build("tests");
  const original = f.command.getMockImplementation()!;
  let inspections = 0;
  f.command.mockImplementation(async (args) => {
    if (args[0] === "inspect" && ++inspections === 1) throw Error("first inspection unavailable");
    return original(args);
  });
  const output = join(f.root, "verification");
  await expect(
    f.bridge.verify({ image: built.image, candidateRoot: f.candidateRoot, output }),
  ).rejects.toMatchObject({
    message: "first inspection unavailable",
    containerId: "c".repeat(64),
    verifierStopConfirmed: true,
  });
  expect(inspections).toBe(3);
  expect(f.command.mock.calls.filter(([args]) => args[0] === "start")).toHaveLength(0);
  expect(f.command.mock.calls.filter(([args]) => args[0] === "create")).toHaveLength(1);
  expect(
    f.command.mock.calls
      .filter(([args]) => args[0] === "inspect")
      .every(([args]) => args[1] === "c".repeat(64)),
  ).toBe(true);
  expect(JSON.parse(readFileSync(join(output, "container-stop.json"), "utf8"))).toMatchObject({
    containerId: "c".repeat(64),
    stop: { stopped: true },
    cancelled: false,
    completionError: "first inspection unavailable",
  });
});

it.each(["inspect", "kill"])(
  "retains uncertain exact-ID cleanup after create inspection failure: %s",
  async (failure) => {
    const f = await fixture(),
      built = await f.bridge.build("tests");
    const original = f.command.getMockImplementation()!;
    let inspections = 0;
    f.command.mockImplementation(async (args) => {
      if (args[0] === "inspect") {
        if (++inspections === 1) throw Error("first inspection unavailable");
        if (failure === "inspect") throw Error("cleanup inspection unavailable");
        const rows = JSON.parse(await original(args));
        rows[0].State.Running = true;
        return JSON.stringify(rows);
      }
      if (args[0] === "kill") throw Error("kill unavailable");
      return original(args);
    });
    const output = join(f.root, "verification");
    await expect(
      f.bridge.verify({ image: built.image, candidateRoot: f.candidateRoot, output }),
    ).rejects.toMatchObject({
      code: "terminal-bench-stop-unconfirmed",
      containerId: "c".repeat(64),
      verifierStopConfirmed: false,
    });
    expect(f.command.mock.calls.filter(([args]) => args[0] === "create")).toHaveLength(1);
    expect(f.command.mock.calls.filter(([args]) => args[0] === "start")).toHaveLength(0);
    expect(f.command.mock.calls.filter(([args]) => args[0] === "kill")).toEqual(
      failure === "kill" ? [[["kill", "--signal=KILL", "c".repeat(64)]]] : [],
    );
    expect(JSON.parse(readFileSync(join(output, "container-stop.json"), "utf8"))).toMatchObject({
      containerId: "c".repeat(64),
      stop: { confirmed: false },
      completionError: "first inspection unavailable",
    });
  },
);

it("aborting pending create never starts its later exact ID and still confirms cleanup", async () => {
  const f = await fixture(),
    built = await f.bridge.build("tests"),
    abort = new AbortController();
  const original = f.command.getMockImplementation()!;
  let release!: () => void;
  f.command.mockImplementation(async (args) => {
    const result = await original(args);
    if (args[0] === "create")
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return result;
  });
  const output = join(f.root, "verification");
  const pending = f.bridge.verify({
    image: built.image,
    candidateRoot: f.candidateRoot,
    output,
    signal: abort.signal,
  });
  const rejected = expect(pending).rejects.toMatchObject({ verifierStopConfirmed: true });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  abort.abort(Error("owner cancelled during create"));
  expect(f.command.mock.calls.filter(([args]) => args[0] === "inspect")).toHaveLength(0);
  release();
  await rejected;
  expect(f.command.mock.calls.filter(([args]) => args[0] === "start")).toHaveLength(0);
  expect(f.command.mock.calls.filter(([args]) => args[0] === "create")).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(output, "container-stop.json"), "utf8"))).toMatchObject({
    containerId: "c".repeat(64),
    stop: { stopped: true },
    cancelled: true,
  });
});

it("ambiguous create cannot authorize cleanup, start or another create", async () => {
  const f = await fixture(),
    built = await f.bridge.build("tests");
  const original = f.command.getMockImplementation()!;
  f.command.mockImplementation(async (args) => (args[0] === "create" ? "unknown" : original(args)));
  const output = join(f.root, "verification");
  await expect(
    f.bridge.verify({ image: built.image, candidateRoot: f.candidateRoot, output }),
  ).rejects.toThrow("Ambiguous Docker create");
  expect(f.command.mock.calls.filter(([args]) => args[0] === "create")).toHaveLength(1);
  expect(
    f.command.mock.calls.filter(([args]) => ["start", "inspect", "kill"].includes(args[0]!)),
  ).toHaveLength(0);
  expect(() => readFileSync(join(output, "container-stop.json"))).toThrow();
});

it("a passing report cannot pass when the exact verifier stop is unconfirmed", async () => {
  const f = await fixture(),
    built = await f.bridge.build("tests");
  const original = f.command.getMockImplementation()!;
  let inspections = 0;
  f.command.mockImplementation(async (args) => {
    if (args[0] === "inspect" && ++inspections === 4) throw Error("cleanup inspection unavailable");
    return original(args);
  });
  const output = join(f.root, "verification");
  await expect(
    f.bridge.verify({ image: built.image, candidateRoot: f.candidateRoot, output }),
  ).rejects.toMatchObject({ code: "terminal-bench-stop-unconfirmed", verifierStopConfirmed: false });
  expect(JSON.parse(readFileSync(join(output, "container-stop.json"), "utf8"))).toMatchObject({
    containerId: "c".repeat(64),
    stop: { confirmed: false },
    completionError: null,
  });
});

it("an invalid report retains its own failure with confirmed cleanup", async () => {
  const f = await fixture(true),
    built = await f.bridge.build("tests");
  const output = join(f.root, "verification");
  const error = await f.bridge
    .verify({ image: built.image, candidateRoot: f.candidateRoot, output })
    .catch((value: Error) => value);
  expect(error).toMatchObject({ verifierStopConfirmed: true, containerId: "c".repeat(64) });
  expect(error.code).not.toBe("terminal-bench-stop-unconfirmed");
  expect(JSON.parse(readFileSync(join(output, "container-stop.json"), "utf8"))).toMatchObject({
    stop: { stopped: true },
  });
});

it.each(["missing", "malformed"])("a %s report is unavailable with confirmed cleanup", async (failure) => {
  const f = await fixture(),
    built = await f.bridge.build("tests");
  const original = f.command.getMockImplementation()!;
  const output = join(f.root, "verification");
  f.command.mockImplementation(async (args) => {
    const result = await original(args);
    if (args[0] === "wait") {
      const report = join(output, "logs/ctrf.json");
      if (failure === "missing") rmSync(report);
      else writeFileSync(report, "{");
    }
    return result;
  });
  await expect(
    f.bridge.verify({ image: built.image, candidateRoot: f.candidateRoot, output }),
  ).rejects.toMatchObject({ verifierStopConfirmed: true, containerId: "c".repeat(64) });
  const receipt = JSON.parse(readFileSync(join(output, "container-stop.json"), "utf8"));
  expect(receipt.stop.stopped).toBe(true);
  expect(receipt.completionError).toBeTypeOf("string");
  expect(receipt.stopError).toBeNull();
});

it("cancellation during cleanup cannot accept an already passing report", async () => {
  const f = await fixture(),
    built = await f.bridge.build("tests"),
    abort = new AbortController();
  const original = f.command.getMockImplementation()!;
  let inspections = 0,
    release!: () => void;
  f.command.mockImplementation(async (args) => {
    if (args[0] === "inspect" && ++inspections === 4)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return original(args);
  });
  const output = join(f.root, "verification");
  const pending = f.bridge.verify({
    image: built.image,
    candidateRoot: f.candidateRoot,
    output,
    signal: abort.signal,
  });
  const rejected = expect(pending).rejects.toMatchObject({
    message: "cancelled during cleanup",
    verifierStopConfirmed: true,
  });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  abort.abort(Error("cancelled during cleanup"));
  release();
  await rejected;
  expect(JSON.parse(readFileSync(join(output, "container-stop.json"), "utf8"))).toMatchObject({
    stop: { stopped: true },
    cancelled: true,
    completionError: "cancelled during cleanup",
  });
});

it.each([false, true])(
  "pending activation cannot outlive confirmed cleanup (kill fails: %s)",
  async (killFails) => {
    const f = await fixture(),
      built = await f.bridge.build("tests"),
      abort = new AbortController();
    const original = f.command.getMockImplementation()!;
    let release!: () => void;
    f.command.mockImplementation(async (args) => {
      if (args[0] === "start") {
        // The daemon has received start, but has not activated the exact container yet.
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      if (args[0] === "kill" && killFails) throw Error("late activation kill unavailable");
      return original(args);
    });
    const output = join(f.root, "verification");
    const pending = f.bridge.verify({
      image: built.image,
      candidateRoot: f.candidateRoot,
      output,
      signal: abort.signal,
    });
    const settled = pending.then(
      (result: unknown) => ({ passed: result }),
      (error: Error) => ({ error }),
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    abort.abort(Error("owner cancelled pending activation"));
    // Let an incorrectly eager stop finish both inspections while Running is still false.
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    const result = await settled;
    expect(result).not.toHaveProperty("passed");
    const error = (result as { error: Error & { verifierStopConfirmed: boolean; code?: string } }).error;
    const running = JSON.parse(await original(["inspect", "c".repeat(64)]))[0].State.Running;
    expect({ running, confirmed: error.verifierStopConfirmed }).toEqual({
      running: killFails,
      confirmed: !killFails,
    });
    expect(error.code === "terminal-bench-stop-unconfirmed").toBe(killFails);
    expect(f.command.mock.calls.filter(([args]) => args[0] === "kill")).toEqual([
      [["kill", "--signal=KILL", "c".repeat(64)]],
    ]);
    expect(f.command.mock.calls.filter(([args]) => args[0] === "wait")).toHaveLength(0);
    expect(f.command.mock.calls.filter(([args]) => args[0] === "create")).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(output, "container-stop.json"), "utf8"))).toMatchObject({
      containerId: "c".repeat(64),
      stop: killFails ? { confirmed: false } : { stopped: true },
      cancelled: true,
    });
  },
);

it("a rejected activation transport cannot prove cleanup against later daemon activation", async () => {
  const f = await fixture(),
    built = await f.bridge.build("tests"),
    abort = new AbortController();
  const original = f.command.getMockImplementation()!;
  let reject!: (error: Error) => void, activateLate!: () => Promise<string>;
  f.command.mockImplementation(async (args) => {
    if (args[0] === "start") {
      activateLate = () => original(args);
      await new Promise<void>((_resolve, fail) => {
        reject = fail;
      });
    }
    return original(args);
  });
  const output = join(f.root, "verification");
  const pending = f.bridge.verify({
    image: built.image,
    candidateRoot: f.candidateRoot,
    output,
    signal: abort.signal,
  });
  const settled = pending.then(
    (result: unknown) => ({ passed: result }),
    (error: Error) => ({ error }),
  );
  await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
  abort.abort(Error("owner cancelled pending activation"));
  reject(Error("activation transport timeout"));
  const result = await settled;
  expect(result).not.toHaveProperty("passed");
  // Losing the start reply does not prevent the daemon from processing that request later.
  await activateLate();
  const running = JSON.parse(await original(["inspect", "c".repeat(64)]))[0].State.Running;
  const error = (result as { error: Error & { verifierStopConfirmed: boolean; code?: string } }).error;
  expect({ running, confirmed: error.verifierStopConfirmed }).toEqual({ running: true, confirmed: false });
  expect(error.code).toBe("terminal-bench-stop-unconfirmed");
  expect(f.command.mock.calls.filter(([args]) => args[0] === "start")).toHaveLength(1);
  expect(f.command.mock.calls.filter(([args]) => args[0] === "wait")).toHaveLength(0);
  expect(f.command.mock.calls.filter(([args]) => args[0] === "create")).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(output, "container-stop.json"), "utf8"))).toMatchObject({
    containerId: "c".repeat(64),
    stop: { stopped: true },
    activationUnconfirmed: true,
    verifierStopConfirmed: false,
    completionError: "activation transport timeout",
  });
});
