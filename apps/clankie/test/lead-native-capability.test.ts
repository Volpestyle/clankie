import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// Entire process boundary is fake: neither git source builds, Docker nor the
// credential-free sandbox probe is executed. Brands exist only in this test VM.
const processPort = vi.hoisted(() => ({
  manifest: undefined as unknown,
  command: (_args: string[]): string => {
    throw Error("Unconfigured fake process");
  },
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) =>
      String(args[0]).endsWith("/scripts/evals/lead-tasks.json") && processPort.manifest
        ? JSON.stringify(processPort.manifest)
        : fs.readFileSync(...args),
  };
});
vi.mock("node:child_process", () => ({
  spawn: () => {
    throw Error("No child process launch in capability fixture");
  },
  execFile: (
    file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout?: string) => void,
  ) => {
    if (file !== "docker") throw Error("Unexpected executable");
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough() });
    queueMicrotask(() => {
      try {
        callback(null, processPort.command(args.slice(4)));
      } catch (error) {
        callback(error as Error);
      }
    });
    return child;
  },
  execFileSync: (file: string, args: string[], options?: { encoding?: string }) => {
    const result = (value: string) => (options?.encoding ? value : Buffer.from(value));
    if (file !== "git" || args[0] !== "-C") throw Error("Unexpected source subprocess");
    const codex = args[1]!.endsWith("codex");
    if (args[2] === "remote")
      return result(
        codex ? "git@github.com:openai/codex.git" : "git@github.com:Volpestyle/clankie-herdr.git",
      );
    if (args[2] === "rev-parse")
      return result(
        args[3] === "HEAD" ? "a".repeat(40) : args[3]?.startsWith("HEAD:tasks/") ? "b".repeat(40) : args[3]!,
      );
    if (args[2] === "archive") return result(`inert fake archive: ${codex ? "codex" : "herdr"}`);
    throw Error("Unexpected source command");
  },
}));
// @ts-expect-error -- manual checkout-only ESM runner.
import { dockerTransport, LeadContainer } from "../../../scripts/evals/lead-containment.mjs";
// @ts-expect-error -- manual checkout-only ESM runner.
import { buildNativeImage } from "../../../scripts/evals/lead-native-image.mjs";
// @ts-expect-error -- manual checkout-only ESM runner.
import * as nativeCapability from "../../../scripts/evals/lead-native-capability.mjs";
const { probeNativeRuntime, assertNativeRuntimeCapability } = nativeCapability;
// @ts-expect-error -- manual checkout-only ESM runner.
import * as htmlMediation from "../../../scripts/evals/lead-html-mediation.mjs";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "native-capability-fixture-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ["config", "codex", "herdr", "native"])
    mkdirSync(join(root, directory), { mode: 0o700 });
  const socket = join(root, "daemon.sock"),
    server = createServer();
  server.listen(socket);
  await once(server, "listening");
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const image = "sha256:" + "a".repeat(64),
    calls: string[][] = [];
  const containers = new Map<string, any>();
  const tags = new Map<string, string>();
  let mediationFailed = false;
  let lastIsolation: unknown;
  let helperFails = false,
    descendantFails = false;
  let daemon = "fixture-daemon",
    stopFails = false,
    isolate = true;
  processPort.command = (args) => {
    calls.push(args);
    switch (args[0]) {
      case "build":
        writeFileSync(
          args[args.indexOf("--iidfile") + 1]!,
          args.at(-1)!.endsWith("html-build") ? "sha256:" + "e".repeat(64) : image,
          { mode: 0o600 },
        );
        return "";
      case "info":
        return JSON.stringify({ ID: daemon, OSType: "linux" });
      case "image":
        return JSON.stringify([{ Id: tags.get(args[2]!) ?? args[2], Os: "linux" }]);
      case "tag":
        tags.set(args[2]!, args[1]!);
        return "";
      case "create": {
        const id = (containers.size + 1).toString(16).padStart(64, "0");
        const labels = Object.fromEntries(
          args.flatMap((v, index) => (v === "--label" ? [args[index + 1]!.split("=")] : [])),
        );
        const mounts = args
          .flatMap((v, index) => (v === "--mount" ? [args[index + 1]!] : []))
          .map((value) => {
            const map = Object.fromEntries(value.split(",").map((part) => part.split("=")));
            return { Type: "bind", Source: map.src, Destination: map.dst, RW: !value.includes(",readonly") };
          });
        containers.set(id, {
          FixtureProbe: args.includes("python3"),
          Id: id,
          Image: args[args.indexOf("--entrypoint") + 2],
          Config: { User: `${process.getuid!()}:${process.getgid!()}`, Labels: labels },
          HostConfig: {
            Privileged: false,
            ReadonlyRootfs: true,
            NetworkMode: args.find((v) => v.startsWith("--network="))!.split("=")[1],
            PidMode: "",
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges"],
          },
          Mounts: mounts,
          State: { Running: false },
        });
        return id;
      }
      case "inspect":
        return JSON.stringify([containers.get(args[1]!)]);
      case "start":
        containers.get(args[1]!).State.Running = true;
        return "";
      case "kill":
        if (!stopFails) containers.get(args.at(-1)!).State.Running = false;
        return "";
      case "wait": {
        const info = containers.get(args[1]!);
        const logs = info.Mounts.find((mount: any) => mount.Destination === "/logs/verifier")?.Source;
        if (!logs) throw Error("Unexpected fake wait");
        if (!info.FixtureProbe) {
          writeFileSync(
            join(logs, "ctrf.json"),
            JSON.stringify({
              results: {
                summary: { tests: 1, passed: 1, failed: 0 },
                tests: [{ name: "test_fixture", status: "passed" }],
              },
            }),
            { mode: 0o600 },
          );
          writeFileSync(join(logs, "reward.txt"), "1", { mode: 0o600 });
          if (mediationFailed)
            writeFileSync(join(logs, "lead-mediation-failure"), "fixture failure", { mode: 0o600 });
          info.State.Running = false;
          return "0";
        }
        writeFileSync(
          join(logs, "mediation-proof.json"),
          JSON.stringify({
            original: "canary-input",
            rewritten: true,
            testsDenied: isolate,
            logsDenied: true,
            parentDenied: true,
            pidNamespaceChanged: true,
            networkNamespaceChanged: true,
            noControl: true,
            environmentClean: true,
            trampoline: "/opt/lead/candidate-python",
            argv: "/tmp/fixture.html",
          }),
          { mode: 0o600 },
        );
        info.State.Running = false;
        return "0";
      }
      case "exec": {
        const script = args.at(-1)!;
        if (args.includes("/usr/local/bin/python3"))
          return JSON.stringify({
            python: "3.12",
            packages: { beautifulsoup4: "4.13.4", lxml: "6.1.1" },
            executableSha256: "9".repeat(64),
            inputs: {},
          });
        if (args.some((arg) => arg.includes("noLateWrite")))
          return JSON.stringify({ namespaceGone: !descendantFails, noLateWrite: !descendantFails });
        if (script.includes("Object.fromEntries"))
          return JSON.stringify(
            Object.fromEntries(
              [
                "/opt/codex/bin/codex",
                "/opt/codex/bin/bwrap",
                "/usr/local/bin/herdr",
                "/usr/local/bin/node",
                "/usr/local/lib/lead-coding-helper.mjs",
                "/usr/local/lib/lead-coding-supervisor.mjs",
                "/usr/local/lib/lead-native-policy.mjs",
              ].map((path) => [
                path,
                path.endsWith(".mjs")
                  ? createHash("sha256")
                      .update(
                        readFileSync(
                          new URL("../../../scripts/evals/" + path.split("/").at(-1), import.meta.url),
                        ),
                      )
                      .digest("hex")
                  : "b".repeat(64),
              ]),
            ),
          );
        if (script.includes("supervisor.json"))
          return JSON.stringify({ pid: 10, namespace: "pid:[1]", network: "net:[1]" });
        if (args.includes("/usr/local/lib/lead-coding-supervisor.mjs"))
          return JSON.stringify({
            result: { output: JSON.stringify(lastIsolation), exitCode: helperFails ? 1 : 0 },
            settlement: { namespace: "pid:[42]", complete: true, helperPid: 42, helperStart: "10" },
          });
        if (args.includes("sandbox")) {
          const nonce = JSON.parse(/nonce:("[^"]+")/u.exec(script)![1]!);
          lastIsolation = {
            nonce,
            gitConfigDenied: true,
            projectConfigDenied: true,
            cwdConfigDenied: true,
            controlDenied: isolate,
            authDenied: true,
            parentProcDenied: true,
            privateSocketDenied: true,
            allocatedWrite: true,
            namespace: "pid:[2]",
            network: "net:[2]",
          };
          return JSON.stringify(lastIsolation);
        }
        throw Error("Unrecognized fake container command");
      }
      default:
        throw Error("Unknown fake Docker command");
    }
  };
  const command = dockerTransport({ socketPath: socket, configDirectory: join(root, "config") });
  const build = await buildNativeImage({
    command,
    output: join(root, "build"),
    codexSource: join(root, "codex"),
    herdrSource: join(root, "herdr"),
    rustImage: "rust:1.96.1-bookworm@sha256:" + "c".repeat(64),
    nodeImage: "node:24.20.0-bookworm@sha256:" + "d".repeat(64),
  });
  return {
    root,
    image,
    command,
    build,
    calls,
    containers,
    changeDaemon: () => {
      daemon = "changed";
    },
    uncertainStop: () => {
      stopFails = true;
    },
    mediationFailure: () => {
      mediationFailed = true;
    },
    failedHelper: () => {
      helperFails = true;
    },
    failedDescendants: () => {
      descendantFails = true;
    },
    failedIsolation: () => {
      isolate = false;
    },
  };
}
it("binds real origin-chain code to the exact fake daemon/build/probe and rejects copied evidence", async () => {
  const f = await fixture();
  const proof = await probeNativeRuntime({ build: f.build, command: f.command, root: join(f.root, "probe") });
  await assertNativeRuntimeCapability(proof, f);
  expect(f.calls.some((args) => args.includes("sandbox") && args.includes("--permission-profile"))).toBe(
    true,
  );
  expect([...f.containers.values()].every((info) => !info.State.Running)).toBe(true);
  await expect(assertNativeRuntimeCapability(structuredClone(proof), f)).rejects.toThrow("controller-origin");
  const native = new LeadContainer({
    root: join(f.root, "native"),
    image: f.image,
    command: f.command,
    capability: proof,
  });
  await native.create(["fixture-entry"]);
  await native.start();
  f.changeDaemon();
  await expect(native.exec(["never-dispatched"])).rejects.toThrow("daemon identity");
  expect(f.calls.some((args) => args.includes("never-dispatched"))).toBe(false);
  const firstStop = native.stop("fixture cleanup"),
    secondStop = native.stop("parallel observer cleanup");
  expect(firstStop).toBe(secondStop);
  const receipt = await firstStop;
  expect(receipt).toMatchObject({ containerId: native.id, stopped: true });
  expect(f.calls.filter((args) => args[0] === "kill" && args.at(-1) === native.id)).toHaveLength(1);
});
for (const failure of ["failedIsolation", "failedHelper", "failedDescendants", "uncertainStop"] as const)
  it(`never produces usable authority after ${failure}`, async () => {
    const f = await fixture();
    f[failure]();
    await expect(
      probeNativeRuntime({ build: f.build, command: f.command, root: join(f.root, "probe") }),
    ).rejects.toThrow();
    expect(f.calls.some((args) => args[0] === "kill")).toBe(true);
  });

it("builds and probes the actual HTML mediation origin chain with fake containers only", async () => {
  const f = await fixture();
  const sourceCommit = "f".repeat(40);
  const build = await htmlMediation.buildHtmlMediation({
    command: f.command,
    nativeBuild: f.build,
    baseImage: f.image,
    sourceCommit,
    output: join(f.root, "html-build"),
  });
  const proof = await htmlMediation.probeHtmlMediation({
    build,
    command: f.command,
    root: join(f.root, "html-probe"),
  });
  const binding = { command: f.command, image: build.image, baseImage: f.image, sourceCommit };
  await expect(htmlMediation.assertHtmlMediation(proof, binding)).resolves.toMatchObject({ sourceCommit });
  await expect(htmlMediation.assertHtmlMediation(structuredClone(proof), binding)).rejects.toThrow(
    "controller-probed",
  );
  await expect(
    htmlMediation.assertHtmlMediation(proof, { ...binding, baseImage: "sha256:" + "d".repeat(64) }),
  ).rejects.toThrow("controller-probed");
  f.changeDaemon();
  await expect(htmlMediation.assertHtmlMediation(proof, binding)).rejects.toThrow("daemon");
  expect(f.calls.some((args) => args.includes("PYTHONPATH=/opt/lead/bootstrap"))).toBe(true);
});

it("uses the official bridge's derived-image/probe binding and rejects a mediation-failure marker even with a passing report", async () => {
  const f = await fixture();
  const sourceRoot = join(f.root, "official-fixture");
  mkdirSync(sourceRoot, { mode: 0o700 });
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const files = {
    "environment/Dockerfile": "FROM fixture",
    "tests/Dockerfile": "FROM fixture",
    "tests/test_outputs.py": "def test_fixture():\n    assert True\n",
    "tests/test.sh": "inert pinned fixture",
  };
  writeFileSync(join(sourceRoot, "LICENSE"), "fixture license");
  for (const [path, bytes] of Object.entries(files)) {
    const target = join(sourceRoot, "tasks/html-js-filter", path);
    mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes, { mode: 0o600 });
  }
  processPort.manifest = {
    neutral: [
      {
        id: "html-js-filter",
        commit: "a".repeat(40),
        tree: "b".repeat(40),
        licenseSha256: digest("fixture license"),
        files: Object.entries(files).map(([path, bytes]) => ({
          path: `tasks/html-js-filter/${path}`,
          sha256: digest(bytes),
        })),
      },
    ],
  };
  const { stageTerminalBench, TerminalBenchBridge } =
    // @ts-expect-error -- synthetic pinned source manifest; no official grader runs.
    await import("../../../scripts/evals/lead-terminal-bench.mjs");
  const staged = stageTerminalBench({ sourceRoot, taskId: "html-js-filter", output: join(f.root, "staged") });
  const bridge = new TerminalBenchBridge({ staged, command: f.command });
  const environment = await bridge.build("environment");
  const taskBuildOptions = {
    command: f.command,
    output: join(f.root, "task-build"),
    codexSource: join(f.root, "codex"),
    herdrSource: join(f.root, "herdr"),
    rustImage: "rust:1.96.1-bookworm@sha256:" + "c".repeat(64),
    nodeImage: "node:24.20.0-bookworm@sha256:" + "d".repeat(64),
    taskEnvironment: environment,
  };
  await expect(
    buildNativeImage({ ...taskBuildOptions, taskEnvironment: structuredClone(environment) }),
  ).rejects.toThrow("Controller-built official");
  const taskBuild = await buildNativeImage(taskBuildOptions);
  const recipe = readFileSync(join(f.root, "task-build", "Dockerfile"), "utf8");
  expect(recipe).toContain(`FROM ${environment.image}\nCOPY --from=node /usr/local/bin/node`);
  expect(recipe).not.toContain("libasound2 python3");
  expect(recipe).toContain("/usr/share/licenses/bubblewrap/COPYING");
  const taskProof = await probeNativeRuntime({
    build: taskBuild,
    command: f.command,
    root: join(f.root, "task-probe"),
  });
  expect(nativeCapability.nativeRuntimeEvidence(taskProof).taskEnvironment).toMatchObject({
    taskId: "html-js-filter",
    python: "3.12",
    packages: { beautifulsoup4: "4.13.4", lxml: "6.1.1" },
  });
  const base = await bridge.build("tests");
  const candidate = join(f.root, "candidate");
  mkdirSync(candidate, { mode: 0o700 });
  writeFileSync(join(candidate, "filter.py"), "inert candidate artifact", { mode: 0o600 });
  await expect(
    bridge.verify({ image: base.image, candidateRoot: candidate, output: join(f.root, "refused") }),
  ).rejects.toThrow("controller-probed");
  const built = await bridge.buildHtml({ nativeBuild: f.build, output: join(f.root, "html-build") });
  await bridge.probeHtml({ root: join(f.root, "html-probe") });
  await expect(
    bridge.verify({ image: built.image, candidateRoot: candidate, output: join(f.root, "verified") }),
  ).resolves.toMatchObject({ status: "passed", mediation: { sourceCommit: "a".repeat(40) } });
  f.mediationFailure();
  await expect(
    bridge.verify({ image: built.image, candidateRoot: candidate, output: join(f.root, "failed") }),
  ).rejects.toThrow("mediation failed");
});
