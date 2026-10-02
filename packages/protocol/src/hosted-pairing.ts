import { z } from "zod";
import { GatewayEncryptionCredentialSchema } from "./gateway-encryption.ts";

/** Public, Node-free client contract; account/control-plane implementation lives in clankie-ops. */
export const HostedMachineSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  hostId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,128}$/u)
    .nullable(),
  state: z.enum(["running", "asleep", "waking", "unavailable"]),
});
export type HostedMachine = z.infer<typeof HostedMachineSchema>;
export const HostedMachinesSchema = z.object({ machines: z.array(HostedMachineSchema) });
export const HostedPairAnswerSchema = z.object({
  version: z.literal(2),
  ephemeralPublicKey: z.string(),
  iv: z.string(),
  ciphertext: z.string(),
  signature: z.string(),
});
export const HostedPairRequestSchema = z
  .object({
    machineId: z.string().min(1),
    browserPublicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/u),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
  })
  .strict();
export const HostedPairResponseSchema = z.object({
  machine: HostedMachineSchema,
  ticketId: z.string(),
  bodyPairingKey: z.string(),
  answer: HostedPairAnswerSchema,
});

export function hostedOrigin(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Hosted URL must be an HTTPS origin (HTTP is loopback-only)");
  return url.origin;
}
/** Platform crypto stays injectable: native app keys need not be exported into JavaScript. */
export interface HostedPairExchange {
  publicKey: string;
  nonce: string;
  /** Verify Ed25519 over transcript BEFORE ECDH/HKDF/AES-GCM opening; reject on any failure. */
  open(input: {
    answer: z.infer<typeof HostedPairAnswerSchema>;
    bodyPairingKey: string;
    transcript: string;
    context: string;
  }): Promise<string>;
}
export function createHostedAccountClient(input: {
  origin: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
}) {
  const origin = hostedOrigin(input.origin),
    fetchImpl = input.fetchImpl ?? fetch;
  async function request(path: string, body?: unknown) {
    const response = await fetchImpl(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${input.accessToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result: unknown = await response.json();
    if (!response.ok)
      throw new Error(
        `Hosted account: ${z.object({ error: z.string() }).safeParse(result).data?.error ?? response.status}`,
      );
    return result;
  }
  return {
    async machines() {
      return HostedMachinesSchema.parse(await request("/fleet/v1/machines")).machines;
    },
    async wake(machine: HostedMachine) {
      return request("/fleet/v1/wake", { machineId: machine.id });
    },
    async pair(machine: HostedMachine, exchange: HostedPairExchange) {
      const result = HostedPairResponseSchema.parse(
        await request("/fleet/v1/pairing/offer", {
          machineId: machine.id,
          browserPublicKey: exchange.publicKey,
          nonce: exchange.nonce,
        }),
      );
      if (result.machine.id !== machine.id || result.machine.hostId !== machine.hostId || !machine.hostId)
        throw new Error("Hosted pairing machine mismatch");
      const domain = "clankie-hosted-pair-v2";
      const { answer } = result;
      const transcript = [
        domain,
        machine.hostId,
        result.ticketId,
        exchange.publicKey,
        exchange.nonce,
        answer.ephemeralPublicKey,
        answer.iv,
        answer.ciphertext,
      ].join("\n");
      const offer = z.object({ link: z.string(), expiresAtMs: z.number() }).parse(
        JSON.parse(
          await exchange.open({
            answer,
            bodyPairingKey: result.bodyPairingKey,
            transcript,
            context: `${domain}\n${machine.hostId}`,
          }),
        ),
      );
      if (offer.expiresAtMs <= Date.now()) throw new Error("Hosted pairing offer expired");
      const link = new URL(offer.link);
      const encryption = GatewayEncryptionCredentialSchema.parse(
        Object.fromEntries(new URLSearchParams(link.hash.slice(1))),
      );
      if (link.protocol !== "clankie:" || link.hostname !== "connect" || encryption.hostId !== machine.hostId)
        throw new Error("Invalid hosted pairing link");
      return { link: offer.link, encryption };
    },
  };
}
