import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import { posixQuote, posixScriptCommand, type HerdrFleet, type FleetShellRun } from "../herdr-fleet.ts";
import { linkSshArgs } from "../fleet-link.ts";
import type { OpenCodeController } from "./opencode-worker-controller.ts";

const execute = promisify(execFile);
const MAX_FRAME = 8 * 1024 * 1024;
const Bootstrap = z
  .object({
    root: z.string().startsWith("/"),
    node: z.string().startsWith("/"),
    stateDir: z.string().startsWith("/"),
  })
  .strict();
type Stream = (command: string) => ChildProcess;

/** Shipped releases include the helper; a checkout builds that same source into private state. */
export async function remoteOpenCodeAssets(repoRoot: string, stateDir: string) {
  const source = "apps/clankie/src/captain/remote-opencode-helper";
  let helper: Buffer;
  try {
    helper = await readFile(join(repoRoot, source + ".js"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const directory = join(stateDir, "opencode-workers", "helper");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const output = join(directory, "remote-helper.mjs");
    await execute(
      join(repoRoot, "node_modules/.bin/esbuild"),
      [
        join(repoRoot, source + ".ts"),
        "--bundle",
        "--platform=node",
        "--format=esm",
        "--target=node24",
        "--minify",
        "--banner:js=import {createRequire} from 'node:module';const require=createRequire(import.meta.url);",
        "--outfile=" + output,
      ],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    helper = await readFile(output);
  }
  const files: Record<string, string> = { "remote-helper.mjs": helper.toString("base64") };
  for (const file of [
    "worker-tui.mjs",
    "worker-runtime.mjs",
    "worker-server.mjs",
    "runtime.mjs",
    "process-birth.py",
  ])
    files[file] = (await readFile(join(repoRoot, "integrations/opencode-plugin", file))).toString("base64");
  const bytes = JSON.stringify(files);
  return {
    hash: createHash("sha256").update(bytes).digest("hex"),
    archive: gzipSync(bytes).toString("base64"),
  };
}

/** Only service-authored files are staged, in an owned private directory on that machine. */
export function remoteOpenCodeBootstrap(
  originId: string,
  assets: Awaited<ReturnType<typeof remoteOpenCodeAssets>>,
) {
  if (!/^[a-f0-9]{32}$/u.test(originId) || !/^[a-f0-9]{64}$/u.test(assets.hash))
    throw new Error("Invalid native asset identity");
  const script = [
    "import os,sys,json,base64,gzip,shutil,stat",
    "if sys.platform != 'darwin': raise ValueError('Mac native control required')",
    "root=os.path.expanduser('~/.clankie/remote-opencode-workers/" + originId + "')",
    "os.makedirs(root,mode=0o700,exist_ok=True)",
    "if os.path.realpath(root)!=root or os.stat(root).st_uid!=os.getuid() or stat.S_IMODE(os.stat(root).st_mode)&0o077: raise ValueError('Private root required')",
    "assets=os.path.join(root,'assets-" + assets.hash + "')",
    "os.makedirs(assets,mode=0o700,exist_ok=True)",
    "if os.path.realpath(assets)!=assets or os.stat(assets).st_uid!=os.getuid() or stat.S_IMODE(os.stat(assets).st_mode)&0o077: raise ValueError('Private assets required')",
    "files=json.loads(gzip.decompress(base64.b64decode(" + JSON.stringify(assets.archive) + ")))",
    "for name,data in files.items():",
    " path=os.path.join(assets,name)",
    " if '/' in name or name.startswith('.'): raise ValueError('Invalid asset')",
    " content=base64.b64decode(data)",
    " try:",
    "  fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)",
    "  with os.fdopen(fd,'wb') as target: target.write(content)",
    " except FileExistsError:",
    "  fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)",
    "  with os.fdopen(fd,'rb') as existing:",
    "   facts=os.fstat(existing.fileno())",
    "   if facts.st_uid!=os.getuid() or facts.st_nlink!=1 or not stat.S_ISREG(facts.st_mode) or existing.read()!=content: raise ValueError('Asset changed')",
    "node=os.path.realpath(shutil.which('node') or '')",
    "if not os.path.isfile(node): raise ValueError('Node unavailable')",
    "print(json.dumps({'root':assets,'node':node,'stateDir':root}))",
  ].join("\n");
  return posixScriptCommand("exec /usr/bin/python3 -I -c " + posixQuote(script));
}

/** One SSH process and one helper generation; dropped replies never reconnect or replay. */
export class RemoteOpenCodeRpc {
  private readonly pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  private open = true;
  private text = "";
  private readonly child: ChildProcess;
  private readonly guard: () => Promise<void>;
  constructor(child: ChildProcess, guard: () => Promise<void>) {
    this.child = child;
    this.guard = guard;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      this.text += chunk;
      if (Buffer.byteLength(this.text) > MAX_FRAME) return this.close();
      for (;;) {
        const newline = this.text.indexOf("\n");
        if (newline < 0) return;
        const line = this.text.slice(0, newline);
        this.text = this.text.slice(newline + 1);
        try {
          const frame = z
            .object({ id: z.string().uuid(), result: z.unknown().optional(), error: z.string().optional() })
            .parse(JSON.parse(line));
          const waiter = this.pending.get(frame.id);
          if (!waiter) {
            this.close();
            return;
          }
          clearTimeout(waiter.timer);
          this.pending.delete(frame.id);
          if (frame.error) waiter.reject(new Error("Remote native OpenCode operation unavailable"));
          else waiter.resolve(frame.result);
        } catch {
          this.close();
          return;
        }
      }
    });
    child.stderr?.on("data", () => {}); // Remote diagnostics never enter the operator prompt.
    child.once("exit", () => this.close());
    child.once("error", () => this.close());
  }
  async request(method: string, input: unknown = null, timeoutMs = 20_000): Promise<unknown> {
    await this.guard();
    if (!this.open || !this.child.stdin || this.child.stdin.destroyed)
      throw new Error("Original remote native helper unavailable");
    const id = randomUUID();
    const frame = JSON.stringify({ id, method, input }) + "\n";
    if (Buffer.byteLength(frame) > MAX_FRAME) throw new Error("Remote native request exceeds bound");
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => this.close(), timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin!.write(frame, (error) => {
        if (error) this.close();
      });
    });
    await this.guard();
    if (!this.open) throw new Error("Original remote native helper disconnected");
    return result;
  }
  close() {
    if (!this.open) return;
    this.open = false;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Remote native reply unavailable; no automatic retry"));
    }
    this.pending.clear();
    this.child.kill("SIGTERM"); // Only this service-created helper transport.
  }
}

export async function startRemoteOpenCodeRpc(options: {
  fleet: HerdrFleet;
  shell: FleetShellRun;
  stream: Stream;
  guard(): Promise<void>;
  originId: string;
  assets: Awaited<ReturnType<typeof remoteOpenCodeAssets>>;
}) {
  if (options.fleet.ssh.shell !== "posix")
    throw new Error("Remote OpenCode currently requires a Mac POSIX fleet");
  await options.guard();
  const boot = Bootstrap.parse(
    JSON.parse(await options.shell(remoteOpenCodeBootstrap(options.originId, options.assets))),
  );
  await options.guard();
  const child = options.stream(
    posixScriptCommand(
      "exec " + posixQuote(boot.node) + " " + posixQuote(join(boot.root, "remote-helper.mjs")),
    ),
  );
  const rpc = new RemoteOpenCodeRpc(child, options.guard);
  try {
    const initialized = z
      .object({ uid: z.number().int().nonnegative(), platform: z.literal("darwin"), binding: z.unknown() })
      .parse(await rpc.request("initialize", { stateDir: boot.stateDir, session: options.fleet.session }));
    return { ...boot, rpc, uid: initialized.uid };
  } catch (error) {
    rpc.close();
    throw error;
  }
}

/** Same private loopback forwarding pattern as the fleet link; no reconnect after loss. */
export async function openRemoteOpenCodeTunnel(options: {
  fleet: HerdrFleet;
  controller: OpenCodeController;
  guard(): Promise<void>;
  spawn?: typeof spawn;
  timeoutMs?: number;
}) {
  await options.guard();
  const localPort = Number(new URL(options.controller.endpoint).port);
  const child = (options.spawn ?? spawn)("ssh", linkSshArgs(options.fleet, localPort), {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let alive = true;
  const close = () => {
    if (alive) {
      alive = false;
      child.kill("SIGTERM");
    }
  };
  const lost = () => {
    close();
    void options.controller.close().catch(() => {});
  };
  child.once("exit", lost);
  child.once("error", lost);
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let stderr = "";
      const timer = setTimeout(
        () => reject(new Error("Remote native forward unavailable")),
        options.timeoutMs ?? 20_000,
      );
      const fail = () => {
        clearTimeout(timer);
        reject(new Error("Remote native forward disconnected"));
      };
      child.once("exit", fail);
      child.once("error", fail);
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-4096);
        const match = /Allocated port (\d+) for remote forward/u.exec(stderr);
        if (!match) return;
        const value = Number(match[1]);
        if (!Number.isSafeInteger(value) || value < 1 || value > 65535) return fail();
        clearTimeout(timer);
        child.removeListener("exit", fail);
        child.removeListener("error", fail);
        resolve(value);
      });
    });
    await options.guard();
    if (!alive || !child.pid) throw new Error("Original remote forward unavailable");
    return { port, pid: child.pid, alive: () => alive, close };
  } catch (error) {
    close();
    throw error;
  }
}
