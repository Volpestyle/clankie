import { isHostedCustomerWork } from "./hosted-heartbeat.ts";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import { PUBLIC_GATEWAY_ENCRYPTION_PROVIDER_ID, type CredentialStore } from "@clankie/credential-broker";
import {
  GATEWAY_CHALLENGE_PATH,
  GATEWAY_ENCRYPTED_PATH,
  GATEWAY_PUSH_AUTHORIZE_PATH,
  GatewayEnvelopeSchema,
  GatewayPushIdentitySchema,
  GatewayEncryptionCredentialSchema,
  GatewayPlainRequestSchema,
  gatewayRequestAad,
  gatewayResponseAad,
  type GatewayEncryptionCredential,
  type GatewayPlainResponse,
} from "@clankie/protocol/gateway-encryption";
import { publicGatewayTargetFor } from "@clankie/protocol/public-gateway";
import type { StoredPairingOffer } from "./pairing.ts";

const TicketSchema = z
  .object({
    key: GatewayEncryptionCredentialSchema.shape.key,
    subject: z.string().min(1),
    stage: z.enum(["offer", "pending", "device"]),
    completionHash: z.string().optional(),
    expiresAt: z.number().int().positive(),
  })
  .strict();
type Ticket = z.infer<typeof TicketSchema>;

/** The broker owns the wrapping key; rotating it invalidates every old ticket. */
export async function loadGatewayEncryptionKey(store: CredentialStore): Promise<Buffer> {
  const existing = await store.get(PUBLIC_GATEWAY_ENCRYPTION_PROVIDER_ID);
  if (existing !== undefined) {
    if (existing.type !== "api" || !/^[a-f0-9]{64}$/u.test(existing.key))
      throw new Error("Invalid gateway encryption key");
    return Buffer.from(existing.key, "hex");
  }
  const key = randomBytes(32);
  await store.set(PUBLIC_GATEWAY_ENCRYPTION_PROVIDER_ID, { type: "api", key: key.toString("hex") });
  return key;
}

export function sealGatewayValue(key: Uint8Array, plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  return Buffer.concat([iv, cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]).toString(
    "base64",
  );
}
export function openGatewayValue(key: Uint8Array, sealed: string, aad: string): string {
  const bytes = Buffer.from(sealed, "base64");
  if (bytes.length < 28 || bytes.toString("base64") !== sealed) throw new Error("Invalid encrypted record");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8");
}

/** Encryption ends on the Mac, before the existing control and relay authorization. */
export class GatewayEncryptionHost {
  private readonly challenges = new Map<string, number>();
  private readonly hostId: string;
  private readonly wrappingKey: Uint8Array;
  private readonly onCustomerWork: (() => void) | undefined;
  public constructor(hostId: string, wrappingKey: Uint8Array, onCustomerWork?: () => void) {
    this.onCustomerWork = onCustomerWork;
    this.hostId = hostId;
    this.wrappingKey = wrappingKey;
  }

  public pairingCredential(offer: StoredPairingOffer): GatewayEncryptionCredential {
    const key = randomBytes(32).toString("base64");
    return {
      hostId: this.hostId,
      key,
      ticket: this.ticket({
        key,
        subject: offer.offerHash,
        stage: "offer",
        expiresAt: Date.parse(offer.expiresAt),
      }),
    };
  }

  private ticket(value: Ticket): string {
    return sealGatewayValue(
      this.wrappingKey,
      JSON.stringify(value),
      `clankie-gateway-ticket-v1:${this.hostId}`,
    );
  }

  public async handle(
    path: string,
    body: string,
    signal: AbortSignal,
    forward: (request: Request) => Promise<Response>,
  ): Promise<Response> {
    if (path === GATEWAY_CHALLENGE_PATH) {
      const now = Date.now();
      for (const [challenge, expires] of this.challenges)
        if (expires <= now) this.challenges.delete(challenge);
      if (this.challenges.size >= 4096) return Response.json({ error: "encryption_busy" }, { status: 429 });
      const challenge = randomBytes(32).toString("hex");
      this.challenges.set(challenge, now + 60_000);
      return Response.json({ version: 1, challenge }, { headers: { "cache-control": "no-store" } });
    }
    if (path !== GATEWAY_ENCRYPTED_PATH && path !== GATEWAY_PUSH_AUTHORIZE_PATH)
      return Response.json({ error: "encryption_required" }, { status: 426 });
    try {
      const envelope = GatewayEnvelopeSchema.parse(JSON.parse(body));
      const ticket = TicketSchema.parse(
        JSON.parse(
          openGatewayValue(this.wrappingKey, envelope.ticket, `clankie-gateway-ticket-v1:${this.hostId}`),
        ),
      );
      if (ticket.expiresAt <= Date.now()) throw new Error("Expired encryption ticket");
      const plaintext = openGatewayValue(
        Buffer.from(ticket.key, "base64"),
        envelope.sealed,
        gatewayRequestAad(this.hostId, envelope),
      );
      const request = GatewayPlainRequestSchema.parse(JSON.parse(plaintext));
      const expires = this.challenges.get(envelope.challenge);
      // Synchronous consume before any await: duplicate concurrent requests cannot dispatch twice.
      this.challenges.delete(envelope.challenge);
      if (expires === undefined || expires <= Date.now()) throw new Error("Invalid encryption challenge");
      if (
        path === GATEWAY_PUSH_AUTHORIZE_PATH &&
        (ticket.stage !== "device" || request.path !== "/v1/devices/self" || request.method !== "GET")
      )
        throw new Error("Invalid push proof");
      const target = publicGatewayTargetFor(request.method, request.path);
      if (
        target === undefined ||
        request.path.startsWith("/v1/gateway/") ||
        request.path === "/v1/hooks/linear"
      )
        throw new Error("Invalid encrypted route");
      const headers = new Headers(request.headers.map(({ name, value }): [string, string] => [name, value]));
      const requestBody =
        request.bodyBase64 === undefined ? undefined : Buffer.from(request.bodyBase64, "base64");
      let response: Response | undefined;
      let nextTicket: string | undefined;
      let nextKey: string | undefined;
      if (ticket.stage === "offer") {
        if (request.path !== "/v1/pairing/redeem" || request.method !== "POST")
          throw new Error("Pairing required");
        const capability = JSON.parse(requestBody?.toString() ?? "{}") as { offerSecret?: unknown };
        if (
          typeof capability.offerSecret !== "string" ||
          createHash("sha256").update(capability.offerSecret).digest("hex") !== ticket.subject
        )
          throw new Error("Wrong pairing offer");
      } else if (ticket.stage === "pending") {
        if (request.path !== "/v1/pairing/complete" || request.method !== "POST")
          throw new Error("Pairing completion required");
        const completion = JSON.parse(requestBody?.toString() ?? "{}") as { completionToken?: unknown };
        if (
          typeof completion.completionToken !== "string" ||
          createHash("sha256").update(completion.completionToken).digest("hex") !== ticket.completionHash
        )
          throw new Error("Wrong pending completion");
      } else {
        if (request.path.startsWith("/v1/pairing/")) throw new Error("Already paired");
        const identityResponse = await forward(
          new Request("http://control/v1/devices/self", { headers, signal }),
        );
        if (!identityResponse.ok) response = identityResponse;
        else {
          const identity = (await identityResponse.json()) as { deviceId?: unknown };
          if (identity.deviceId !== ticket.subject) throw new Error("Wrong device");
        }
      }
      // Authorization, grant checks, redaction and mid-tail revocation remain local API responsibilities.
      response ??= await forward(
        new Request(`http://${target}${request.path}`, {
          method: request.method,
          headers,
          signal,
          ...(requestBody === undefined ? {} : { body: requestBody }),
        }),
      );
      if (
        response.ok &&
        isHostedCustomerWork(request.method, request.path, requestBody?.toString("utf8") ?? "")
      )
        this.onCustomerWork?.();
      if (
        response.ok &&
        ["/v1/pairing/redeem", "/v1/pairing/complete", "/v1/devices/self/session/refresh"].includes(
          request.path,
        )
      ) {
        const result = (await response.clone().json()) as {
          deviceId?: string;
          completionToken?: string;
          expiresAt?: string;
          sessionExpiresAt?: string;
        };
        const subject = result.deviceId ?? ticket.subject;
        if (ticket.stage === "pending" && subject !== ticket.subject) throw new Error("Wrong pending device");
        const expiresAt = Date.parse(result.sessionExpiresAt ?? result.expiresAt ?? "");
        if (!Number.isFinite(expiresAt)) throw new Error("Invalid ticket expiry");
        nextKey = request.path === "/v1/pairing/redeem" ? ticket.key : randomBytes(32).toString("base64");
        nextTicket = this.ticket({
          key: nextKey,
          subject,
          stage: request.path === "/v1/pairing/redeem" ? "pending" : "device",
          ...(result.completionToken === undefined
            ? {}
            : { completionHash: createHash("sha256").update(result.completionToken).digest("hex") }),
          expiresAt,
        });
      }
      if (path === GATEWAY_PUSH_AUTHORIZE_PATH) {
        if (ticket.stage !== "device" || request.path !== "/v1/devices/self" || request.method !== "GET")
          throw new Error("Invalid push proof");
        // This intentional projection is delivery metadata, never names, bearer or application content.
        if (!response.ok) return Response.json({ error: "device_auth_required" }, { status: 401 });
        return Response.json(GatewayPushIdentitySchema.parse(await response.json()));
      }
      const source = response;
      let sequence = 0;
      const responseKey = Buffer.from(request.responseKey, "base64");
      const hostId = this.hostId;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const emit = (record: GatewayPlainResponse): void => {
            const sealed = sealGatewayValue(
              responseKey,
              JSON.stringify(record),
              gatewayResponseAad(hostId, envelope, sequence++),
            );
            controller.enqueue(Buffer.from(`${JSON.stringify({ sealed })}\n`));
          };
          try {
            emit({
              kind: "start",
              status: source.status,
              headers: Array.from(source.headers, ([name, value]) => ({ name, value })).filter((h) =>
                [
                  "content-type",
                  "cache-control",
                  "retry-after",
                  "content-disposition",
                  "x-content-type-options",
                ].includes(h.name),
              ),
              ...(nextTicket === undefined ? {} : { ticket: nextTicket, key: nextKey }),
            });
            const reader = source.body?.getReader();
            let total = 0;
            while (reader !== undefined) {
              const item = await reader.read();
              if (item.done) break;
              total += item.value.length;
              if (total > 16 * 1024 * 1024) throw new Error("Encrypted response too large");
              for (let offset = 0; offset < item.value.length; offset += 24 * 1024)
                emit({
                  kind: "chunk",
                  bodyBase64: Buffer.from(item.value.subarray(offset, offset + 24 * 1024)).toString("base64"),
                });
            }
            emit({ kind: "end" });
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
        cancel() {
          void source.body?.cancel().catch(() => undefined);
        },
      });
      return new Response(stream, {
        headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
      });
    } catch {
      return Response.json({ error: "invalid_encrypted_request" }, { status: 401 });
    }
  }
}
