import { OpenCodeProfiles, type OpenCodeWorkerProfile } from "../opencode-profiles.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { access, cp, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomInt, randomUUID } from "node:crypto";
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
import {
  createOpenCodeController,
  OpenCodeCapabilityError,
  type OpenCodeController,
} from "./opencode-worker-controller.ts";
import type { createOpenCodeNativeHost, OpenCodeNativeRoot } from "./opencode-native-host.ts";
import { DeliveryFence } from "./delivery-fence.ts";
import { OPENCODE_WORKER_FLOOR } from "../opencode-history.ts";
import { admitNativeRelease } from "./native-release.ts";

const exec = promisify(execFile);
const Session = z.object({
  sessionId: z.string().regex(/^ses_[A-Za-z0-9]{8,128}$/u),
  version: z.string().max(64),
});
const Status = z.enum(["idle", "working", "blocked"]);
const CatalogRefresh = z.object({
  outcome: z.enum(["refreshed", "skipped-busy", "failed"]),
  reason: z.enum([
    "native-action-pending",
    "native-session-busy",
    "native-mcp-refresh-unsupported",
    "native-mcp-refresh-unconfirmed",
    "original-native-clankie-connection-observed",
    "original-native-control-unavailable",
  ]),
});
const Delivery = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("accepted"),
    messageId: z.string(),
    state: z.enum(["queued", "started", "steered"]),
  }),
  z.object({ outcome: z.literal("unconfirmed"), messageId: z.string(), detail: z.string() }),
  z.object({ outcome: z.literal("unavailable"), detail: z.string() }),
]);
/**
 * Oldest OpenCode 2 release a worker is admitted on. V1 plugins do not run in
 * V2, so a V2 install takes the V2 worker plugin and its private server
 * (ADR 0333). The floor covers what the surface probe cannot see: setup
 * awaited before the TUI mounts a route, idempotent inbox admission by client
 * id, and the idle marker that ends a turn. Verified on 2.2.5.
 */
export const OPENCODE_V2_WORKER_FLOOR = "2.2.5";

/** OpenCode 1 prints `1.19.3`; OpenCode 2 prints `opencode v2.2.5`. */
function openCodeRelease(output: string): string {
  return /^opencode v(\d{1,6}\.\d{1,6}\.\d{1,6})$/u.exec(output)?.[1] ?? output;
}

/** The plugin generation an installed release runs: 2 for OpenCode 2 and newer. */
function openCodeGeneration(version: string): 1 | 2 {
  return Number(/^(\d+)\./u.exec(version)?.[1] ?? 0) >= 2 ? 2 : 1;
}

/** Admit a found release against the floor of its own plugin generation. */
function admitOpenCodeRelease(version: string): string {
  return admitNativeRelease(
    "Native OpenCode",
    version,
    openCodeGeneration(version) === 2 ? OPENCODE_V2_WORKER_FLOOR : OPENCODE_WORKER_FLOOR,
  );
}

/** A V2 message id in OpenCode's own ascending form, so admission order and id order agree. */
function openCode2MessageId(): string {
  const time = (BigInt(Date.now()) * 0x1000n + BigInt(randomInt(0x1000))).toString(16).padStart(12, "0");
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  return `msg_${time.slice(-12)}${Array.from({ length: 14 }, () => chars[randomInt(62)]).join("")}`;
}

export interface OpenCodeSeatDeps {
  readonly repoRoot: string;
  readonly stateDir: string;
  readonly native: ReturnType<typeof createOpenCodeNativeHost>;
  readonly discover?: (launch: SeatLaunch) => Promise<{ executable: string; version: string }>;
  readonly controller?: typeof createOpenCodeController;
  readonly timeoutMs?: number;
  readonly profiles?: Pick<OpenCodeProfiles, "allocate" | "register">;
  readonly configure?: (
    launch: SeatLaunch,
    profile: OpenCodeWorkerProfile,
    controller: OpenCodeController,
    directory: string,
  ) => Promise<{ env: Record<string, string>; cwd: string; retire(): Promise<void> }>;
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
  let version: string;
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
    version = openCodeRelease(result.stdout.trim());
  } catch {
    throw new Error("Native OpenCode isolated version check unavailable; no worker launched");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return admitOpenCodeRelease(version);
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

async function configureLocal(
  deps: OpenCodeSeatDeps,
  launch: SeatLaunch,
  profile: OpenCodeWorkerProfile,
  controller: OpenCodeController,
  directory: string,
) {
  const env = { ...process.env, ...launch.env };
  const baseConfig = z.record(z.string(), z.unknown()).parse(JSON.parse(env.OPENCODE_CONFIG_CONTENT || "{}"));
  const plugins = z.array(z.unknown()).parse(baseConfig.plugin ?? []);
  const baseTui = env.OPENCODE_TUI_CONFIG
    ? z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(env.OPENCODE_TUI_CONFIG, "utf8")))
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
  return { env: scopedEnv, cwd: await realpath(launch.cwd), retire: async () => {} };
}

/**
 * OpenCode 2: the TUI runs `--standalone`, so its server is a private child
 * whose lease ends with the TUI, not the owner's shared background service
 * (ADR 0333). Per-launch plugins reach the TUI through
 * `OPENCODE_CLI_CONFIG_CONTENT` and its private server through
 * `OPENCODE_CONFIG_CONTENT`; both are copied into the launch directory so a
 * checkout edit cannot hot-reload a running worker. The owner's database stays
 * in place, because OpenCode 2 keeps provider credentials there.
 */
async function configureLocalV2(
  deps: OpenCodeSeatDeps,
  launch: SeatLaunch,
  controller: OpenCodeController,
  directory: string,
) {
  const env = { ...process.env, ...launch.env };
  const baseConfig = z.record(z.string(), z.unknown()).parse(JSON.parse(env.OPENCODE_CONFIG_CONTENT || "{}"));
  const baseCli = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(env.OPENCODE_CLI_CONFIG_CONTENT || "{}"));
  const plugins = z.array(z.unknown()).parse(baseConfig.plugins ?? []);
  const cliPlugins = z.array(z.unknown()).parse(baseCli.plugins ?? []);
  const pluginRoot = join(directory, "opencode2");
  await cp(join(deps.repoRoot, "integrations/opencode-plugin/v2"), pluginRoot, { recursive: true });
  const scopedEnv: Record<string, string> = {
    ...launch.env,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({
      ...baseCli,
      plugins: [
        ...cliPlugins,
        {
          package: join(pluginRoot, "worker-tui"),
          options: { endpoint: controller.endpoint, token: controller.token },
        },
      ],
    }),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...baseConfig,
      plugins: [...plugins, join(pluginRoot, "worker-server")],
    }),
  };
  return { env: scopedEnv, cwd: await realpath(launch.cwd), retire: async () => {} };
}

/** The one native TUI owns the SDK; there is no headless server or second writer. */
export function createOpenCodeSeatAdapter(deps: OpenCodeSeatDeps): HarnessSeatAdapter {
  const controls = new Map<string, SeatControl>();
  const profiles = deps.profiles ?? new OpenCodeProfiles(deps.stateDir);
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
      admitOpenCodeRelease(selected.version);
      if (!isAbsolute(selected.executable)) throw new Error("Native OpenCode capability unavailable");
      const generation = openCodeGeneration(selected.version);
      if (generation === 2 && deps.configure)
        throw new OpenCodeCapabilityError(
          `Remote OpenCode ${selected.version} workers are not supported yet; only local OpenCode 2 hires take the V2 plugin`,
        );
      signal?.throwIfAborted();
      const launchRoot = join(deps.stateDir, "opencode-workers");
      await mkdir(launchRoot, { recursive: true, mode: 0o700 });
      // Native-owned persistent history survives uncertain creation and controller retirement.
      // OpenCode 2 keeps credentials in the owner's database, so its hires get no profile.
      const profile = generation === 1 ? await profiles.allocate() : undefined;
      const directory = await mkdtemp(join(launchRoot, "launch-"));
      let configuration: Awaited<ReturnType<NonNullable<OpenCodeSeatDeps["configure"]>>> | undefined;
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
        cleanup = (async () => {
          try {
            await configuration?.retire();
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        })();
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
        configuration = await (generation === 2
          ? configureLocalV2(deps, launch, controller, directory)
          : deps.configure
            ? deps.configure(launch, profile!, controller, directory)
            : configureLocal(deps, launch, profile!, controller, directory));
        if (disposed) {
          await configuration.retire();
          throw new Error("Native controller retired during preparation");
        }
        const scopedEnv = configuration.env;
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
          // OpenCode 2 has no --model flag: the plugin creates the session with it.
          command:
            generation === 2
              ? [selected.executable, "--standalone", launch.cwd]
              : [
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
                    cwd: configuration!.cwd,
                    title: view.name ?? "Clankie worker",
                    resumeSessionId: launch.resumeSessionId,
                    model: launch.model,
                    effort: launch.effort,
                  },
                  deps.timeoutMs ?? 20_000,
                ),
              );
              if (initialized.version !== selected.version)
                throw new OpenCodeCapabilityError(
                  `OpenCode TUI reports ${initialized.version}, not the probed ${selected.executable} ${selected.version}`,
                );
              if (launch.resumeSessionId !== undefined && initialized.sessionId !== launch.resumeSessionId)
                throw new Error("Exact resume mismatch");
              ref = { harness: "opencode", paneId: view.paneId, sessionId: initialized.sessionId };
              native.select(ref.sessionId);
              await root.report(ref.sessionId, "idle", view.name);
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
              // OpenCode 2 history is not the registered V1 SQLite shape.
              if (profile)
                await profiles.register(profile, ref.sessionId, launch.cwd, initialized.version, () =>
                  verify(ref!),
                );
              await verify(ref);
              const selectedRef = ref;
              let lastMessageId: string | undefined;
              const control: SeatControl = {
                ref: selectedRef,
                deliveryModes: generation === 2 ? ["steer", "queue"] : ["queue"],
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
                async refreshToolCatalog(input) {
                  try {
                    await verify(selectedRef);
                    const result = CatalogRefresh.parse(
                      await native.request("refreshToolCatalog", undefined, 45_000, async () => {
                        await input?.beforeDispatch?.();
                        await verify(selectedRef);
                        return true;
                      }),
                    );
                    await verify(selectedRef);
                    return result;
                  } catch {
                    return { outcome: "failed", reason: "original-native-control-unavailable" };
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
                  const messageId =
                    generation === 2 ? openCode2MessageId() : `msg_${randomUUID().replaceAll("-", "")}`;
                  let attempted = false;
                  try {
                    await verify(selectedRef);
                    attempted = true;
                    const result = Delivery.parse(
                      await native.request(
                        "send",
                        {
                          messageId,
                          text,
                          ...(generation === 2 ? { delivery: options?.delivery ?? "queue" } : {}),
                        },
                        options?.timeoutMs,
                        options?.beforeDispatch,
                      ),
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
                async exit(beforeExit) {
                  await verify(selectedRef);
                  await native.request("exit", undefined, 5000, async () => {
                    await beforeExit?.();
                    return true;
                  });
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
            } catch (error) {
              console.error("VUH2417_DEBUG start failure", error); // VUH2417_DEBUG
              await dispose();
              return {
                outcome: "failed",
                reason: "not_ready",
                detail:
                  error instanceof OpenCodeCapabilityError
                    ? `${error.message}. Nothing was briefed; no fallback or duplicate native process was launched.`
                    : "Native OpenCode binding or brief unconfirmed; inspect the original pane before retrying. No fallback or duplicate native process was launched.",
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
