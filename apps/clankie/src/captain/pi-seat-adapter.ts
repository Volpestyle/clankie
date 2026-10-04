import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type {
  HarnessSeatAdapter,
  PreparedSeatLaunch,
  SeatControl,
  SeatEvent,
  SeatLaunch,
  SeatRef,
  SeatView,
} from "@clankie/agent-hosts";
import { z } from "zod";
import type {
  createPreparedNativeHost,
  PreparedNativeRoot,
  PreparedNativeSession,
} from "./prepared-native-host.ts";
import { discoverPiNativeCapability } from "./pi-native-capability.ts";
import { createPiWorkerController } from "./pi-worker-controller.ts";
import { DeliveryFence } from "./delivery-fence.ts";

const Status = z.enum(["idle", "working", "blocked"]);
const Session = z.object({
  sessionId: z.string().uuid(),
  sessionFile: z.string().startsWith("/"),
  sessionDirectory: z.string().startsWith("/"),
  cwd: z.string(),
  mode: z.literal("tui"),
  version: z.literal("0.87.1"),
  header: z.object({
    type: z.literal("session"),
    version: z.literal(3),
    id: z.string().uuid(),
    cwd: z.string(),
  }),
  runtime: z.object({ executable: z.string(), argv: z.array(z.string()).length(2), node: z.string() }),
});
const Delivery = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("accepted"), messageId: z.string().uuid(), state: z.literal("started") }),
  z.object({ outcome: z.literal("unconfirmed"), messageId: z.string().uuid(), detail: z.string() }),
  z.object({ outcome: z.literal("unavailable"), detail: z.string() }),
]);

export function createPiSeatAdapter(deps: {
  readonly repoRoot: string;
  readonly stateDir: string;
  readonly native: ReturnType<typeof createPreparedNativeHost>;
  readonly discover?: typeof discoverPiNativeCapability;
  readonly controller?: typeof createPiWorkerController;
  readonly timeoutMs?: number;
}): HarnessSeatAdapter {
  const controls = new Map<string, SeatControl>();
  const fence = new DeliveryFence(join(deps.stateDir, "pi-workers", "receipts.json"));
  return {
    harness: "pi",
    async start() {
      return {
        outcome: "failed",
        reason: "harness_unavailable",
        detail: "Pi requires an initial native argv pane; no terminal fallback",
      };
    },
    async attach(ref) {
      const control = controls.get(ref.sessionId);
      if (ref.harness !== "pi" || control?.ref.paneId !== ref.paneId) return undefined;
      return (await control.status()) === "offline" ? undefined : control;
    },
    async prepare(launch: SeatLaunch, signal): Promise<PreparedSeatLaunch> {
      signal?.throwIfAborted();
      if (launch.harness !== "pi") throw new Error("Native Pi launch required");
      if (launch.model !== undefined && !/^[^/\s]+\/[^\s]+$/u.test(launch.model))
        throw new Error("Pi model must be an exact native provider/model");
      if (
        launch.effort !== undefined &&
        !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(launch.effort)
      )
        throw new Error("Unsupported native Pi thinking level");
      const args = [...(launch.harnessArgs ?? [])];
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--no-skills") continue;
        if (args[index] !== "--skill" || !args[index + 1] || !isAbsolute(args[++index]!))
          throw new Error("Unsupported Pi worker launch argument");
      }
      if (launch.resumeSessionId !== undefined && fence.pending(launch.resumeSessionId))
        throw new Error("Original Pi delivery is uncertain; inspect its original worker before resuming");
      const capability = await (deps.discover ?? discoverPiNativeCapability)(launch);
      await capability.verify();
      signal?.throwIfAborted();
      const cwd = await realpath(launch.cwd);
      let disposed = false;
      let started = false;
      let root: PreparedNativeRoot | undefined;
      let ref: SeatRef | undefined;
      let descriptor: PreparedNativeSession | undefined;
      let view: SeatView | undefined;
      let owned: SeatControl | undefined;
      const onAbort = () => {
        void dispose().catch(() => {});
      };
      const native = await (deps.controller ?? createPiWorkerController)({
        fence,
        ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
        onRetire: () => {
          disposed = true;
          signal?.removeEventListener("abort", onAbort);
          if (ref && controls.get(ref.sessionId) === owned) controls.delete(ref.sessionId);
        },
      });
      const dispose = () => native.close();
      const verify = async (expected: SeatRef) => {
        if (
          disposed ||
          !root ||
          !ref ||
          !descriptor ||
          !view ||
          expected.harness !== "pi" ||
          expected.sessionId !== ref.sessionId ||
          expected.paneId !== ref.paneId
        )
          throw new Error("Original Pi native binding unavailable");
        await capability.verify();
        await native.request("status");
        await view.guard?.();
        await capability.verifySession(ref.sessionId, descriptor.value, cwd);
        const proof = await root.proof(descriptor);
        await native.request("status");
        await capability.verify();
        return proof;
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        await dispose();
        signal.throwIfAborted();
      }
      return {
        command: [
          capability.executable,
          capability.cli,
          "--extension",
          join(deps.repoRoot, "integrations/pi-plugin/worker.mjs"),
          ...(capability.saved ? ["--session", capability.saved.path] : []),
          ...(launch.model
            ? [
                "--provider",
                launch.model.slice(0, launch.model.indexOf("/")),
                "--model",
                launch.model.slice(launch.model.indexOf("/") + 1),
              ]
            : []),
          ...(launch.effort ? ["--thinking", launch.effort] : []),
          ...args,
        ],
        env: {
          ...launch.env,
          CLANKIE_PI_WORKER_PORT: String(native.port),
          CLANKIE_PI_WORKER_TOKEN: native.token,
        },
        verify,
        dispose,
        async start(allocated, startSignal) {
          if (started || disposed)
            return {
              outcome: "failed",
              reason: "not_ready",
              detail: "Original Pi launch was already used or retired; no duplicate",
            };
          started = true;
          view = allocated;
          try {
            signal?.throwIfAborted();
            startSignal?.throwIfAborted();
            await capability.verify();
            await view.guard?.();
            root = await deps.native.capture(view.paneId, capability.executable, cwd);
            native.bind(
              (socket) => root!.check(socket),
              async () => {
                signal?.throwIfAborted();
                startSignal?.throwIfAborted();
                await capability.verify();
                await view!.guard?.();
              },
            );
            const initialized = Session.parse(
              await native.request(
                "initialize",
                {
                  cwd,
                  ...(launch.model ? { model: launch.model } : {}),
                  ...(launch.effort ? { effort: launch.effort } : {}),
                  ...(capability.saved
                    ? { sessionId: capability.saved.sessionId, sessionFile: capability.saved.path }
                    : {}),
                },
                deps.timeoutMs ?? 20_000,
              ),
            );
            if (
              initialized.cwd !== cwd ||
              initialized.header.cwd !== cwd ||
              initialized.header.id !== initialized.sessionId ||
              initialized.runtime.executable !== capability.executable ||
              initialized.runtime.argv[1] !== capability.cli ||
              (await realpath(initialized.sessionDirectory)) !== dirname(initialized.sessionFile) ||
              (capability.saved &&
                (capability.saved.path !== initialized.sessionFile ||
                  capability.saved.sessionId !== initialized.sessionId))
            )
              throw new Error("Native Pi runtime identity disagrees with original launch");
            await capability.verifySession(initialized.sessionId, initialized.sessionFile, cwd);
            ref = { harness: "pi", sessionId: initialized.sessionId, paneId: view.paneId };
            descriptor = { source: "herdr:pi", kind: "path", value: initialized.sessionFile };
            native.select(ref.sessionId);
            await root.report(descriptor, Status.parse(await native.request("status")));
            await view.bound?.(ref);
            await verify(ref);
            const selected = ref;
            let lastMessageId: string | undefined;
            const control: SeatControl = {
              ref: selected,
              verify: () => verify(selected),
              async status() {
                try {
                  await verify(selected);
                  const status = Status.parse(await native.request("status"));
                  await root!.report(descriptor!, status);
                  return status;
                } catch {
                  return "offline";
                }
              },
              async send(text, options) {
                const earlier = native.pending();
                if (earlier)
                  return {
                    outcome: "unconfirmed",
                    messageId: earlier.messageId,
                    deliveryStage: "uncertain",
                    detail: "Original native delivery remains uncertain; no resend",
                  };
                const messageId = randomUUID();
                let attempted = false;
                try {
                  await verify(selected);
                  attempted = true;
                  const result = Delivery.parse(
                    await native.request(
                      "send",
                      {
                        messageId,
                        text,
                        deliverAs: "followUp",
                        timeoutMs: options?.timeoutMs ?? deps.timeoutMs ?? 10_000,
                      },
                      (options?.timeoutMs ?? deps.timeoutMs ?? 10_000) + 1000,
                    ),
                  );
                  if (result.outcome === "unavailable")
                    return { outcome: "offline", detail: result.detail, deliveryStage: "unavailable" };
                  if (result.messageId !== messageId) throw new Error("Native Pi receipt mismatch");
                  lastMessageId = messageId;
                  if (result.outcome === "accepted") {
                    await verify(selected);
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
                      detail: "Original native Pi control unavailable before dispatch",
                      deliveryStage: "unavailable",
                    };
                  return {
                    outcome: "unconfirmed",
                    messageId,
                    detail: "Native Pi delivery unconfirmed; inspect original session before retrying",
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
                    return { type: "blocked", at, reason: "A native Pi owner decision is pending" };
                  if (state === "idle") {
                    try {
                      const result = z
                        .discriminatedUnion("state", [
                          z.object({ state: z.literal("pending") }),
                          z.object({
                            state: z.literal("completed"),
                            ok: z.boolean(),
                            text: z.string().max(32_768),
                            stopReason: z.string(),
                          }),
                        ])
                        .parse(await native.request("settlement", { messageId: lastMessageId }));
                      if (result.state === "completed") {
                        await verify(selected);
                        return {
                          type: "turn_completed",
                          at,
                          ok: result.ok,
                          text: result.text,
                          stopReason: result.stopReason,
                          ...(lastMessageId ? { messageId: lastMessageId } : {}),
                        };
                      }
                    } catch {
                      return { type: "released", at };
                    }
                  }
                  await new Promise((resolve) => setTimeout(resolve, 100));
                }
              },
              async interrupt() {
                try {
                  await verify(selected);
                  return (
                    (await native.request("interrupt", { timeoutMs: deps.timeoutMs ?? 10_000 })) === true
                  );
                } catch {
                  return false;
                }
              },
              close: dispose,
            };
            owned = control;
            controls.set(selected.sessionId, control);
            if (launch.brief && (await control.send(launch.brief)).outcome !== "accepted")
              throw new Error("brief_delivery_unverified: native Pi did not confirm its brief");
            return { outcome: "started", control };
          } catch {
            await dispose();
            return {
              outcome: "failed",
              reason: "not_ready",
              detail:
                "Native Pi binding or brief unconfirmed; inspect the original pane before retrying. No duplicate process or terminal fallback was used.",
            };
          }
        },
      };
    },
  };
}
