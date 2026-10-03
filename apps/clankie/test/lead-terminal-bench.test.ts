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
