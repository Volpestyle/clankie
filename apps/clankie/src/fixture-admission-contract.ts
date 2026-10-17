import { createHash } from "node:crypto";
import { z } from "zod";
import type { NativeSocketProcess } from "./local-fleet-process.ts";

export const FIXTURE_VERIFY_PATH = "/v1/fixture-admission/verify";
export async function readFixtureJson(request: Request, limit = 64_000): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Fixture JSON body required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("Oversized fixture JSON");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}
export const fixtureDigest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const lifetime = z.object({ pid: z.number().int().positive(), start: z.string().min(1) }).strict();
const birth = z.tuple([z.string().regex(/^\d+$/u), z.string().regex(/^\d+$/u)]);
const FixtureObservationSchema = z
  .object({
    schemaVersion: z.literal(1),
    owner: z
      .object({
        pid: z.number().int().positive(),
        uid: z.number().int().nonnegative(),
        birth,
        socket: z.string().min(1),
        kernelIdentity: z.string().optional(),
      })
      .strict(),
    ancestors: z
      .array(
        z
          .object({
            pid: z.number().int().positive(),
            ppid: z.number().int().nonnegative(),
            birth,
            kernelIdentity: z.string().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(128),
  })
  .strict();
export type FixtureObservation = NativeSocketProcess;
export const FixtureIssueSchema = z
  .object({
    requestId: z.string().uuid(),
    receiptId: z.string().uuid(),
    assurance: z.literal("host-seat/v1"),
  })
  .strict();
export const FixtureReadSchema = z
  .object({
    ticketId: z.string().uuid(),
    bindingHash: z.string().regex(/^[a-f0-9]{64}$/u),
    requestId: z.string().uuid(),
    receiptId: z.string().uuid(),
    claimId: z.string().uuid(),
  })
  .strict();
export const FixtureVerifySchema = FixtureReadSchema.extend({
  action: z.enum(["claim", "consume", "status"]),
  fixtureId: z.string().uuid(),
  callbackNonce: z.string().uuid(),
  observation: FixtureObservationSchema,
}).strict();
export const fixtureOrigin = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      !!url.port &&
      !["4310", "4321"].includes(url.port)
    );
  } catch {
    return false;
  }
}, "Private fixture loopback origin required");
export const FixtureDescriptorSchema = z
  .object({
    version: z.literal(1),
    fixtureId: z.string().uuid(),
    root: z.string().min(1),
    origin: fixtureOrigin,
    relayOrigin: fixtureOrigin,
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    storeId: z.string().min(1),
    storeDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    helperDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    process: lifetime,
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type FixtureDescriptor = z.infer<typeof FixtureDescriptorSchema>;
