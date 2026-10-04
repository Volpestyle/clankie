import { OpenCodeProfiles } from "../opencode-profiles.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import type {
  HarnessSeatAdapter,
  PreparedSeatLaunch,
  SeatControl,
  SeatEvent,
  SeatLaunch,
  SeatRef,
  SeatStatus,
  SeatView,
} from "@clankie/agent-hosts";
import { z } from "zod";
import { createOpenCodeController, type OpenCodeController } from "./opencode-worker-controller.ts";
import type { createOpenCodeNativeHost, OpenCodeNativeRoot } from "./opencode-native-host.ts";
import { DeliveryFence } from "./delivery-fence.ts";

const OPENCODE_WORKER_VERSION = "1.18.18";
const exec = promisify(execFile);
const Session = z.object({
  sessionId: z.string().regex(/^ses_[A-Za-z0-9]{8,128}$/u),
  version: z.literal(OPENCODE_WORKER_VERSION),
});
const Status = z.enum(["idle", "working", "blocked"]);
const Delivery = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("accepted"), messageId: z.string(), state: z.literal("queued") }),
  z.object({ outcome: z.literal("unconfirmed"), messageId: z.string(), detail: z.string() }),
  z.object({ outcome: z.literal("unavailable"), detail: z.string() }),
]);
export interface OpenCodeSeatDeps {
  readonly repoRoot: string;
  readonly stateDir: string;
  readonly native: ReturnType<typeof createOpenCodeNativeHost>;
  readonly discover?: (launch: SeatLaunch) => Promise<{ executable: string; version: string }>;
  readonly controller?: typeof createOpenCodeController;
  readonly timeoutMs?: number;
}

/** --version imports native modules with filesystem initialization; isolate all paths. */
export async function probeOpenCodeVersion(
  executable: string,
  run: (
    file: string,
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv; cwd: string; timeout: number; maxBuffer: number },
  ) => Promise<{ stdout: string }> = (file, args, options) => exec(file, [...args], options),
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clankie-opencode-version-"));
  try {
    const result = await run(executable, ["--version"], {
      cwd: directory,
      timeout: 5_000,
      maxBuffer: 4096,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: directory,
        TMPDIR: directory,
        XDG_DATA_HOME: join(directory, "data"),
        XDG_CONFIG_HOME: join(directory, "config"),
        XDG_CACHE_HOME: join(directory, "cache"),
        XDG_STATE_HOME: join(directory, "state"),
        OPENCODE_DB: join(directory, "version.db"),
        OPENCODE_CONFIG_DIR: join(directory, "config"),
        OPENCODE_CONFIG_CONTENT: "{}",
        OPENCODE_PURE: "1",
      },
    });
    const version = result.stdout.trim();
    if (version !== OPENCODE_WORKER_VERSION) throw new Error("Unsupported native OpenCode version");
    return version;
  } catch {
    throw new Error(
      `Native OpenCode worker requires exactly ${OPENCODE_WORKER_VERSION}; isolated version check unavailable`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function discover(launch: SeatLaunch): Promise<{ executable: string; version: string }> {
  if (process.platform !== "darwin") throw new Error("Native OpenCode workers currently require macOS");
  const env = { ...process.env, ...launch.env };
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    let executable: string;
    try {
      executable = await realpath(join(directory, "opencode"));
      await access(executable, constants.X_OK);
    } catch {
      continue;
    }
    const handle = await open(executable, "r");
    const bytes = Buffer.alloc(2);
    try {
      await handle.read(bytes, 0, 2, 0);
    } finally {
      await handle.close();
    }
    const header = bytes.toString();
    if (header === "#!")
      throw new Error("OpenCode native executable is required; script launchers are not proven");
    const version = await probeOpenCodeVersion(executable);
    return { executable, version };
  }
  throw new Error("Native OpenCode executable unavailable");
}

/** The one native TUI owns the SDK; there is no headless server or second writer. */
export function createOpenCodeSeatAdapter(deps: OpenCodeSeatDeps): HarnessSeatAdapter {
  const controls = new Map<string, SeatControl>();
  const profiles = new OpenCodeProfiles(deps.stateDir);
  const fence = new DeliveryFence(join(deps.stateDir, "opencode-workers", "receipts.json"));
  return {
    harness: "opencode",
    async start() {
      return {
        outcome: "failed",
        reason: "harness_unavailable",
        detail: "OpenCode requires an initial native argv pane; no terminal launch fallback",
      };
    },
    async attach(ref) {
      const control = controls.get(ref.sessionId);
      if (ref.harness !== "opencode" || control?.ref.paneId !== ref.paneId) return undefined;
      return (await control.status()) === "offline" ? undefined : control;
    },
    async prepare(launch, signal): Promise<PreparedSeatLaunch> {
      signal?.throwIfAborted();
      if (launch.harness !== "opencode" || (launch.harnessArgs?.length ?? 0) > 0)
        throw new Error("Unsupported OpenCode launch arguments");
      if (launch.model !== undefined && !/^[^/\s]+\/\S+$/u.test(launch.model))
        throw new Error("OpenCode model must be provider/model");
      if (launch.effort !== undefined && launch.model === undefined)
        throw new Error("OpenCode variant requires an explicit model");
      if (launch.resumeSessionId !== undefined && !/^ses_[A-Za-z0-9]{8,128}$/u.test(launch.resumeSessionId))
        throw new Error("Invalid exact OpenCode resume session");
      if (launch.resumeSessionId !== undefined)
        throw new Error(
          "OpenCode resume unavailable: original native exit is unproven; use the existing live controller",
        );
      const selected = await (deps.discover ?? discover)(launch);
      if (selected.version !== OPENCODE_WORKER_VERSION || !isAbsolute(selected.executable))
        throw new Error("Native OpenCode capability unavailable");
      signal?.throwIfAborted();
      const launchRoot = join(deps.stateDir, "opencode-workers");
      await mkdir(launchRoot, { recursive: true, mode: 0o700 });
      // Native-owned persistent history survives uncertain creation and controller retirement.
      const profile = await profiles.allocate();
      const directory = await mkdtemp(join(launchRoot, "launch-"));
      let controller: OpenCodeController | undefined;
      let root: OpenCodeNativeRoot | undefined;
      let ref: SeatRef | undefined;
      let view: SeatView | undefined;
      let started = false;
      let disposed = false;
      let ownedControl: SeatControl | undefined;
      let cleanup: Promise<void> | undefined;
      let disposal: Promise<void> | undefined;
      const onAbort = () => {
        void dispose().catch(() => {});
      };
      const retireConfig = () => {
        if (cleanup) return cleanup;
        disposed = true;
        signal?.removeEventListener("abort", onAbort);
        if (ref && controls.get(ref.sessionId) === ownedControl) controls.delete(ref.sessionId);
        cleanup = rm(directory, { recursive: true, force: true });
        return cleanup;
      };
      const dispose = () =>
        (disposal ??= (async () => {
          try {
            await controller?.close();
          } finally {
            await retireConfig();
          }
        })());
      try {
        controller = await (deps.controller ?? createOpenCodeController)({
          receiptsPath: join(launchRoot, "receipts.json"),
          fence,
          onRetire: retireConfig,
          ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
        });
        const env = { ...process.env, ...launch.env };
        const baseConfig = z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(env.OPENCODE_CONFIG_CONTENT || "{}"));
        const plugins = z.array(z.unknown()).parse(baseConfig.plugin ?? []);
        const baseTui = env.OPENCODE_TUI_CONFIG
          ? z
              .record(z.string(), z.unknown())
              .parse(JSON.parse(await readFile(env.OPENCODE_TUI_CONFIG, "utf8")))
          : {};
        const tuiPlugins = z.array(z.unknown()).parse(baseTui.plugin ?? []);
        const pluginRoot = join(deps.repoRoot, "integrations/opencode-plugin");
        const tuiPath = join(directory, "tui.json");
        await writeFile(
          tuiPath,
          JSON.stringify({
            ...baseTui,
            plugin: [
              ...tuiPlugins,
              [
                pathToFileURL(join(pluginRoot, "worker-tui.mjs")).href,
                { endpoint: controller.endpoint, token: controller.token },
              ],
            ],
          }),
          { mode: 0o600 },
        );
        const scopedEnv: Record<string, string> = {
          ...launch.env,
          OPENCODE_TUI_CONFIG: tuiPath,
          OPENCODE_DB: profile.database,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            ...baseConfig,
            autoupdate: false,
            plugin: [...plugins, pathToFileURL(join(pluginRoot, "worker-server.mjs")).href],
          }),
          OPENCODE_ROUTE: "",
          OPENCODE_FAST_BOOT: "",
        };
        const native = controller;
        const verify = async (expected: SeatRef) => {
          if (
            disposed ||
            !root ||
            !ref ||
            !view ||
            expected.harness !== "opencode" ||
            expected.sessionId !== ref.sessionId ||
            expected.paneId !== ref.paneId
          )
            throw new Error("Original OpenCode controller/ref unavailable");
          try {
            await native.request("status");
            await view.guard?.();
            const proof = await root.proof(ref.sessionId);
            await native.request("status");
            return proof;
          } catch (error) {
            await dispose().catch(() => {});
            throw error;
          }
        };
        signal?.throwIfAborted();
        signal?.addEventListener("abort", onAbort, { once: true });
        return {
          command: [
            selected.executable,
            launch.cwd,
            ...(launch.resumeSessionId ? ["--session", launch.resumeSessionId] : []),
            ...(launch.model ? ["--model", launch.model] : []),
          ],
          env: scopedEnv,
          dispose,
          verify,
          async start(allocated, startSignal) {
            if (started || disposed)
              return {
                outcome: "failed",
                reason: "not_ready",
                detail: "Original OpenCode launch already used or retired; no duplicate launch",
              };
            started = true;
            view = allocated;
            try {
              signal?.throwIfAborted();
              startSignal?.throwIfAborted();
              await view.guard?.();
              root = await deps.native.capture(view.paneId, selected.executable, launch.cwd);
              native.bind(
                (socket) => root!.check(socket),
                async () => {
                  signal?.throwIfAborted();
                  startSignal?.throwIfAborted();
                  await view!.guard?.();
                },
              );
              const initialized = Session.parse(
                await native.request(
                  "initialize",
                  {
                    cwd: await realpath(launch.cwd),
                    title: view.name ?? "Clankie worker",
                    resumeSessionId: launch.resumeSessionId,
                    model: launch.model,
                    effort: launch.effort,
                  },
                  deps.timeoutMs ?? 20_000,
                ),
              );
              if (launch.resumeSessionId !== undefined && initialized.sessionId !== launch.resumeSessionId)
                throw new Error("Exact resume mismatch");
              ref = { harness: "opencode", paneId: view.paneId, sessionId: initialized.sessionId };
              native.select(ref.sessionId);
              await root.report(ref.sessionId, "idle");
              // The plugin initializer has now returned; wait only for native
              // synchronization, never issue a bootstrap model prompt.
              const deadline = Date.now() + (deps.timeoutMs ?? 20_000);
              while (true) {
                try {
                  Status.parse(await native.request("status"));
                  break;
                } catch {
                  if (Date.now() >= deadline) throw new Error("Native TUI readiness unavailable");
                  await new Promise((resolve) => setTimeout(resolve, 100));
                }
              }
              await view.bound?.(ref);
              await verify(ref);
              await profiles.register(profile, ref.sessionId, launch.cwd, () => verify(ref!));
              await verify(ref);
              const selectedRef = ref;
              let lastMessageId: string | undefined;
              const control: SeatControl = {
                ref: selectedRef,
                verify: () => verify(selectedRef),
                async status(): Promise<SeatStatus> {
                  try {
                    const state = Status.parse(await native.request("status"));
                    await root!.report(selectedRef.sessionId, state);
                    return state;
                  } catch {
                    await dispose().catch(() => {});
                    return "offline";
                  }
                },
                async send(text, options) {
                  const uncertain = native.pending();
                  if (uncertain)
                    return {
                      outcome: "unconfirmed",
                      messageId: uncertain.messageId,
                      detail: "Original native delivery remains uncertain; no resend",
                      deliveryStage: "uncertain",
                    };
                  const messageId = `msg_${randomUUID().replaceAll("-", "")}`;
                  let attempted = false;
                  try {
                    await verify(selectedRef);
                    attempted = true;
                    const result = Delivery.parse(
                      await native.request("send", { messageId, text }, options?.timeoutMs),
                    );
                    if (result.outcome === "unavailable")
                      return { outcome: "offline", detail: result.detail, deliveryStage: "unavailable" };
                    if (result.messageId !== messageId) throw new Error("Native receipt mismatch");
                    lastMessageId = messageId;
                    if (result.outcome === "accepted") {
                      await verify(selectedRef);
                      await native.acknowledge(messageId);
                    }
                    return {
                      ...result,
                      deliveryStage: result.outcome === "accepted" ? "consumed" : "uncertain",
                    };
                  } catch {
                    if (!attempted)
                      return {
                        outcome: "offline",
                        detail: "Original native control unavailable before dispatch",
                        deliveryStage: "unavailable",
                      };
                    return {
                      outcome: "unconfirmed",
                      messageId,
                      detail: "Native delivery not confirmed; inspect original session before retrying",
                      deliveryStage: "uncertain",
                    };
                  }
                },
                async settled(abort): Promise<SeatEvent> {
                  while (true) {
                    abort?.throwIfAborted();
                    const state = await control.status();
                    const at = new Date().toISOString();
                    if (state === "offline") return { type: "released", at };
                    if (state === "blocked")
                      return {
                        type: "blocked",
                        at,
                        reason: "Native permission or question requires the owner",
                      };
                    if (state === "idle") {
                      const result = z
                        .discriminatedUnion("state", [
                          z.object({ state: z.literal("pending") }),
                          z.object({
                            state: z.literal("completed"),
                            ok: z.boolean(),
                            text: z.string(),
                            stopReason: z.string().optional(),
                          }),
                        ])
                        .parse(await native.request("settlement", { messageId: lastMessageId }));
                      if (result.state === "completed")
                        return {
                          type: "turn_completed",
                          at,
                          ok: result.ok,
                          text: result.text,
                          ...(result.stopReason === undefined ? {} : { stopReason: result.stopReason }),
                        };
                    }
                    await new Promise((resolve) => setTimeout(resolve, 250));
                  }
                },
                async interrupt() {
                  try {
                    await verify(selectedRef);
                    return (await native.request("interrupt")) === true;
                  } catch {
                    return false;
                  }
                },
                close: dispose,
              };
              if (disposed) throw new Error("Native controller retired during binding");
              ownedControl = control;
              controls.set(ref.sessionId, control);
              if (launch.brief) {
                const delivery = await control.send(launch.brief);
                if (delivery.outcome !== "accepted")
                  throw new Error(
                    "brief_delivery_unverified: native worker did not confirm the brief; no retry",
                  );
              }
              return { outcome: "started", control };
            } catch {
              await dispose();
              return {
                outcome: "failed",
                reason: "not_ready",
                detail:
                  "Native OpenCode binding or brief unconfirmed; inspect the original pane before retrying. No fallback or duplicate native process was launched.",
              };
            }
          },
        };
      } catch (error) {
        await dispose();
        throw error;
      }
    },
  };
}
