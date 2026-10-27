import { createHash, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import {
  nativeProcessStart,
  type NativeBirth,
  type NativeSocketProcess,
  type NativeProcessSnapshot,
} from "./local-fleet-process.ts";

/**
 * Which process may act as the lead's operator-lane bridge or controller for a
 * conversation (VUH-2816). The operator bearer names a lane, and the
 * `conversationId` query is free text, so neither says who is asking. The
 * launcher that spawned the harness registers its conversation, the harness
 * process and a nonce hash. Each bridge request is then admitted only when the
 * kernel's owner of its TCP socket is the harness's direct child carrying that
 * nonce, or is the registered launcher itself. A stray inheriting the seat's
 * environment, or running anywhere in its ancestry, is neither. Process
 * identity is pid plus kernel birth, so a reused pid does not match.
 */
export interface SeatProcess {
  readonly pid: number;
  readonly birth: readonly [string, string];
  readonly kernelIdentity?: string | undefined;
}

export interface SeatBindingObservers {
  /** Fresh kernel owner and ancestry of a loopback socket; undefined when unprovable. */
  socket(socket: Socket): Promise<NativeSocketProcess | undefined>;
  /** Fresh lifetime of a pid; undefined when it is gone or unobservable. */
  birth(pid: number): Promise<NativeBirth | undefined>;
  /** Existing native pair census, used to prove the named harness is this socket owner's child. */
  processes(controllerPid: number, harnessPid: number): Promise<NativeProcessSnapshot | undefined>;
  available?(): boolean;
}

export interface SeatRegistration {
  readonly conversationId: string;
  readonly harnessPid: number;
  /** sha256 hex of the nonce handed to the harness's MCP server through its own launch config. */
  readonly nonceHash: string;
  /** The bridge's parent is the harness (1), or a wrapper the launcher spawned and then the harness (2). */
  readonly depth?: 1 | 2 | undefined;
}

export type SeatBindingRefusal =
  | "seat_binding_conversation_required"
  | "seat_binding_required"
  | "seat_binding_stale"
  | "seat_process_unproven"
  | "seat_bridge_not_registered"
  | "seat_bridge_claim_invalid"
  | "seat_bridge_claimed"
  | "seat_binding_conflict"
  | "seat_harness_not_child"
  | "seat_binding_helper_missing"
  | "seat_binding_invalid";

export function seatBindingRecovery(error: string): string {
  switch (error) {
    case "seat_binding_helper_missing":
      return "Native process helper is missing or this platform is unsupported. Prepare the checkout with `clankie heavy -- node scripts/build-fleet-proof.mjs`, or repair the installed release; then relaunch the seat.";
    case "seat_process_unproven":
      return "The service could not prove the local TCP socket/process lifetime. Use a direct IPv4 loopback launcher on this machine; check the native helper with `clankie doctor`. Relay sockets cannot register a local seat.";
    case "seat_harness_not_child":
      return "The named harness is not a verified direct child of the registering socket owner. Relaunch with `clankie claude|codex|opencode|grok`; do not register an ancestor or another process's PID.";
    case "seat_bridge_not_registered":
      return "The bridge has the wrong native parent chain for this launch. Relaunch through the supported launcher; nested shell commands and separately started MCP bridges cannot inherit the seat.";
    case "seat_bridge_claim_invalid":
      return "The bridge launch nonce is absent or does not match. Relaunch to recreate its private MCP configuration; do not copy a nonce into the harness environment.";
    case "seat_bridge_claimed":
      return "A different live bridge already holds this launch's claim. Close only your duplicate launch or wait for its exit, then relaunch; do not take over another seat.";
    case "seat_binding_conflict":
      return "A different live launcher holds this conversation. Select a new conversation or wait for that launcher to exit; do not kill another seat.";
    case "seat_binding_stale":
      return "The registered launcher or harness exited or its PID lifetime changed. Relaunch the seat; its launcher heartbeat recreates bindings after a service restart.";
    case "seat_binding_conversation_required":
      return "No conversation was selected. Start the seat with `clankie claude|codex|opencode|grok`; an unbound MCP bridge never defaults to global-default.";
    case "seat_binding_required":
      return "No verified launcher binding exists for this conversation. Start the seat through its launcher, or allow its heartbeat to recover after a service restart.";
    default:
      return "Seat binding is unavailable or invalid. Run `clankie doctor` and relaunch through the supported launcher.";
  }
}

export type SeatBindingResult =
  | { readonly ok: true; readonly role: "controller" | "bridge" | "registered" | "observed" }
  | { readonly ok: false; readonly error: SeatBindingRefusal; readonly status: 400 | 403 | 409 };

interface Entry {
  readonly controller: SeatProcess;
  readonly harness: SeatProcess;
  readonly nonceHash: string;
  readonly depth: 1 | 2;
  claimant?: SeatProcess;
}

const HASH = /^[a-f0-9]{64}$/u;

export function seatNonceHash(nonce: string): string {
  return createHash("sha256").update(nonce).digest("hex");
}

function same(a: SeatProcess, b: SeatProcess): boolean {
  return (
    a.pid === b.pid &&
    a.birth[0] === b.birth[0] &&
    a.birth[1] === b.birth[1] &&
    a.kernelIdentity === b.kernelIdentity
  );
}

function proc(
  pid: number,
  birth: readonly [string, string],
  kernelIdentity: string | undefined,
): SeatProcess {
  return { pid, birth: [birth[0], birth[1]], kernelIdentity };
}

function fromBirth(pid: number, birth: NativeBirth): SeatProcess {
  return proc(pid, birth, birth.kernelIdentity);
}

export class OperatorSeatBindings {
  private readonly entries = new Map<string, Entry>();

  private readonly observers: SeatBindingObservers;
  private lastRefusal: { error: SeatBindingRefusal; recovery: string; conversationId?: string } | undefined;
  public readonly mode: "observe" | "enforce";
  private readonly observed = new Set<string>();
  private readonly onObservation:
    | ((error: SeatBindingRefusal, conversationId: string | undefined) => void)
    | undefined;

  public constructor(
    observers: SeatBindingObservers,
    mode: "observe" | "enforce" = "enforce",
    onObservation?: (error: SeatBindingRefusal, conversationId: string | undefined) => void,
  ) {
    this.observers = observers;
    this.mode = mode;
    this.onObservation = onObservation;
  }

  public status() {
    const available = this.observers.available?.() ?? true;
    return {
      available,
      mode: this.mode,
      ...(!available
        ? {
            error: "seat_binding_helper_missing",
            recovery: seatBindingRecovery("seat_binding_helper_missing"),
          }
        : {}),
      ...(this.lastRefusal === undefined ? {} : { lastRefusal: this.lastRefusal }),
      bindings: [...this.entries].map(([conversationId]) => ({ conversationId })),
    };
  }

  /** Census membership must match a current registered kernel lifetime, not a conversation claim. */
  public async registeredLauncher(pid: number, startTime: string, requireBridge = true): Promise<string | undefined> {
    for (const [conversationId, entry] of this.entries) {
      if (
        entry.controller.pid === pid &&
        (entry.controller.kernelIdentity
          ? `${entry.controller.kernelIdentity.split(":")[0]}:${entry.controller.kernelIdentity.split(":").at(-1)}`
          : nativeProcessStart(entry.controller.birth)) === startTime &&
        (await this.alive(entry.controller)) &&
        (await this.alive(entry.harness)) &&
        (!requireBridge || entry.claimant !== undefined && (await this.alive(entry.claimant)))
      )
        return conversationId;
    }
    return undefined;
  }

  private refusal(
    error: SeatBindingRefusal,
    status: 400 | 403 | 409,
    conversationId?: string,
  ): SeatBindingResult {
    // The launcher and bridge race during normal startup/restart. Keep the
    // refusal on the wire, without turning that retry window into doctor history.
    if (error !== "seat_binding_required")
      this.lastRefusal = {
        error,
        recovery: seatBindingRecovery(error),
        ...(conversationId === undefined ? {} : { conversationId }),
      };
    return { ok: false, error, status };
  }

  private clearRefusal(conversationId: string): void {
    if (this.lastRefusal?.conversationId === conversationId) this.lastRefusal = undefined;
  }

  private async alive(process: SeatProcess): Promise<boolean> {
    const birth = await this.observers.birth(process.pid);
    return birth !== undefined && same(fromBirth(process.pid, birth), process);
  }

  /** The caller becomes the conversation's controller; it cannot name another. */
  public async register(socket: Socket, request: SeatRegistration): Promise<SeatBindingResult> {
    if (this.observers.available?.() === false)
      return this.refusal("seat_binding_helper_missing", 403, request.conversationId);
    if (
      !request.conversationId.trim() ||
      !HASH.test(request.nonceHash) ||
      !Number.isSafeInteger(request.harnessPid)
    )
      return this.refusal("seat_binding_invalid", 400, request.conversationId);
    const snapshot = await this.observers.socket(socket);
    if (snapshot === undefined) return this.refusal("seat_process_unproven", 403, request.conversationId);
    const controller = proc(snapshot.owner.pid, snapshot.owner.birth, snapshot.owner.kernelIdentity);
    if (request.harnessPid === controller.pid)
      return this.refusal("seat_binding_invalid", 400, request.conversationId);
    const birth = await this.observers.birth(request.harnessPid);
    if (birth === undefined) return this.refusal("seat_binding_invalid", 400, request.conversationId);
    const harness = fromBirth(request.harnessPid, birth);
    const pair = await this.observers.processes(controller.pid, harness.pid);
    const [observedController, observedHarness] = pair?.processes ?? [];
    if (observedController === undefined || observedHarness === undefined)
      return this.refusal("seat_process_unproven", 403, request.conversationId);
    if (
      !same(
        controller,
        proc(observedController.pid, observedController.birth, observedController.kernelIdentity),
      ) ||
      !same(harness, proc(observedHarness.pid, observedHarness.birth, observedHarness.kernelIdentity)) ||
      !(await this.alive(controller)) ||
      !(await this.alive(harness))
    )
      return this.refusal("seat_process_unproven", 403, request.conversationId);
    if (observedHarness.ppid !== controller.pid)
      return this.refusal("seat_harness_not_child", 403, request.conversationId);
    const existing = this.entries.get(request.conversationId);
    if (
      existing !== undefined &&
      !same(existing.controller, controller) &&
      (await this.alive(existing.controller))
    )
      return this.refusal("seat_binding_conflict", 409, request.conversationId);
    const refreshed =
      existing !== undefined &&
      same(existing.controller, controller) &&
      same(existing.harness, harness) &&
      existing.nonceHash === request.nonceHash;
    this.entries.set(request.conversationId, {
      controller,
      harness,
      nonceHash: request.nonceHash,
      depth: request.depth ?? 1,
      ...(refreshed && existing.claimant !== undefined ? { claimant: existing.claimant } : {}),
    });
    this.clearRefusal(request.conversationId);
    return { ok: true, role: "registered" };
  }

  /** Only the registered controller may withdraw its binding. */
  public async deregister(socket: Socket, conversationId: string): Promise<SeatBindingResult> {
    const entry = this.entries.get(conversationId);
    if (entry === undefined) return { ok: true, role: "registered" };
    const snapshot = await this.observers.socket(socket);
    if (snapshot === undefined) return this.refusal("seat_process_unproven", 403, conversationId);
    if (
      !same(entry.controller, proc(snapshot.owner.pid, snapshot.owner.birth, snapshot.owner.kernelIdentity))
    )
      return this.refusal("seat_binding_conflict", 409, conversationId);
    this.entries.delete(conversationId);
    return { ok: true, role: "registered" };
  }

  /** Whether this request's process may act for the conversation; a missing proof is a refusal. */
  public async admit(
    socket: Socket | undefined,
    input: { readonly conversationId: string | undefined; readonly claim: string | undefined },
  ): Promise<SeatBindingResult> {
    const result = await this.verify(socket, input);
    // Preparation release only. Run exactly the enforcing checks and retain
    // their diagnostics, but preserve the pre-enforcement admission behavior.
    if (!result.ok && this.mode === "observe") {
      const key = `${result.error}:${input.conversationId ?? ""}`;
      if (!this.observed.has(key)) {
        if (this.observed.size >= 256) this.observed.delete(this.observed.values().next().value!);
        this.observed.add(key);
        this.onObservation?.(result.error, input.conversationId);
      }
      this.lastRefusal = {
        error: result.error,
        recovery: seatBindingRecovery(result.error),
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      };
      return { ok: true, role: "observed" };
    }
    return result;
  }

  private async verify(
    socket: Socket | undefined,
    input: { readonly conversationId: string | undefined; readonly claim: string | undefined },
  ): Promise<SeatBindingResult> {
    if (this.observers.available?.() === false)
      return this.refusal("seat_binding_helper_missing", 403, input.conversationId);
    if (!input.conversationId?.trim())
      return this.refusal("seat_binding_conversation_required", 403, input.conversationId);
    const entry = this.entries.get(input.conversationId);
    if (entry === undefined) return this.refusal("seat_binding_required", 403, input.conversationId);
    if (socket === undefined) return this.refusal("seat_process_unproven", 403, input.conversationId);
    const snapshot = await this.observers.socket(socket);
    if (snapshot === undefined) return this.refusal("seat_process_unproven", 403, input.conversationId);
    if (!(await this.alive(entry.controller)) || !(await this.alive(entry.harness))) {
      this.entries.delete(input.conversationId);
      return this.refusal("seat_binding_stale", 403, input.conversationId);
    }
    const owner = proc(snapshot.owner.pid, snapshot.owner.birth, snapshot.owner.kernelIdentity);
    if (same(entry.controller, owner)) {
      this.clearRefusal(input.conversationId);
      return { ok: true, role: "controller" };
    }
    const parent = snapshot.ancestors[entry.depth];
    if (parent === undefined || !same(entry.harness, proc(parent.pid, parent.birth, parent.kernelIdentity)))
      return this.refusal("seat_bridge_not_registered", 403, input.conversationId);
    const claimed = createHash("sha256")
      .update(input.claim ?? "")
      .digest();
    if (!timingSafeEqual(claimed, Buffer.from(entry.nonceHash, "hex")))
      return this.refusal("seat_bridge_claim_invalid", 403, input.conversationId);
    if (entry.claimant !== undefined && !same(entry.claimant, owner) && (await this.alive(entry.claimant)))
      return this.refusal("seat_bridge_claimed", 409, input.conversationId);
    entry.claimant = owner;
    this.clearRefusal(input.conversationId);
    return { ok: true, role: "bridge" };
  }
}
