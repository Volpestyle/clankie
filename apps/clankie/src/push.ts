import { randomUUID } from "node:crypto";
import type {
  DevicePushBinding,
  DevicePushRequest,
  DeviceRecord,
  PublicGatewayPushWakeFrame,
  PublicGatewayPushWakeResultFrame,
} from "@clankie/protocol";

/**
 * Delivery of a message that is already written (ADR 0159).
 *
 * This dispatcher decides nothing about what Clankie says or when he says it:
 * a durable captain or agent message has landed, and some device that
 * authorized delivery is asleep. It carries metadata only — device,
 * conversation, and the registration version the gateway matches against — and
 * never the text, which is why it can sit this far from the conversation.
 */

export type PushWakeStatus = PublicGatewayPushWakeResultFrame["status"];
export type PushWakeRequest = Omit<PublicGatewayPushWakeFrame, "schemaVersion" | "kind">;

/** The outbound half, so the dispatcher never knows about sockets or gateways. */
export interface PushWakeSender {
  sendPushWake(request: PushWakeRequest): Promise<PushWakeStatus>;
}

export interface PushDispatcherOptions {
  /** The live device projection, read at send time rather than at notify time. */
  readonly devices: () => Iterable<DeviceRecord>;
  readonly sender: PushWakeSender;
  /**
   * Records that a binding the gateway no longer honours is gone. Called only
   * with the exact binding that was sent, so a newer one cannot be cleared.
   */
  readonly clearBinding: (deviceId: string, binding: DevicePushBinding) => Promise<void>;
  /** How long repeats for one device and conversation merge into one wake. */
  readonly coalesceMs?: number;
  /** Ceiling on scheduled wakes; past it new pairs are dropped, never queued. */
  readonly maxPending?: number;
  readonly logger?: { warn(fields: Record<string, unknown>, message: string): void };
  readonly uuid?: () => string;
}

export interface PushDispatcher {
  /** Never throws and never awaits: the conversation write must not wait on delivery. */
  notify(conversationId: string): void;
  close(): void;
}

const DEFAULT_COALESCE_MS = 2_000;
const DEFAULT_MAX_PENDING = 256;

/** A device is woken only while it is active, granted chat, and asking for delivery. */
function deliverable(record: DeviceRecord): record is DeviceRecord & { push: DevicePushRequest } {
  return record.status === "active" && record.grants.chat && record.push?.enabled === true;
}

export function createPushDispatcher(options: PushDispatcherOptions): PushDispatcher {
  const coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  const uuid = options.uuid ?? randomUUID;
  const pending = new Map<string, NodeJS.Timeout>();
  let closed = false;

  const wake = (deviceId: string, conversationId: string): void => {
    // Re-read the projection here, not at notify time: a device revoked, or
    // un-granted, or that disabled delivery while the wake was coalescing must
    // not be woken.
    const record = [...options.devices()].find((candidate) => candidate.deviceId === deviceId);
    if (record === undefined || !deliverable(record)) return;
    // The record carries the state as well as the version; only the version
    // crosses to the gateway, which is what it matches its own row against.
    const binding: DevicePushBinding = {
      registrationId: record.push.registrationId,
      sequence: record.push.sequence,
    };

    void options.sender
      .sendPushWake({ wakeId: uuid(), deviceId, conversationId, ...binding })
      .then(async (status) => {
        if (status === "sent" || status === "throttled" || status === "unavailable") return;
        if (status === "rejected") return;
        // The gateway no longer has this binding. Clearing is conditional on the
        // exact version that was sent, so an acknowledgement that lost a race
        // with a newer registration cannot take it away.
        await options.clearBinding(deviceId, binding);
      })
      .catch((error: unknown) => {
        options.logger?.warn(
          { deviceId, conversationId, error: error instanceof Error ? error.name : "UnknownError" },
          "push wake could not be delivered",
        );
      });
  };

  return {
    notify(conversationId) {
      if (closed) return;
      for (const record of options.devices()) {
        if (!deliverable(record)) continue;
        const key = `${record.deviceId}\u0000${conversationId}`;
        // A burst on one thread is one wake: the device fetches the thread, so
        // the second notification would carry nothing the first did not.
        if (pending.has(key)) continue;
        if (pending.size >= maxPending) {
          options.logger?.warn({ conversationId }, "push wake dropped: too many pending wakes");
          continue;
        }
        const deviceId = record.deviceId;
        const timer = setTimeout(() => {
          pending.delete(key);
          wake(deviceId, conversationId);
        }, coalesceMs);
        timer.unref?.();
        pending.set(key, timer);
      }
    },

    close() {
      closed = true;
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    },
  };
}
