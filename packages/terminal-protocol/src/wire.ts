import { z } from "zod";

export const TERMINAL_PROTOCOL_VERSION = 1 as const;
export const MAX_TERMINAL_SEQUENCE = Number.MAX_SAFE_INTEGER;

const ProtocolVersionSchema = z.literal(TERMINAL_PROTOCOL_VERSION);
const OpaqueIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const RequestIdSchema = OpaqueIdSchema;
const TimestampSchema = z.string().datetime({ offset: true });
const SequenceSchema = z.number().int().nonnegative().max(MAX_TERMINAL_SEQUENCE);
const FrameSequenceSchema = z.number().int().positive().max(MAX_TERMINAL_SEQUENCE);
const CapabilityRevisionSchema = z.number().int().positive().max(MAX_TERMINAL_SEQUENCE);
const TextSchema = z.string().min(1).max(512);

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (value.endsWith("==")) return (alphabet.indexOf(value.at(-3)!) & 0b1111) === 0;
  if (value.endsWith("=")) return (alphabet.indexOf(value.at(-2)!) & 0b11) === 0;
  return true;
}

export const TerminalBytesSchema = z
  .string()
  .max(16 * 1024 * 1024)
  .refine(isCanonicalBase64, {
    message: "expected non-empty canonical base64",
  });

export const TerminalGeometrySchema = z
  .object({
    columns: z.number().int().positive().max(1_000),
    rows: z.number().int().positive().max(1_000),
  })
  .strict();
export type TerminalGeometry = z.infer<typeof TerminalGeometrySchema>;

export const TerminalDeviceScopeSchema = z.enum(["observe", "control"]);
export type TerminalDeviceScope = z.infer<typeof TerminalDeviceScopeSchema>;

const UniqueDeviceScopesSchema = z
  .array(TerminalDeviceScopeSchema)
  .min(1)
  .max(2)
  .superRefine((scopes, context) => {
    if (new Set(scopes).size !== scopes.length) {
      context.addIssue({ code: "custom", message: "device scopes must be unique" });
    }
  });

export const TerminalClientAttributionSchema = z
  .object({
    principalId: OpaqueIdSchema,
    deviceId: OpaqueIdSchema,
    clientInstanceId: OpaqueIdSchema,
  })
  .strict();
export type TerminalClientAttribution = z.infer<typeof TerminalClientAttributionSchema>;

export const TerminalCapabilitiesSchema = z
  .object({
    observe: z.literal(true),
    resume: z.boolean(),
    vtRestoreSnapshot: z.boolean(),
    controlLease: z.boolean(),
    input: z.boolean(),
    resize: z.boolean(),
  })
  .strict()
  .superRefine((capabilities, context) => {
    if ((capabilities.input || capabilities.resize) && !capabilities.controlLease) {
      context.addIssue({
        code: "custom",
        message: "input and resize require controlLease capability",
      });
    }
    if (capabilities.resume && !capabilities.vtRestoreSnapshot) {
      context.addIssue({
        code: "custom",
        message: "resume requires vtRestoreSnapshot capability",
      });
    }
  });
export type TerminalCapabilities = z.infer<typeof TerminalCapabilitiesSchema>;

export const TerminalClosureReasonSchema = z.enum([
  "exited",
  "signaled",
  "transport_lost",
  "terminated",
  "sequence_discontinuity",
]);
export type TerminalClosureReason = z.infer<typeof TerminalClosureReasonSchema>;

export const TerminalLifecycleSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("open") }).strict(),
  z
    .object({
      state: z.literal("closed"),
      sequence: FrameSequenceSchema,
      reason: TerminalClosureReasonSchema,
      exitCode: z.number().int().nullable(),
      signal: z.string().min(1).max(64).nullable(),
      closedAt: TimestampSchema,
    })
    .strict()
    .superRefine((lifecycle, context) => {
      if (lifecycle.reason === "exited" && lifecycle.exitCode === null) {
        context.addIssue({ code: "custom", path: ["exitCode"], message: "exited requires exitCode" });
      }
      if (lifecycle.reason === "exited" && lifecycle.signal !== null) {
        context.addIssue({ code: "custom", path: ["signal"], message: "exited cannot carry signal" });
      }
      if (lifecycle.reason === "signaled" && lifecycle.signal === null) {
        context.addIssue({ code: "custom", path: ["signal"], message: "signaled requires signal" });
      }
      if (lifecycle.reason === "signaled" && lifecycle.exitCode !== null) {
        context.addIssue({ code: "custom", path: ["exitCode"], message: "signaled cannot carry exitCode" });
      }
      if (
        (lifecycle.reason === "transport_lost" ||
          lifecycle.reason === "terminated" ||
          lifecycle.reason === "sequence_discontinuity") &&
        (lifecycle.exitCode !== null || lifecycle.signal !== null)
      ) {
        context.addIssue({
          code: "custom",
          message: "non-process closure cannot carry process exit details",
        });
      }
    }),
]);
export type TerminalLifecycle = z.infer<typeof TerminalLifecycleSchema>;

export const TerminalDiscoverySessionSchema = z
  .object({
    terminalId: OpaqueIdSchema,
    workerRunId: OpaqueIdSchema,
    title: z.string().min(1).max(256),
    source: z.enum(["runner_pty", "herdr", "tmux", "generic"]),
    geometry: TerminalGeometrySchema,
    lastSequence: SequenceSchema,
    lifecycle: TerminalLifecycleSchema,
    capabilities: TerminalCapabilitiesSchema,
    capabilitiesRevision: CapabilityRevisionSchema,
  })
  .strict()
  .superRefine((session, context) => {
    if (session.lifecycle.state === "closed" && session.lifecycle.sequence > session.lastSequence) {
      context.addIssue({
        code: "custom",
        path: ["lifecycle", "sequence"],
        message: "closure cannot exceed lastSequence",
      });
    }
  });
export type TerminalDiscoverySession = z.infer<typeof TerminalDiscoverySessionSchema>;

const ClientMessageBaseSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    requestId: RequestIdSchema,
  })
  .strict();

const AttributedClientMessageBaseSchema = ClientMessageBaseSchema.extend({
  attribution: TerminalClientAttributionSchema,
}).strict();

export const TerminalDiscoveryRequestSchema = ClientMessageBaseSchema.extend({
  type: z.literal("terminal.discover"),
  supportedProtocolVersions: z.tuple([ProtocolVersionSchema]),
  attribution: TerminalClientAttributionSchema,
}).strict();
export type TerminalDiscoveryRequest = z.infer<typeof TerminalDiscoveryRequestSchema>;

export const TerminalDiscoveryResponseSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    type: z.literal("terminal.discovery"),
    requestId: RequestIdSchema,
    grantedScopes: UniqueDeviceScopesSchema,
    sessions: z.array(TerminalDiscoverySessionSchema).max(10_000),
  })
  .strict();
export type TerminalDiscoveryResponse = z.infer<typeof TerminalDiscoveryResponseSchema>;

export const TerminalListSessionsRequestSchema = AttributedClientMessageBaseSchema.extend({
  type: z.literal("terminal.sessions.list"),
}).strict();
export type TerminalListSessionsRequest = z.infer<typeof TerminalListSessionsRequestSchema>;

export const TerminalListSessionsMessageSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    type: z.literal("terminal.sessions.listed"),
    requestId: RequestIdSchema,
    sessions: z.array(TerminalDiscoverySessionSchema).max(10_000),
  })
  .strict();
export type TerminalListSessionsMessage = z.infer<typeof TerminalListSessionsMessageSchema>;

export const TerminalGetCapabilitiesRequestSchema = AttributedClientMessageBaseSchema.extend({
  type: z.literal("terminal.capabilities.get"),
  terminalId: OpaqueIdSchema,
}).strict();
export type TerminalGetCapabilitiesRequest = z.infer<typeof TerminalGetCapabilitiesRequestSchema>;

export const TerminalCapabilitiesMessageSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    type: z.literal("terminal.capabilities"),
    requestId: RequestIdSchema,
    terminalId: OpaqueIdSchema,
    revision: CapabilityRevisionSchema,
    capabilities: TerminalCapabilitiesSchema,
  })
  .strict();
export type TerminalCapabilitiesMessage = z.infer<typeof TerminalCapabilitiesMessageSchema>;

export const TerminalCapabilitiesChangedMessageSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    type: z.literal("terminal.capabilities_changed"),
    terminalId: OpaqueIdSchema,
    subscriptionId: OpaqueIdSchema,
    revision: CapabilityRevisionSchema,
    capabilities: TerminalCapabilitiesSchema,
  })
  .strict();
export type TerminalCapabilitiesChangedMessage = z.infer<typeof TerminalCapabilitiesChangedMessageSchema>;

export const TerminalSubscribeRequestSchema = AttributedClientMessageBaseSchema.extend({
  type: z.literal("terminal.subscribe"),
  terminalId: OpaqueIdSchema,
}).strict();
export type TerminalSubscribeRequest = z.infer<typeof TerminalSubscribeRequestSchema>;

export const TerminalReplayCursorSchema = z
  .object({
    sequence: SequenceSchema,
  })
  .strict()
  .brand<"TerminalReplayCursor">();
export type TerminalReplayCursor = z.infer<typeof TerminalReplayCursorSchema>;

export const TerminalResumeRequestSchema = AttributedClientMessageBaseSchema.extend({
  type: z.literal("terminal.resume"),
  terminalId: OpaqueIdSchema,
  cursor: TerminalReplayCursorSchema,
}).strict();
export type TerminalResumeRequest = z.infer<typeof TerminalResumeRequestSchema>;

export const TerminalResyncRequestSchema = AttributedClientMessageBaseSchema.extend({
  type: z.literal("terminal.resync"),
  terminalId: OpaqueIdSchema,
  cursor: TerminalReplayCursorSchema,
  cause: z.enum(["gap", "manual", "reconnect"]),
}).strict();
export type TerminalResyncRequest = z.infer<typeof TerminalResyncRequestSchema>;

export const TerminalSubscribedMessageSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    type: z.literal("terminal.subscribed"),
    requestId: RequestIdSchema,
    terminalId: OpaqueIdSchema,
    subscriptionId: OpaqueIdSchema,
    cursor: TerminalReplayCursorSchema,
    initialDelivery: z.enum(["live", "snapshot", "replay"]),
    lifecycle: TerminalLifecycleSchema,
    capabilities: TerminalCapabilitiesSchema,
    capabilitiesRevision: CapabilityRevisionSchema,
  })
  .strict();
export type TerminalSubscribedMessage = z.infer<typeof TerminalSubscribedMessageSchema>;

export const TerminalSequenceBoundarySchema = z
  .object({
    afterSequence: SequenceSchema.max(MAX_TERMINAL_SEQUENCE - 1),
    nextSequence: FrameSequenceSchema,
    parserState: z.literal("quiescent"),
  })
  .strict()
  .superRefine((boundary, context) => {
    if (boundary.nextSequence !== boundary.afterSequence + 1) {
      context.addIssue({
        code: "custom",
        path: ["nextSequence"],
        message: "nextSequence must equal afterSequence + 1",
      });
    }
  });
export type TerminalSequenceBoundary = z.infer<typeof TerminalSequenceBoundarySchema>;

const StreamMessageBaseSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    terminalId: OpaqueIdSchema,
    subscriptionId: OpaqueIdSchema,
  })
  .strict();

export const TerminalSnapshotMessageSchema = StreamMessageBaseSchema.extend({
  type: z.literal("terminal.snapshot"),
  boundary: TerminalSequenceBoundarySchema,
  geometry: TerminalGeometrySchema,
  restore: z
    .object({
      format: z.literal("vt_restore_v1"),
      encoding: z.literal("base64"),
      data: TerminalBytesSchema,
    })
    .strict(),
  lifecycle: TerminalLifecycleSchema,
})
  .strict()
  .superRefine((snapshot, context) => {
    if (
      snapshot.lifecycle.state === "closed" &&
      snapshot.lifecycle.sequence > snapshot.boundary.afterSequence
    ) {
      context.addIssue({
        code: "custom",
        path: ["lifecycle", "sequence"],
        message: "snapshot closure must be included through its boundary",
      });
    }
  });
export type TerminalSnapshotMessage = z.infer<typeof TerminalSnapshotMessageSchema>;

export const TerminalOutputMessageSchema = StreamMessageBaseSchema.extend({
  type: z.literal("terminal.output"),
  sequence: FrameSequenceSchema,
  encoding: z.literal("base64"),
  data: TerminalBytesSchema,
}).strict();
export type TerminalOutputMessage = z.infer<typeof TerminalOutputMessageSchema>;

export const TerminalGeometryMessageSchema = StreamMessageBaseSchema.extend({
  type: z.literal("terminal.geometry"),
  sequence: FrameSequenceSchema,
  geometry: TerminalGeometrySchema,
  cause: z.enum(["pty", "control"]),
  operationId: OpaqueIdSchema.optional(),
})
  .strict()
  .superRefine((message, context) => {
    if (message.cause === "control" && message.operationId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["operationId"],
        message: "control geometry changes require operationId",
      });
    }
    if (message.cause === "pty" && message.operationId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["operationId"],
        message: "PTY geometry changes cannot carry operationId",
      });
    }
  });
export type TerminalGeometryMessage = z.infer<typeof TerminalGeometryMessageSchema>;

export const TerminalClosedMessageSchema = StreamMessageBaseSchema.extend({
  type: z.literal("terminal.closed"),
  sequence: FrameSequenceSchema,
  reason: TerminalClosureReasonSchema,
  exitCode: z.number().int().nullable(),
  signal: z.string().min(1).max(64).nullable(),
  closedAt: TimestampSchema,
})
  .strict()
  .superRefine((message, context) => {
    if (message.reason === "exited" && message.exitCode === null) {
      context.addIssue({ code: "custom", path: ["exitCode"], message: "exited requires exitCode" });
    }
    if (message.reason === "exited" && message.signal !== null) {
      context.addIssue({ code: "custom", path: ["signal"], message: "exited cannot carry signal" });
    }
    if (message.reason === "signaled" && message.signal === null) {
      context.addIssue({ code: "custom", path: ["signal"], message: "signaled requires signal" });
    }
    if (message.reason === "signaled" && message.exitCode !== null) {
      context.addIssue({ code: "custom", path: ["exitCode"], message: "signaled cannot carry exitCode" });
    }
    if (
      (message.reason === "transport_lost" ||
        message.reason === "terminated" ||
        message.reason === "sequence_discontinuity") &&
      (message.exitCode !== null || message.signal !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "non-process closure cannot carry process exit details",
      });
    }
  });
export type TerminalClosedMessage = z.infer<typeof TerminalClosedMessageSchema>;

export const TerminalStreamMessageSchema = z.discriminatedUnion("type", [
  TerminalSnapshotMessageSchema,
  TerminalOutputMessageSchema,
  TerminalGeometryMessageSchema,
  TerminalClosedMessageSchema,
]);
export type TerminalStreamMessage = z.infer<typeof TerminalStreamMessageSchema>;

export const TerminalResyncRequiredMessageSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    type: z.literal("terminal.resync_required"),
    terminalId: OpaqueIdSchema,
    subscriptionId: OpaqueIdSchema,
    requestedAfterSequence: SequenceSchema,
    availableFromSequence: FrameSequenceSchema,
    reason: z.enum(["replay_unavailable", "invalid_cursor", "server_reset"]),
    lifecycle: TerminalLifecycleSchema,
  })
  .strict();
export type TerminalResyncRequiredMessage = z.infer<typeof TerminalResyncRequiredMessageSchema>;

export const TerminalOwnerSchema = z
  .object({
    leaseId: OpaqueIdSchema,
    attribution: TerminalClientAttributionSchema,
    acquiredAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict()
  .superRefine((owner, context) => {
    if (Date.parse(owner.expiresAt) <= Date.parse(owner.acquiredAt)) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "expiresAt must be later than acquiredAt",
      });
    }
  });
export type TerminalOwner = z.infer<typeof TerminalOwnerSchema>;

export const TerminalOwnerStateMessageSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    type: z.literal("terminal.owner_state"),
    terminalId: OpaqueIdSchema,
    revision: z.number().int().positive().max(MAX_TERMINAL_SEQUENCE),
    owner: TerminalOwnerSchema.nullable(),
  })
  .strict();
export type TerminalOwnerStateMessage = z.infer<typeof TerminalOwnerStateMessageSchema>;

const LeaseTtlSchema = z.number().int().min(1_000).max(300_000);

export const TerminalLeaseRequestSchema = AttributedClientMessageBaseSchema.extend({
  type: z.literal("terminal.lease.request"),
  terminalId: OpaqueIdSchema,
  requestedTtlMs: LeaseTtlSchema,
}).strict();
export type TerminalLeaseRequest = z.infer<typeof TerminalLeaseRequestSchema>;

export const TerminalLeaseRenewRequestSchema = AttributedClientMessageBaseSchema.extend({
  type: z.literal("terminal.lease.renew"),
  terminalId: OpaqueIdSchema,
  leaseId: OpaqueIdSchema,
  requestedTtlMs: LeaseTtlSchema,
}).strict();
export type TerminalLeaseRenewRequest = z.infer<typeof TerminalLeaseRenewRequestSchema>;

export const TerminalLeaseReleaseRequestSchema = AttributedClientMessageBaseSchema.extend({
  type: z.literal("terminal.lease.release"),
  terminalId: OpaqueIdSchema,
  leaseId: OpaqueIdSchema,
}).strict();
export type TerminalLeaseReleaseRequest = z.infer<typeof TerminalLeaseReleaseRequestSchema>;

const LeaseServerBaseSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    terminalId: OpaqueIdSchema,
    requestId: RequestIdSchema,
  })
  .strict();

export const TerminalLeaseGrantMessageSchema = LeaseServerBaseSchema.extend({
  type: z.literal("terminal.lease.grant"),
  owner: TerminalOwnerSchema,
  ownerStateRevision: z.number().int().positive().max(MAX_TERMINAL_SEQUENCE),
}).strict();
export type TerminalLeaseGrantMessage = z.infer<typeof TerminalLeaseGrantMessageSchema>;

export const TerminalLeaseRenewedMessageSchema = LeaseServerBaseSchema.extend({
  type: z.literal("terminal.lease.renewed"),
  owner: TerminalOwnerSchema,
  ownerStateRevision: z.number().int().positive().max(MAX_TERMINAL_SEQUENCE),
}).strict();
export type TerminalLeaseRenewedMessage = z.infer<typeof TerminalLeaseRenewedMessageSchema>;

export const TerminalLeaseReleasedMessageSchema = LeaseServerBaseSchema.extend({
  type: z.literal("terminal.lease.released"),
  leaseId: OpaqueIdSchema,
  ownerStateRevision: z.number().int().positive().max(MAX_TERMINAL_SEQUENCE),
}).strict();
export type TerminalLeaseReleasedMessage = z.infer<typeof TerminalLeaseReleasedMessageSchema>;

export const TerminalLeaseExpiredMessageSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    type: z.literal("terminal.lease.expired"),
    terminalId: OpaqueIdSchema,
    leaseId: OpaqueIdSchema,
    expiredAt: TimestampSchema,
    ownerStateRevision: z.number().int().positive().max(MAX_TERMINAL_SEQUENCE),
  })
  .strict();
export type TerminalLeaseExpiredMessage = z.infer<typeof TerminalLeaseExpiredMessageSchema>;

export const TerminalLeaseRejectedMessageSchema = LeaseServerBaseSchema.extend({
  type: z.literal("terminal.lease.rejected"),
  operation: z.enum(["request", "renew", "release"]),
  reason: z.enum([
    "not_supported",
    "scope_denied",
    "already_owned",
    "lease_not_found",
    "lease_expired",
    "attribution_mismatch",
  ]),
  ownerStateRevision: z.number().int().nonnegative().max(MAX_TERMINAL_SEQUENCE),
}).strict();
export type TerminalLeaseRejectedMessage = z.infer<typeof TerminalLeaseRejectedMessageSchema>;

const OperationIdSchema = OpaqueIdSchema;

export const TerminalInputRequestSchema = AttributedClientMessageBaseSchema.extend({
  type: z.literal("terminal.input"),
  terminalId: OpaqueIdSchema,
  leaseId: OpaqueIdSchema,
  operationId: OperationIdSchema,
  encoding: z.literal("base64"),
  data: TerminalBytesSchema,
}).strict();
export type TerminalInputRequest = z.infer<typeof TerminalInputRequestSchema>;

export const TerminalResizeRequestSchema = AttributedClientMessageBaseSchema.extend({
  type: z.literal("terminal.resize"),
  terminalId: OpaqueIdSchema,
  leaseId: OpaqueIdSchema,
  operationId: OperationIdSchema,
  geometry: TerminalGeometrySchema,
}).strict();
export type TerminalResizeRequest = z.infer<typeof TerminalResizeRequestSchema>;

export const TerminalOperationAckMessageSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    type: z.literal("terminal.operation_ack"),
    requestId: RequestIdSchema,
    terminalId: OpaqueIdSchema,
    leaseId: OpaqueIdSchema,
    operationId: OperationIdSchema,
    operation: z.enum(["input", "resize"]),
    disposition: z.enum(["applied", "duplicate"]),
  })
  .strict();
export type TerminalOperationAckMessage = z.infer<typeof TerminalOperationAckMessageSchema>;

export const TerminalErrorMessageSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    type: z.literal("terminal.error"),
    requestId: RequestIdSchema.nullable(),
    terminalId: OpaqueIdSchema.nullable(),
    code: z.enum([
      "unsupported_version",
      "malformed_message",
      "not_found",
      "scope_denied",
      "capability_unavailable",
      "invalid_sequence",
      "lease_required",
      "lease_expired",
      "attribution_mismatch",
      "operation_conflict",
      "internal",
    ]),
    message: TextSchema,
    retryable: z.boolean(),
  })
  .strict();
export type TerminalErrorMessage = z.infer<typeof TerminalErrorMessageSchema>;

export const TerminalClientMessageSchema = z.discriminatedUnion("type", [
  TerminalDiscoveryRequestSchema,
  TerminalListSessionsRequestSchema,
  TerminalGetCapabilitiesRequestSchema,
  TerminalSubscribeRequestSchema,
  TerminalResumeRequestSchema,
  TerminalResyncRequestSchema,
  TerminalLeaseRequestSchema,
  TerminalLeaseRenewRequestSchema,
  TerminalLeaseReleaseRequestSchema,
  TerminalInputRequestSchema,
  TerminalResizeRequestSchema,
]);
export type TerminalClientMessage = z.infer<typeof TerminalClientMessageSchema>;

export const TerminalServerMessageSchema = z.discriminatedUnion("type", [
  TerminalDiscoveryResponseSchema,
  TerminalListSessionsMessageSchema,
  TerminalCapabilitiesMessageSchema,
  TerminalCapabilitiesChangedMessageSchema,
  TerminalSubscribedMessageSchema,
  TerminalSnapshotMessageSchema,
  TerminalOutputMessageSchema,
  TerminalGeometryMessageSchema,
  TerminalClosedMessageSchema,
  TerminalResyncRequiredMessageSchema,
  TerminalOwnerStateMessageSchema,
  TerminalLeaseGrantMessageSchema,
  TerminalLeaseRenewedMessageSchema,
  TerminalLeaseReleasedMessageSchema,
  TerminalLeaseExpiredMessageSchema,
  TerminalLeaseRejectedMessageSchema,
  TerminalOperationAckMessageSchema,
  TerminalErrorMessageSchema,
]);
export type TerminalServerMessage = z.infer<typeof TerminalServerMessageSchema>;

export const TerminalWireMessageSchema = z.union([TerminalClientMessageSchema, TerminalServerMessageSchema]);
export type TerminalWireMessage = z.infer<typeof TerminalWireMessageSchema>;

export type TerminalSequenceDisposition = "apply" | "duplicate" | "gap";
export type TerminalCapabilitiesRevisionDisposition = "apply" | "stale";

/**
 * Capability payloads are complete values. Establish state from the atomic
 * subscribed baseline, then apply only pushes with a strictly greater revision.
 */
export function classifyTerminalCapabilitiesRevision(
  lastAppliedRevision: number,
  receivedRevision: number,
): TerminalCapabilitiesRevisionDisposition {
  if (!CapabilityRevisionSchema.safeParse(lastAppliedRevision).success) {
    throw new RangeError("lastAppliedRevision must be a positive safe integer");
  }
  if (!CapabilityRevisionSchema.safeParse(receivedRevision).success) {
    throw new RangeError("receivedRevision must be a positive safe integer");
  }
  return receivedRevision > lastAppliedRevision ? "apply" : "stale";
}

/**
 * The only v1 receive rule: apply exactly last+1, discard <= last as a
 * duplicate, and stop applying plus request resync for anything greater.
 */
export function classifyTerminalSequence(
  lastAppliedSequence: number,
  receivedSequence: number,
): TerminalSequenceDisposition {
  if (!SequenceSchema.safeParse(lastAppliedSequence).success) {
    throw new RangeError("lastAppliedSequence must be a non-negative safe integer");
  }
  if (!FrameSequenceSchema.safeParse(receivedSequence).success) {
    throw new RangeError("receivedSequence must be a positive safe integer");
  }
  if (receivedSequence <= lastAppliedSequence) return "duplicate";
  if (receivedSequence === lastAppliedSequence + 1) return "apply";
  return "gap";
}
