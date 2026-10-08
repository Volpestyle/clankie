import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
  ComputerCoordinatesSchema,
  ComputerScreenshotSchema,
  ComputerFrameSchema,
  JoinedScreenRequestSchema,
  JoinedScreenChunkSchema,
  JOINED_SCREEN_CHUNK_CHARS,
  type ComputerInput,
  type ComputerTarget,
  type ComputerScreenshot,
} from "@clankie/interactive-environment";
import {
  ComputerBody,
  type ComputerAdapter,
  type ComputerObservation,
} from "../../clankie/src/computer-body.ts";
import { BodyLeaseStore } from "../../clankie/src/body-leases.ts";
import type { BodyConversationIdentity } from "../../clankie/src/body-lease-router.ts";
import type { JoinedMachinePorts } from "./joined-machine-client.ts";
import { MachineJoinLocalScreenStatusSchema } from "@clankie/protocol/machine-join";

const approval = z.strictObject({ approved: z.boolean(), allowInput: z.boolean() });
const nativeObservation = z.strictObject({
  png: z.string().max(24 * 1024 * 1024),
  coordinates: ComputerCoordinatesSchema,
  elements: ComputerScreenshotSchema.shape.elements,
  accessibility: ComputerScreenshotSchema.shape.accessibility,
  reference: z.string().uuid(),
});

/** Sole parent owns this native stdio channel. Neither wire arguments nor a service flag grant consent. */
class LentScreenNative implements ComputerAdapter {
  readonly bodyId: string;
  allowInput = false;
  inputReady = false;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly heartbeat: NodeJS.Timeout;
  private stopped = false;
  private bound = false;
  private boundLease = "";
  private attemptedInput = false;
  get available(): boolean {
    return !this.stopped;
  }
  private policy = false;
  private session = "";
  private onStop: () => void;
  constructor(options: { bodyId: string; executable: string; args?: string[]; onStop(): void }) {
    this.bodyId = options.bodyId;
    this.onStop = options.onStop;
    this.child = spawn(options.executable, options.args ?? [], { stdio: "pipe", windowsHide: false });
    // Provider diagnostics may contain observations. They never become evidence or API errors.
    this.child.stderr.resume();
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      try {
        if (line.length > 24 * 1024 * 1024) throw Error("native_reply_too_large");
        const reply = z
          .strictObject({ id: z.string().uuid(), ok: z.boolean(), result: z.unknown().optional() })
          .safeParse(JSON.parse(line));
        if (!reply.success) {
          this.fence();
          return;
        }
        const pending = this.pending.get(reply.data.id);
        if (!pending) {
          this.fence();
          return;
        }
        this.pending.delete(reply.data.id);
        if (reply.data.ok) pending.resolve(reply.data.result);
        else pending.reject(Error("native_request_refused"));
      } catch {
        this.fence();
      }
    });
    const failed = () => {
      this.stopped = true;
      this.fence();
      for (const entry of this.pending.values()) entry.reject(Error("native_host_unavailable"));
      this.pending.clear();
    };
    this.child.once("error", failed);
    this.child.once("exit", failed);
    this.heartbeat = setInterval(() => {
      if (this.policy && !this.stopped) void this.call("heartbeat").catch(() => this.fence());
    }, 250);
  }
  private call(action: string, value: unknown = {}): Promise<unknown> {
    if (this.stopped) return Promise.reject(Error("native_host_unavailable"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.fence();
        reject(Error("native_reply_unknown"));
      }, 30_000);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin.write(JSON.stringify({ id, action, session: this.session, value }) + "\n", (error) => {
        if (error) {
          this.pending.get(id)?.reject(Error("native_transport_unknown"));
          this.pending.delete(id);
          this.fence();
        }
      });
    });
  }
  fence(): void {
    this.inputReady = false;
    this.allowInput = false;
    this.onStop();
  }
  setPolicy(allowed: boolean): void {
    this.policy = allowed;
    if (!allowed) {
      this.fence();
      void this.call("stop").catch(() => {});
    }
  }
  async consent(conversationId: string, guard: () => void): Promise<boolean> {
    guard();
    this.session = randomUUID();
    const choice = approval.parse(await this.call("consent", { conversationId }));
    guard();
    this.allowInput = choice.approved && choice.allowInput;
    this.inputReady = this.allowInput;
    return choice.approved;
  }
  async end(): Promise<void> {
    await this.call("end");
    this.bound = false;
    this.boundLease = "";
  }
  async bind(leaseId: string): Promise<void> {
    z.strictObject({ bound: z.literal(true) }).parse(await this.call("bind", { leaseId }));
    this.bound = true;
    this.boundLease = leaseId;
  }
  async inventory(guard: () => Promise<void>) {
    await guard();
    const result = await this.call("inventory");
    await guard();
    return z
      .strictObject({
        complete: z.boolean(),
        apps: z.array(z.strictObject({ appId: z.string(), name: z.string() })).max(512),
        windows: z
          .array(z.strictObject({ appId: z.string(), windowId: z.string(), title: z.string() }))
          .max(2048),
      })
      .parse(result);
  }
  async capture(
    target: ComputerTarget,
    mode: "normal" | "classic_read_only",
    guard: () => Promise<void>,
  ): Promise<ComputerObservation> {
    await guard();
    const observation = nativeObservation.parse(await this.call("capture", { target }));
    await guard();
    return {
      ...observation,
      target,
      png: Buffer.from(observation.png, "base64"),
      inputReady: this.inputReady && mode === "normal",
    };
  }
  async input(
    input: ComputerInput,
    observation: ComputerObservation,
    screenshot: ComputerScreenshot,
    guard: () => Promise<void>,
  ) {
    await guard();
    if (
      !this.allowInput ||
      !this.inputReady ||
      !input.foreground ||
      !input.expect ||
      input.expect.equals === observation.accessibility?.[input.expect.field] ||
      !["click", "element", "type", "key", "drag", "scroll"].includes(input.kind) ||
      (input.kind === "key" &&
        ![
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "Tab",
          "Space",
          "Home",
          "End",
          "PageUp",
          "PageDown",
        ].includes(input.keys)) ||
      (input.kind === "scroll" && (!input.at || input.amount > 10))
    )
      return {
        outcome: "failed" as const,
        detail:
          "Requires session input opt-in, explicit foreground and a changed exact accessibility effect; unsupported primitives refuse",
      };
    this.attemptedInput = true; // Observer acknowledgment cannot prove target-queue drain.
    const result = z
      .strictObject({ outcome: z.enum(["confirmed", "failed", "uncertain"]), detail: z.string().max(4096) })
      .parse(await this.call("input", { input, screenshot, reference: observation.reference }));
    await guard();
    if (result.outcome !== "confirmed") this.fence();
    return result;
  }
  async stop(guard: () => Promise<void>): Promise<boolean> {
    this.fence();
    await guard();
    const proof = z
      .strictObject({
        quiescent: z.boolean(),
        session: z.string().uuid(),
        leaseId: z.string(),
        observer: z.boolean(),
        uncertain: z.boolean(),
        pending: z.number().int().nonnegative(),
        held: z.number().int().nonnegative(),
        busy: z.boolean(),
      })
      .safeParse(await this.call("stop").catch(() => undefined));
    await guard();
    if (!proof.success) return false;
    const result = proof.data;
    // A fresh helper cannot attest to an older process/session, even if it has no queue.
    return (
      !this.attemptedInput &&
      this.bound &&
      result.session === this.session &&
      result.leaseId === this.boundLease &&
      result.quiescent &&
      result.observer &&
      !result.uncertain &&
      result.pending === 0 &&
      result.held === 0 &&
      !result.busy
    );
  }
  async close(): Promise<void> {
    this.policy = false;
    clearInterval(this.heartbeat);
    this.fence();
    if (!this.stopped) await this.call("stop").catch(() => {});
    // Exit is not stop proof. A held lease remains persisted for owner recovery.
    this.onStop = () => {};
    this.child.stdin.end();
    this.child.kill();
  }
}

/** Host-owned lease and local approval. The entire normal queue shares a revocation generation. */
export function createJoinedScreenPorts(options: {
  machineId: string;
  directory: string;
  executable: string;
  args?: string[];
}): Pick<JoinedMachinePorts, "screen" | "screenPolicy" | "closeScreen" | "localScreen"> {
  const store = new BodyLeaseStore(options.directory);
  let generation = 0;
  let allowed = false;
  let conversation = "";
  let queue: Promise<unknown> = Promise.resolve();
  const screenshots = new Map<string, ComputerScreenshot>();
  const fence = () => {
    generation++;
    screenshots.clear();
    const held = store.recoveryReference("computer");
    if (held) {
      const begun = store.beginRecovery(held);
      if (begun.outcome === "admitted") store.finish(held, begun.operationId, "uncertain");
    }
  };
  const bodyDirectory = join(options.directory, "lent-screen");
  mkdirSync(bodyDirectory, { recursive: true, mode: 0o700 });
  const identityPath = join(bodyDirectory, "identity.json");
  if (!existsSync(identityPath))
    writeFileSync(identityPath, JSON.stringify({ bodyId: randomUUID() }), {
      mode: 0o600,
      flag: "wx",
      flush: true,
    });
  const physical = z
    .strictObject({ bodyId: z.string().uuid() })
    .parse(JSON.parse(readFileSync(identityPath, "utf8")));
  const native = new LentScreenNative({
    bodyId: `lent:${physical.bodyId}`,
    executable: options.executable,
    ...(options.args ? { args: options.args } : {}),
    onStop: fence,
  });
  const body = new ComputerBody(native, store, bodyDirectory, async () => {
    if (!allowed) throw Error("screen_policy_refused");
  });
  // Local parent proves this authority by owning the native process/channel. Only status/recovery uses it.
  const localIdentity = (): BodyConversationIdentity => {
    const conversationId = store.recoveryReference("computer")?.conversationId ?? "local-screen-status";
    return {
      conversationId,
      route: { owner: { conversationId }, mode: "machine" },
      current: () => true,
      authorize: async () => true,
    };
  };
  const localStatus = async (outcome: "status" | "released" | "held" | "unavailable") => {
    const raw = await body.dispatch(localIdentity(), { action: "status" });
    const status = z
      .object({ busy: z.boolean(), allowInput: z.boolean(), inputReady: z.boolean(), lease: z.unknown() })
      .parse(raw);
    const lease =
      status.lease === null
        ? null
        : z
            .object({
              conversationId: z.string(),
              expiresAt: z.number(),
              state: z.enum(["active", "recovery_required"]),
            })
            .parse(status.lease);
    return MachineJoinLocalScreenStatusSchema.parse({
      ...status,
      lease,
      outcome,
      available: native.available,
    });
  };
  return {
    async localScreen(action) {
      if (action === "screen_status") return localStatus("status");
      native.fence(); // Immediate, ahead of every queued effect and any awaited provider reply.
      void native.stop(async () => {}).catch(() => {});
      const run = async () => {
        const result = await body.dispatch(localIdentity(), { action: "recover" });
        const released = z.object({ outcome: z.literal("released") }).safeParse(result).success;
        if (released && conversation) {
          await native.end();
          conversation = "";
        }
        return localStatus(released ? "released" : "held");
      };
      const result = queue.then(run);
      queue = result.catch(() => {});
      return result;
    },
    screenPolicy(value) {
      allowed = value;
      native.setPolicy(value);
    },
    async screen(raw, signal, policyGuard) {
      const request = JoinedScreenRequestSchema.parse(JSON.parse(raw));
      const recovery =
        request.op === "command" &&
        ["status", "release", "revoke", "recover"].includes(request.command.action);
      if (request.op === "command" && ["release", "revoke", "recover"].includes(request.command.action)) {
        if (store.recoveryReference("computer")?.conversationId !== request.conversationId)
          throw Error("wrong_screen_session");
        // Fence ahead of the normal queue. Native stop also bypasses queued effects.
        native.fence();
        void native.stop(async () => {}).catch(() => {});
      }
      const admittedGeneration = generation;
      const run = async () => {
        const check = () => {
          if (signal.aborted || (!recovery && (generation !== admittedGeneration || !allowed)))
            throw Error("screen_revoked");
          if (!recovery) policyGuard();
          if (request.op !== "command" || request.command.action !== "acquire") {
            const held = store.recoveryReference("computer");
            if (held && held.conversationId !== request.conversationId) throw Error("wrong_screen_session");
            if (!recovery && conversation !== request.conversationId) throw Error("screen_consent_missing");
          }
        };
        check();
        const identity: BodyConversationIdentity = {
          conversationId: request.conversationId,
          route: { owner: { conversationId: request.conversationId }, mode: "machine" },
          current: () => {
            try {
              check();
              return true;
            } catch {
              return false;
            }
          },
          authorize: async () => {
            try {
              check();
              return true;
            } catch {
              return false;
            }
          },
        };
        if (request.op === "command" && request.command.action === "acquire") {
          if (store.recoveryReference("computer"))
            return JSON.stringify(await body.dispatch(identity, { action: "status" }));
          if (!(await native.consent(request.conversationId, check))) throw Error("screen_consent_refused");
          check();
          conversation = request.conversationId;
          const result = await body.dispatch(identity, request.command);
          const acquired = z
            .object({ outcome: z.literal("acquired"), lease: z.object({ leaseId: z.string() }) })
            .parse(result);
          await native.bind(acquired.lease.leaseId);
          check();
          return JSON.stringify(result);
        }
        if (request.op === "command" && ["release", "revoke"].includes(request.command.action)) {
          const held = store.recoveryReference("computer");
          if (!held || !("leaseId" in request.command) || request.command.leaseId !== held.token)
            throw Error("stale_screen_lease");
          const result = await body.dispatch(identity, { action: "recover" });
          if (z.object({ outcome: z.literal("released") }).safeParse(result).success) {
            await native.end();
            conversation = "";
          }
          return JSON.stringify(result);
        }
        if (request.op === "command") {
          if (request.command.action === "frame") throw Error("use_frame_chunks");
          if (request.command.action === "input" && request.command.inputs.length !== 1)
            throw Error("one_primitive_per_capture");
          const result = await body.dispatch(identity, request.command);
          if (request.command.action === "capture") {
            const shot = ComputerScreenshotSchema.parse(result);
            screenshots.set(shot.screenshotId, shot);
            while (screenshots.size > 8) screenshots.delete(screenshots.keys().next().value!);
          }
          if (
            request.command.action === "recover" &&
            z.object({ outcome: z.literal("released") }).safeParse(result).success
          ) {
            await native.end();
            conversation = "";
          }
          return JSON.stringify(result);
        }
        const frame = ComputerFrameSchema.parse(
          await body.dispatch(identity, {
            action: "frame",
            leaseId: request.leaseId,
            screenshotId: request.screenshotId,
          }),
        );
        check();
        const shot = screenshots.get(request.screenshotId);
        if (!shot || Date.parse(shot.expiresAt) <= Date.now()) throw Error("frame_expired");
        return JSON.stringify(
          JoinedScreenChunkSchema.parse({
            expiresAt: shot.expiresAt,
            screenshotId: frame.screenshotId,
            encoding: frame.encoding,
            byteLength: frame.byteLength,
            sha256: frame.sha256,
            offset: request.offset,
            totalChars: frame.data.length,
            data: frame.data.slice(request.offset, request.offset + JOINED_SCREEN_CHUNK_CHARS),
          }),
        );
      };
      const result = queue.then(run);
      queue = result.catch(() => {});
      return result;
    },
    async closeScreen() {
      allowed = false;
      native.setPolicy(false);
      await native.close();
      await queue;
      store.close();
    },
  };
}

/** Releases carry the authored helper; a missing helper refuses rather than borrowing a harness. */
export function defaultJoinedScreenPorts(
  machineId: string,
  env: NodeJS.ProcessEnv,
): ReturnType<typeof createJoinedScreenPorts> | undefined {
  if (!["darwin", "win32"].includes(process.platform)) return undefined;
  const root = resolve(import.meta.dirname, "../../..");
  const executable =
    process.platform === "darwin" ? join(root, "libexec", "clankie-screen") : "powershell.exe";
  const script = join(root, "apps", "tui", "native", "lent-screen.ps1");
  if (!(process.platform === "darwin" ? existsSync(executable) : existsSync(script))) return undefined;
  return createJoinedScreenPorts({
    machineId,
    directory: join(resolve(env.CLANKIE_STATE?.trim() || join(homedir(), ".clankie")), "body"),
    executable,
    ...(process.platform === "win32" ? { args: ["-NoProfile", "-STA", "-File", script] } : {}),
  });
}
