import { randomBytes, createHash } from "node:crypto";
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
  gatewayStreamAad,
  type GatewayEnvelope,
  type GatewayEncryptionCredential,
  type GatewayPlainRequest,
  type GatewayPlainResponse,
} from "@clankie/protocol/gateway-encryption";
import { publicGatewayTargetFor } from "@clankie/protocol/public-gateway";
import { openGatewayBytes, openGatewayValue, sealGatewayBytes, sealGatewayValue } from "./sealed-values.ts";
import type { StoredPairingOffer } from "./pairing.ts";
import { OperatorConversationServiceRequestSchema, VOICE_CALL_PATH } from "@clankie/protocol";

const INTERACTIVE_OPERATIONS = new Set([
  "create",
  "fork",
  "reset",
  "close",
  "send",
  "cancel",
  "channel",
  "update_persona",
  "set_persona_role",
  "react",
  "close_seat",
  "spawn_seat",
  "move_seat",
  "terminal_control",
  "terminal_input",
  "publish_file",
]);

/** Classify after successful authenticated dispatch; decrypted content stays public. */
function authenticatedWork(method: string, path: string, body: string): boolean {
  if (method !== "POST") return false;
  if (path === "/v1/pairing/redeem" || path === "/v1/pairing/complete") return true;
  if (path !== "/operator/v1/dispatch") return false;
  try {
    const request = OperatorConversationServiceRequestSchema.parse(JSON.parse(body));
    if (request.op === "autonomy") return request.command.action !== "status";
    if (request.op === "connections") return request.command.action !== "list";
    return INTERACTIVE_OPERATIONS.has(request.op);
  } catch {
    return false;
  }
}

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

/**
 * An opened stream: the status to answer with (101 to go ahead), the device's
 * own authorization for the relay, and its record sealing, sequence by sequence.
 */
export interface GatewayStream {
  readonly status: number;
  readonly authorization?: string;
  seal(kind: number, payload: Uint8Array, sequence: number): Buffer;
  open(record: Uint8Array, sequence: number): { readonly kind: number; readonly payload: Buffer };
}

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

// Core helpers machine joins share with the doorway; kept importable from here.
export { openGatewayBytes, openGatewayValue, sealGatewayBytes, sealGatewayValue };

/** Encryption ends on the Mac, before the existing control and relay authorization. */
export class GatewayEncryptionHost {
  private readonly challenges = new Map<string, number>();
  private readonly hostId: string;
  private readonly wrappingKey: Uint8Array;
  private readonly onAuthenticatedRequest: ((isWork: boolean) => void) | undefined;
  public constructor(
    hostId: string,
    wrappingKey: Uint8Array,
    onAuthenticatedRequest?: (isWork: boolean) => void,
  ) {
    this.onAuthenticatedRequest = onAuthenticatedRequest;
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

  /** The envelope, its ticket and request; consumes the challenge, so it opens once. */
  private openEnvelope(body: string): {
    readonly envelope: GatewayEnvelope;
    readonly ticket: Ticket;
    readonly request: GatewayPlainRequest;
  } {
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
    return { envelope, ticket, request };
  }

  /**
   * Opens a sealed stream's first message (VUH-2761). Only a paired device's
   * call opens one; the caller connects it to the relay's call route with the
   * headers returned here, so the relay authorizes the call as it would a direct
   * one. Throws on anything else, before any local route sees it.
   */
  public async openStream(
    body: string,
    signal: AbortSignal,
    forward: (request: Request) => Promise<Response>,
  ): Promise<GatewayStream> {
    const { envelope, ticket, request } = this.openEnvelope(body);
    if (ticket.stage !== "device" || request.method !== "GET" || request.path !== VOICE_CALL_PATH)
      throw new Error("Invalid encrypted stream");
    const headers = new Headers(request.headers.map(({ name, value }): [string, string] => [name, value]));
    const identity = await forward(new Request("http://control/v1/devices/self", { headers, signal }));
    if (!identity.ok) return { status: identity.status, ...this.streamKeys(envelope, request) };
    const { deviceId } = (await identity.json()) as { deviceId?: unknown };
    if (deviceId !== ticket.subject) throw new Error("Wrong device");
    this.onAuthenticatedRequest?.(true);
    return {
      status: 101,
      authorization: headers.get("authorization") ?? "",
      ...this.streamKeys(envelope, request),
    };
  }

  private streamKeys(envelope: GatewayEnvelope, request: GatewayPlainRequest) {
    const key = Buffer.from(request.responseKey, "base64");
    return {
      seal: (kind: number, payload: Uint8Array, sequence: number): Buffer =>
        sealGatewayBytes(
          key,
          Buffer.concat([Buffer.of(kind), payload]),
          gatewayStreamAad(this.hostId, envelope, "down", sequence),
        ),
      open: (record: Uint8Array, sequence: number): { readonly kind: number; readonly payload: Buffer } => {
        const plain = openGatewayBytes(key, record, gatewayStreamAad(this.hostId, envelope, "up", sequence));
        if (plain.length === 0) throw new Error("Empty stream record");
        return { kind: plain[0]!, payload: plain.subarray(1) };
      },
    };
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
      const { envelope, ticket, request } = this.openEnvelope(body);
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
      if (response.ok)
        this.onAuthenticatedRequest?.(
          authenticatedWork(request.method, request.path, requestBody?.toString("utf8") ?? ""),
        );
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
