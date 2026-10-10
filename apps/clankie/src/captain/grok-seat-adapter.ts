import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type {
  HarnessSeatAdapter,
  PreparedSeatLaunch,
  SeatControl,
  SeatLaunch,
  SeatRef,
} from "@clankie/agent-hosts";
import { bundledSkills } from "@clankie/settings";
import { MAXIMUM_TRUST_HARNESS_ARGS } from "@clankie/protocol";
import {
  connectGrokNative,
  GROK_NATIVE_VERSION,
  type GrokNativeController,
} from "./grok-native-controller.ts";
import type { GrokNativeHost } from "./grok-native-host.ts";
import type { PreparedNativeRoot } from "./prepared-native-host.ts";

const exec = promisify(execFile);
export async function grokTuiOwnsSession(input: {
  home: string;
  pid: number;
  sessionId: string;
  cwd: string;
}) {
  const records: unknown = await readFile(join(input.home, "active_sessions.json"), "utf8")
    .then(JSON.parse)
    .catch(() => []);
  return (
    Array.isArray(records) &&
    records.some(
      (record) =>
        record?.pid === input.pid && record.session_id === input.sessionId && record.cwd === input.cwd,
    )
  );
}
/** Native TUI's readiness report, checked alongside original kernel lifetime proof. */
export async function waitForGrokTuiSession(input: {
  home: string;
  pid: number;
  sessionId: string;
  cwd: string;
  guard(): Promise<void>;
}) {
  const deadline = Date.now() + 20_000;
  while (true) {
    await input.guard();
    if (await grokTuiOwnsSession(input)) {
      await input.guard();
      return;
    }
    if (Date.now() >= deadline)
      throw new Error("Original Grok TUI has not confirmed its session; no attach or brief");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
export async function discoverGrok(env: NodeJS.ProcessEnv = process.env) {
  if (process.platform !== "darwin")
    throw new Error("Native Grok control is currently verified on macOS only");
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    let executable: string;
    try {
      executable = await realpath(join(directory, "grok"));
      await access(executable, constants.X_OK);
    } catch {
      continue;
    }
    const result = await exec(executable, ["--version"], { env, timeout: 5000, maxBuffer: 4096 });
    if (!result.stdout.trim().startsWith(`grok ${GROK_NATIVE_VERSION} (`))
      throw new Error(`Grok native control requires verified ${GROK_NATIVE_VERSION}; no fallback`);
    // Preserve the harness entry point so Herdr recognizes `grok`; the native
    // process proof still compares its canonical executable, including versioned symlinks.
    return join(directory, "grok");
  }
  throw new Error("Grok Build is unavailable; install and sign in to Grok yourself before hiring");
}
function grokSkillContext(repoRoot: string) {
  return bundledSkills(repoRoot)
    .map((skill) => `${skill.name}: ${join(skill.path, "SKILL.md")}`)
    .join("\n");
}
export function createGrokSeatAdapter(options: {
  repoRoot: string;
  stateDir: string;
  native: GrokNativeHost;
  processHelper: string;
}): HarnessSeatAdapter {
  const controls = new Map<string, SeatControl>();
  return {
    harness: "grok",
    async start() {
      return {
        outcome: "failed",
        reason: "harness_unavailable",
        detail: "Grok needs an initial native argv pane; no terminal launch fallback",
      };
    },
    async attach(ref) {
      const control = controls.get(ref.sessionId);
      return ref.harness === "grok" &&
        control?.ref.paneId === ref.paneId &&
        (await control.status()) !== "offline"
        ? control
        : undefined;
    },
    async prepare(launch: SeatLaunch, signal): Promise<PreparedSeatLaunch> {
      signal?.throwIfAborted();
      const rules =
        launch.harnessArgs?.length === 2 && launch.harnessArgs[0] === "--rules"
          ? launch.harnessArgs[1]
          : undefined;
      if (
        launch.harness !== "grok" ||
        launch.resumeSessionId ||
        (launch.harnessArgs?.length && rules === undefined)
      )
        throw new Error(
          "Grok saved-history resume or extra argv lacks original controller proof; use the existing live seat",
        );
      const env = { ...process.env, ...launch.env };
      const executable = await discoverGrok(env);
      const cwd = await realpath(launch.cwd);
      const directory = await realpath(await mkdtemp(join(tmpdir(), "clankie-grok-")));
      const sessionId = randomUUID();
      const socketPath = join(directory, "leader.sock");
      await mkdir(join(options.stateDir, "grok-workers"), { recursive: true, mode: 0o700 });
      let native: GrokNativeController | undefined;
      let root: PreparedNativeRoot | undefined;
      let ref: SeatRef | undefined;
      let started = false,
        disposed = false;
      let unregister: (() => void) | undefined;
      let lifecycle: ReturnType<typeof setInterval> | undefined;
      const descriptor = { source: "herdr:grok" as const, kind: "id" as const, value: sessionId };
      const dispose = async () => {
        disposed = true;
        unregister?.();
        controls.delete(sessionId);
        await native?.close();
      };
      const verify = async (expected: SeatRef) => {
        if (disposed || !root || !native || !ref || JSON.stringify(ref) !== JSON.stringify(expected))
          throw new Error("Original Grok controller unavailable");
        await native.verify();
        return root.proof(descriptor);
      };
      return {
        command: [
          executable,
          "--leader",
          "--leader-socket",
          socketPath,
          "--session-id",
          sessionId,
          "--cwd",
          cwd,
          "--rules",
          `You are a worker hired by Clankie. Send questions and final reports through message_clankie. Connected tools are available through clankie_tools and clankie_call. ${rules ?? `Load relevant skills from these paths:\n${grokSkillContext(options.repoRoot)}`}`,
          ...(launch.model ? ["--model", launch.model] : []),
          ...(launch.effort ? ["--reasoning-effort", launch.effort] : []),
          ...(launch.maximumTrust === true ? MAXIMUM_TRUST_HARNESS_ARGS.grok : []),
        ],
        ...(launch.env ? { env: launch.env } : {}),
        dispose,
        verify,
        async start(view, startSignal) {
          if (started || disposed)
            return {
              outcome: "failed",
              reason: "not_ready",
              detail: "Original Grok allocation already used; no duplicate launch",
            };
          started = true;
          try {
            signal?.throwIfAborted();
            startSignal?.throwIfAborted();
            await view.guard?.();
            root = await options.native.capture(view.paneId, executable, cwd);
            await waitForGrokTuiSession({
              home: env.GROK_HOME ?? join(env.HOME!, ".grok"),
              pid: root.process.pid,
              sessionId,
              cwd,
              guard: () => root!.verifyAllocation(),
            });
            const originalPid = root.process.pid;
            lifecycle = setInterval(() => {
              try {
                process.kill(originalPid, 0);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ESRCH") {
                  clearInterval(lifecycle);
                  void native?.stopOwnedLeader().catch(() => {});
                  void dispose();
                }
              }
            }, 5000);
            lifecycle.unref();
            native = await connectGrokNative({
              executable,
              cwd,
              socketPath,
              sessionId,
              processHelper: options.processHelper,
              receiptsPath: join(options.stateDir, "grok-workers", `${sessionId}.json`),
              guard: async () => {
                signal?.throwIfAborted();
                startSignal?.throwIfAborted();
                if (disposed) throw new Error("Grok controller retired");
                await root!.verifyAllocation();
                if (
                  !(await grokTuiOwnsSession({
                    home: env.GROK_HOME ?? join(env.HOME!, ".grok"),
                    pid: originalPid,
                    sessionId,
                    cwd,
                  }))
                )
                  throw new Error("Original Grok visible session changed");
                await view.guard?.();
              },
            });
            await native.load({
              mcpServers: [{ name: "clankie", command: "clankie", args: ["mcp", "--fleet"], env: [] }],
              ...(launch.model ? { model: launch.model } : {}),
              ...(launch.effort ? { effort: launch.effort } : {}),
            });
            ref = { harness: "grok", paneId: view.paneId, sessionId };
            await root.report(descriptor, "idle", view.name);
            unregister = options.native.register(ref, root, native);
            await native.waitTools("clankie", ["clankie_tools", "clankie_call", "message_clankie"]);
            await view.bound?.(ref);
            await verify(ref);
            const selected = ref,
              controller = native;
            const control: SeatControl = {
              ref: selected,
              verify: () => verify(selected),
              async status() {
                try {
                  await verify(selected);
                  const status = controller.status();
                  if (["idle", "working", "blocked"].includes(status))
                    await root!.report(descriptor, status as "idle" | "working" | "blocked");
                  return status;
                } catch {
                  return "offline";
                }
              },
              async send(text, input) {
                try {
                  await verify(selected);
                  return await controller.send(text, input?.beforeDispatch, input?.timeoutMs);
                } catch {
                  return {
                    outcome: "offline",
                    detail: "Original Grok control unavailable; no new dispatch",
                    deliveryStage: "unavailable",
                  };
                }
              },
              settled: (abort) => controller.settled(abort),
              async interrupt() {
                try {
                  await verify(selected);
                  return await controller.interrupt();
                } catch {
                  return false;
                }
              },
              close: dispose,
            };
            controls.set(sessionId, control);
            if (launch.brief && (await control.send(launch.brief)).outcome !== "accepted")
              throw new Error("brief_delivery_unverified");
            return { outcome: "started", control };
          } catch (error) {
            await dispose();
            return {
              outcome: "failed",
              reason: "not_ready",
              detail: `Grok native binding or brief unconfirmed: ${error instanceof Error ? error.message : String(error)}. Inspect the original pane before retrying; no fallback was started.`,
            };
          }
        },
      };
    },
  };
}
