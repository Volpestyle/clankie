import { z } from "zod";
import { MachineAccessLevelSchema } from "./machine-access.ts";

/** Public body/client contract; hosted gateway routing is implemented in clankie-ops. */
export const MACHINE_JOIN_OUTPUT_CHAR_MAX = 8192;
export const MACHINE_JOIN_SCREEN_OUTPUT_CHAR_MAX = 65536;
/** JSON byte budget before AES/base64; stays within the existing 1.5M wire cap. */
export const MACHINE_JOIN_RESULT_BATCH_BYTES_MAX = 750000;
export const MACHINE_JOIN_START_PATH = "/v1/machine-joins/start";
export const MACHINE_JOIN_STATUS_PATH = "/v1/machine-joins/status";
export const MACHINE_JOIN_APPROVE_PATH = "/v1/machine-joins/approve";
export const MACHINE_JOIN_CHALLENGE_PATH = "/v1/joined-machines/challenge";
export const MACHINE_JOIN_CHANNEL_PATH = "/v1/joined-machines/channel";
export const MACHINE_JOIN_LEAVE_PATH = "/v1/joined-machines/leave";
/** Machine bootstrap carries metadata; channel/leave have their own authenticated envelopes. */
export function isMachineJoinTransportRoute(method: string, path: string): boolean {
  return (
    method === "POST" &&
    [
      MACHINE_JOIN_START_PATH,
      MACHINE_JOIN_STATUS_PATH,
      MACHINE_JOIN_CHALLENGE_PATH,
      MACHINE_JOIN_CHANNEL_PATH,
      MACHINE_JOIN_LEAVE_PATH,
    ].includes(path)
  );
}
export const MachineJoinIdSchema = z.string().uuid();
export const JoinedMachineIdSchema = z
  .string()
  .regex(/^join-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u);
export const MachineJoinSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
export const MachineJoinTokenSchema = z.string().regex(/^clankie_join_[A-Za-z0-9_-]{43}$/u);
/** Local owned-child controls: metadata and stop only. Never a consent or input grant. */
export const MachineJoinLocalScreenCommandSchema = z.strictObject({
  id: z.string().uuid(),
  action: z.enum(["screen_status", "screen_stop"]),
});
export const MachineJoinLocalScreenStatusSchema = z.strictObject({
  available: z.boolean(),
  busy: z.boolean(),
  allowInput: z.boolean(),
  inputReady: z.boolean(),
  outcome: z.enum(["status", "released", "held", "unavailable"]),
  lease: z
    .strictObject({
      conversationId: z.string().min(1).max(512),
      expiresAt: z.number().int().nonnegative(),
      state: z.enum(["active", "recovery_required"]),
    })
    .nullable(),
});
export const MachineJoinEventSchema = z.discriminatedUnion("event", [
  z.strictObject({
    event: z.literal("approval"),
    code: MachineJoinSecretSchema,
    expiresAt: z.string().datetime(),
  }),
  z.strictObject({ event: z.literal("joined"), machineId: JoinedMachineIdSchema }),
  z.strictObject({
    event: z.literal("screen"),
    id: z.string().uuid(),
    result: MachineJoinLocalScreenStatusSchema,
  }),
  z.strictObject({ event: z.literal("finished"), state: z.enum(["left", "revoked"]) }),
]);
const directory = z.string().min(1).max(4096);
export const MachineJoinStartSchema = z
  .object({
    name: z.string().min(1).max(100),
    platform: z.enum(["darwin", "win32", "linux"]),
    directories: z.array(directory).max(32),
    claimSecret: MachineJoinSecretSchema,
    approvalHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export const MachineJoinTicketSchema = z
  .object({
    joinId: MachineJoinIdSchema,
    expiresAt: z.string().datetime(),
  })
  .strict();
export const MachineJoinApprovalSchema = z
  .object({
    code: MachineJoinSecretSchema,
    accessLevel: MachineAccessLevelSchema,
    directories: z.array(directory).max(32),
  })
  .strict();
export const MachineJoinApprovalResultSchema = z
  .object({ ok: z.literal(true), machineId: JoinedMachineIdSchema, accessLevel: MachineAccessLevelSchema })
  .strict();
export const MachineJoinLeaseSchema = z
  .object({
    machineId: JoinedMachineIdSchema,
    token: MachineJoinTokenSchema,
    accessLevel: MachineAccessLevelSchema,
    directories: z.array(directory).max(32),
  })
  .strict();
export const MachineJoinStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending") }).strict(),
  z.object({ state: z.literal("approved"), sealedLease: z.string().max(1_500_000) }).strict(),
  z.object({ state: z.enum(["expired", "revoked"]) }).strict(),
]);
export const JoinedMachinePolicySchema = z
  .object({
    machineId: JoinedMachineIdSchema,
    accessLevel: MachineAccessLevelSchema,
    directories: z.array(directory).max(32),
  })
  .strict();
export const JoinedMachineOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("workers"),
      directory,
      request: z.string().min(1).max(MACHINE_JOIN_OUTPUT_CHAR_MAX),
    })
    .strict(),
  z
    .object({
      kind: z.literal("shell"),
      directory,
      command: z.string().min(1).max(MACHINE_JOIN_OUTPUT_CHAR_MAX),
    })
    .strict(),
  z
    .object({ kind: z.literal("screen"), request: z.string().min(1).max(MACHINE_JOIN_OUTPUT_CHAR_MAX) })
    .strict(),
]);
export const JoinedMachineRequestSchema = z
  .object({ id: z.string().uuid(), operation: JoinedMachineOperationSchema })
  .strict();
export const JoinedMachineResultSchema = z
  .object({
    id: z.string().uuid(),
    ok: z.boolean(),
    output: z.string().max(MACHINE_JOIN_OUTPUT_CHAR_MAX).optional(),
    screenOutput: z.string().max(MACHINE_JOIN_SCREEN_OUTPUT_CHAR_MAX).optional(),
    truncated: z.boolean().optional(),
    error: z
      .enum([
        "machine_access_refused",
        "directory_refused",
        "operation_unavailable",
        "operation_failed",
        "revoked",
      ])
      .optional(),
  })
  .strict();
export const JoinedMachinePollSchema = z
  .object({ results: z.array(JoinedMachineResultSchema).max(16) })
  .strict();
export const JoinedMachineBatchSchema = z
  .object({ policy: JoinedMachinePolicySchema, requests: z.array(JoinedMachineRequestSchema).max(16) })
  .strict();
export type MachineJoinStart = z.infer<typeof MachineJoinStartSchema>;
export type MachineJoinLease = z.infer<typeof MachineJoinLeaseSchema>;
export type JoinedMachinePolicy = z.infer<typeof JoinedMachinePolicySchema>;
export type JoinedMachineOperation = z.infer<typeof JoinedMachineOperationSchema>;
export type JoinedMachineRequest = z.infer<typeof JoinedMachineRequestSchema>;
export type JoinedMachineResult = z.infer<typeof JoinedMachineResultSchema>;

export const MachineJoinChallengeSchema = z.object({ challenge: MachineJoinSecretSchema }).strict();
export const MachineJoinEnvelopeSchema = z
  .object({
    machineId: JoinedMachineIdSchema,
    challenge: MachineJoinSecretSchema,
    requestId: z.string().uuid(),
    sealedRequest: z.string().min(1).max(1_500_000),
  })
  .strict();
export const MachineJoinPayloadSchema = z
  .object({
    responseSecret: MachineJoinSecretSchema,
    op: z.enum(["poll", "leave"]),
    results: JoinedMachinePollSchema.shape.results,
  })
  .strict();
export const machineJoinLeaseAad = (joinId: string): string => `clankie-machine-lease-v1:${joinId}`;
export const machineJoinExchangeAad = (
  direction: "request" | "response",
  machineId: string,
  requestId: string,
  challenge: string,
): string => `clankie-machine-${direction}-v1:${machineId}:${requestId}:${challenge}`;
