import { execFile, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Writable } from "node:stream";
import { promisify } from "node:util";
import { FleetResourcePolicySchema, machineAccessAllows } from "@clankie/protocol";
import type { ClankieSettings, HerdrSshTransport } from "@clankie/settings";
import { remoteProgramCommand, type HerdrFleet } from "./herdr-fleet.ts";
import { machineAccessLevel } from "./machine-access.ts";

const execute = promisify(execFile);

/**
 * An integrate gate on a linked machine (VUH-2066). The Mac composes the batch
 * as always; the runner ships that exact HEAD, installs and gates it in a
 * fleet-owned workspace there, streams both logs back into the batch's own
 * evidence, and returns the gate's report so revalidation and push stay local.
 */
export interface GateRunner {
  /** The machine ID recorded on install and gate. */
  readonly machine: string;
  /** Put HEAD in a fresh workspace there; refuses unless the remote HEAD is exactly `head`. */
  stage(repo: { readonly directory: string; readonly base: string; readonly head: string }): Promise<void>;
  run(
    step: "install" | "gate",
    base: string,
    out: Writable,
  ): Promise<{ exitCode: number | null; signal: string | null }>;
  /** Copy the gate's recorded selection into the local worktree. */
  collect(directory: string): Promise<void>;
  /** Remove the remote workspace. */
  dispose(): Promise<void>;
}

/** What the linked machine has room for, read before a gate is placed there. */
interface RemoteCapacity {
  readonly ready: boolean;
  readonly loadRatio: number;
  readonly availableMemoryMb: number;
  readonly gates: number;
}

/**
 * Everything happens under `~/.clankie-fleet` inside WSL: its own Node, pnpm
 * and Rust, one clone of the repository's public origin, and one directory per
 * batch with a private home, temp and package store. Nothing touches the
 * owner's panes, shell profile or checkouts, which is why the machine's
 * `workers` access suffices: hired workers there already run repository code.
 */
const WSL_GATE = String.raw`
set -u
op="$1"; batch="$2"
ROOT="$HOME/.clankie-fleet"; B="$ROOT/batches/$batch"; REPO="$ROOT/repos/clankie"
TC="$ROOT/toolchain/node-v26.7.0-linux-x64/bin"; RUST="$ROOT/toolchain/rust"
run() {
  cd "$B/clankie" || exit 3
  env -i PATH="$TC:$ROOT/toolchain/ffmpeg/bin:$RUST/cargo/bin:/usr/local/bin:/usr/bin:/bin" HOME="$B/home" USERPROFILE="$B/home" \
    TMPDIR="$B/tmp" TMP="$B/tmp" TEMP="$B/tmp" XDG_CONFIG_HOME="$B/xdg/config" XDG_CACHE_HOME="$B/xdg/cache" \
    XDG_DATA_HOME="$B/xdg/data" XDG_STATE_HOME="$B/xdg/state" CLANKIE_STATE="$B/home/.clankie" \
    CLANKIE_SETTINGS_FILE="$B/home/.config/clankie/settings.json" \
    CLANKIE_CREDENTIALS_FILE="$B/home/.config/clankie/credentials.json" \
    CLANKIE_CONTROL_PLANE_URL=http://127.0.0.1:1 CAPTAIN_URL=http://127.0.0.1:1 \
    npm_config_store_dir="$B/store" npm_config_package_import_method=copy RUSTUP_HOME="$RUST/rustup" \
    CARGO_HOME="$RUST/cargo" TURBO_DAEMON=false CI=1 LANG=C.UTF-8 "$@"
}
case "$op" in
  capacity)
    ready=0; [ -x "$TC/pnpm" ] && [ -x "$RUST/cargo/bin/cargo" ] && [ -x "$ROOT/toolchain/ffmpeg/bin/ffmpeg" ] && ready=1
    gates=$(find "$ROOT/batches" -mindepth 2 -maxdepth 2 -name gating 2>/dev/null | wc -l)
    read -r load _ < /proc/loadavg
    printf '{"ready":%s,"loadRatio":%s,"availableMemoryMb":%s,"gates":%s}\n' "$ready" \
      "$(awk -v l="$load" -v n="$(nproc)" 'BEGIN{printf "%.3f", l/n}')" \
      "$(awk '/MemAvailable/{printf "%d", $2/1024}' /proc/meminfo)" "$gates" ;;
  stage)
    source="$3"; head="$4"
    rm -rf "$B"; mkdir -p "$B/home" "$B/tmp" "$B/store" "$B/xdg/config" "$B/xdg/cache" "$B/xdg/data" "$B/xdg/state" || exit 3
    [ -d "$REPO" ] || git clone -q --no-checkout "$source" "$REPO" || exit 3
    git -C "$REPO" fetch -q origin && git -C "$REPO" worktree prune || exit 3
    base64 -d > "$B/head.bundle" || exit 3
    if [ -s "$B/head.bundle" ]; then git -C "$REPO" fetch -q "$B/head.bundle" refs/clankie/gate || exit 3; fi
    git -C "$REPO" worktree add -q --detach "$B/clankie" "$head" || exit 3
    [ "$(git -C "$B/clankie" rev-parse HEAD)" = "$head" ] || exit 3 ;;
  install) run pnpm install --frozen-lockfile --store-dir "$B/store" --package-import-method=copy ;;
  gate) touch "$B/gating"; run env CLANKIE_LANDING_BASE="$3" pnpm check:landing; code=$?; rm -f "$B/gating"; exit $code ;;
  report)
    for name in landing-gate.json landing-gate.json.graph.json; do
      if [ -f "$B/clankie/.local/$name" ]; then printf '%s %s\n' "$name" "$(base64 < "$B/clankie/.local/$name" | tr -d '\n')"; fi
    done ;;
  dispose) git -C "$REPO" worktree remove --force "$B/clankie" 2>/dev/null; rm -rf "$B" ;;
  *) exit 2 ;;
esac
`;

/** The public HTTPS URL of a GitHub origin: the linked machine holds no credentials. */
function publicSource(origin: string): string {
  // A path is cloned as is: a repository on a disk the runner's machine can read.
  if (origin.startsWith("/")) return origin;
  const ssh = /^git@github\.com:([\w.-]+\/[\w.-]+?)(?:\.git)?$/u.exec(origin);
  const https = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/u.exec(origin);
  const path = ssh?.[1] ?? https?.[1];
  if (!path) throw new Error("Remote gates need a GitHub origin the linked machine can clone");
  return `https://github.com/${path}.git`;
}

function wslGateCommand(shell: HerdrSshTransport["shell"], op: string, args: readonly string[]): string {
  const script = Buffer.from(WSL_GATE, "utf8").toString("base64");
  const argv = ["bash", "-c", `eval "$(printf %s ${script} | base64 -d)"`, "clankie-gate", op, ...args];
  // On Windows the program is WSL's launcher; a POSIX machine runs the same script directly.
  return shell === "powershell"
    ? remoteProgramCommand(shell, "wsl", ["-e", ...argv])
    : remoteProgramCommand(shell, argv[0]!, argv.slice(1));
}

function finished(
  child: ChildProcess,
  out?: Writable,
): Promise<{ exitCode: number | null; signal: string | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    if (out) {
      child.stdout?.pipe(out, { end: false });
      child.stderr?.pipe(out, { end: false });
    } else {
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr?.resume();
    }
    child.on("error", reject);
    child.on("close", (exitCode, signal) => resolve({ exitCode, signal, stdout }));
  });
}

export function wslGateRunner(options: {
  readonly machine: string;
  readonly shell: HerdrSshTransport["shell"];
  readonly batch: string;
  readonly origin: string;
  /** A process for one remote command over the fleet's own SSH connection. */
  readonly stream: (remoteCommand: string) => ChildProcess;
  /** `git bundle` of base..head from the local worktree; empty when head is base. */
  readonly bundle: (directory: string, base: string, head: string) => Promise<Buffer>;
}): GateRunner {
  if (!/^[0-9a-f-]{36}$/u.test(options.batch)) throw new Error("Invalid batch ID");
  const call = (op: string, args: readonly string[] = [], out?: Writable, input?: Buffer) => {
    const child = options.stream(wslGateCommand(options.shell, op, [options.batch, ...args]));
    child.stdin?.end(input ?? "");
    return finished(child, out);
  };
  return {
    machine: options.machine,
    async stage(repo) {
      if (![repo.base, repo.head].every((sha) => /^[0-9a-f]{40}$/u.test(sha)))
        throw new Error("Invalid commit");
      const bundle = await options.bundle(repo.directory, repo.base, repo.head);
      const staged = await call(
        "stage",
        [publicSource(options.origin), repo.head],
        undefined,
        Buffer.from(bundle.toString("base64")),
      );
      if (staged.exitCode !== 0) throw new Error(`Could not stage ${repo.head} on ${options.machine}`);
    },
    async run(step, base, out) {
      const { exitCode, signal } = await call(step, step === "gate" ? [base] : [], out);
      return { exitCode, signal };
    },
    async collect(directory) {
      const { exitCode, stdout } = await call("report");
      if (exitCode !== 0) throw new Error(`Could not read the gate report from ${options.machine}`);
      for (const line of stdout.split("\n").filter(Boolean)) {
        const [name, body] = line.split(" ");
        if (!name || body === undefined || !/^landing-gate\.json(\.graph\.json)?$/u.test(name)) continue;
        const target = join(directory, ".local", name);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, Buffer.from(body, "base64"));
      }
    },
    async dispose() {
      await call("dispose");
    },
  };
}

/** Reads a linked machine's room for one more gate; unavailable reads as not ready. */
async function remoteCapacity(
  shell: HerdrSshTransport["shell"],
  stream: (remoteCommand: string) => ChildProcess,
): Promise<RemoteCapacity> {
  const child = stream(wslGateCommand(shell, "capacity", ["00000000-0000-0000-0000-000000000000"]));
  child.stdin?.end();
  const { exitCode, stdout } = await finished(child);
  const parsed = exitCode === 0 ? (JSON.parse(stdout.trim()) as Record<string, number>) : undefined;
  return {
    ready: parsed?.ready === 1,
    loadRatio: parsed?.loadRatio ?? Number.POSITIVE_INFINITY,
    availableMemoryMb: parsed?.availableMemoryMb ?? 0,
    gates: parsed?.gates ?? 0,
  };
}

/** The local heavy picture placement reads: busy slots, a queue, or unhealthy pressure. */
export interface LocalHeavyState {
  readonly capacity: { readonly heavySlots: number; readonly used: number };
  readonly queue: readonly { readonly kind: string }[];
  readonly pressure: { readonly healthy: boolean };
}

/** Extra memory a remote gate keeps above the machine's floor; gates reached about 5 GiB. */
const REMOTE_GATE_MEMORY_MB = 8192;

/**
 * Sends a gate off this machine only when the owner allows it, this machine is
 * saturated, and a linked machine with at least `workers` access answers that
 * it is provisioned, idle of other gates, and under the same load and memory
 * guards. Anything unknown keeps the gate here.
 */
export async function placeRemoteGate(input: {
  readonly batch: { readonly id: string; readonly origin: string };
  readonly settings: ClankieSettings;
  readonly local: LocalHeavyState | undefined;
  readonly fleets: readonly HerdrFleet[];
  readonly stream: (fleet: HerdrFleet) => (remoteCommand: string) => ChildProcess;
  readonly bundle: (directory: string, base: string, head: string) => Promise<Buffer>;
}): Promise<GateRunner | undefined> {
  const { settings, local } = input;
  if (settings.fleet.remoteGates !== "on" || !local) return undefined;
  const saturated =
    local.capacity.used >= local.capacity.heavySlots ||
    local.queue.some((entry) => entry.kind === "heavy") ||
    !local.pressure.healthy;
  if (!saturated) return undefined;
  const policy = FleetResourcePolicySchema.parse(settings.fleet.resources ?? {});
  for (const fleet of input.fleets) {
    const machine = settings.execution.connections.find((entry) => entry.id === fleet.id)?.machine;
    if (!machine || !machineAccessAllows(machineAccessLevel(settings, machine), "workers")) continue;
    const stream = input.stream(fleet);
    const room = await remoteCapacity(fleet.ssh.shell, stream).catch(() => undefined);
    if (
      !room?.ready ||
      room.gates > 0 ||
      room.loadRatio >= policy.maxLoadRatio ||
      room.availableMemoryMb < policy.minAvailableMemoryMb + REMOTE_GATE_MEMORY_MB
    )
      continue;
    return wslGateRunner({
      machine,
      shell: fleet.ssh.shell,
      batch: input.batch.id,
      origin: input.batch.origin,
      stream,
      bundle: input.bundle,
    });
  }
  return undefined;
}

/** base..head of a local worktree as a git bundle; empty when there is nothing past base. */
export async function gitBundle(directory: string, base: string, head: string): Promise<Buffer> {
  if (base === head) return Buffer.alloc(0);
  // A bundle carries refs, so the batch's own clone names HEAD for the trip.
  await execute("git", ["-C", directory, "update-ref", "refs/clankie/gate", head]);
  const { stdout } = await execute(
    "git",
    ["-C", directory, "bundle", "create", "-", "refs/clankie/gate", `^${base}`],
    {
      encoding: "buffer",
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  return stdout;
}

/**
 * Test files a non-macOS gate skipped tests in whose source names darwin: their
 * macOS-only cases never ran there, so that green cannot stand for this Mac's.
 */
export async function darwinOnlySkips(directory: string): Promise<string[]> {
  const report = JSON.parse(
    await readFile(join(directory, ".local", "landing-gate.json"), "utf8").catch(() => "{}"),
  ) as { tests?: { platform?: string; skipped?: unknown } };
  const tests = report.tests;
  // A green gate always records its tests; an old report without them is not trusted.
  if (!tests || !Array.isArray(tests.skipped)) return ["(no recorded test selection)"];
  if (tests.platform === "darwin") return [];
  const named: string[] = [];
  for (const file of tests.skipped)
    if (
      typeof file === "string" &&
      !file.startsWith("../") &&
      /["']darwin["']/u.test(await readFile(join(directory, file), "utf8").catch(() => ""))
    )
      named.push(file);
  return named;
}
