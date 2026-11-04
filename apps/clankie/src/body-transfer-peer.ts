import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  BODY_TRANSFER_PEER_PATH,
  BodyTransferIdRequestSchema,
  BodyTransferPeerDescriptorSchema,
  BodyTransferPeerEnvelopeSchema,
  BodyTransferPeerPayloadSchema,
  BodyTransferPeerTicketSchema,
  type BodyTransferPeerDescriptor,
  type BodyTransferPeerWitness,
} from "@clankie/protocol/body-transfer";
import { readPrivateJson, writePrivateJson } from "../../tui/bin/update-files.ts";
import { openGatewayValue, sealGatewayValue } from "./sealed-values.ts";

const ticketKey = (secret: string) => createHash("sha256").update(`clankie-body-peer-v2:${secret}`).digest();
const aad = (direction: string, ticketId: string, requestId: string) =>
  `clankie-body-peer-${direction}-v2:${ticketId}:${requestId}`;
/** Short-lived read-only metadata capabilities, minted only through an owner route. */
export class BodyTransferPeers {
  private readonly directory: string;
  constructor(state: string) {
    this.directory = join(state, "transfer", "peer-tickets");
  }
  prepare(input: unknown) {
    const { transferId } = BodyTransferIdRequestSchema.parse(input);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    let active = 0;
    for (const name of readdirSync(this.directory)) {
      if (!/^[a-f0-9-]{36}\.json$/u.test(name)) continue;
      const path = join(this.directory, name);
      const ticket = BodyTransferPeerTicketSchema.parse(readPrivateJson(path));
      if (Date.parse(ticket.expiresAt) <= Date.now()) {
        unlinkSync(path);
        continue;
      }
      if (ticket.transferId === transferId) return ticket;
      active++;
    }
    if (active >= 64) throw Error("body_peer_ticket_capacity");
    const ticket = {
      transferId,
      ticketId: randomUUID(),
      secret: randomBytes(32).toString("base64url"),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
    writePrivateJson(join(this.directory, `${ticket.ticketId}.json`), ticket);
    return ticket;
  }
  exchange(input: unknown, witness: (transferId: string, requestId: string) => BodyTransferPeerWitness) {
    const envelope = BodyTransferPeerEnvelopeSchema.parse(input);
    const path = join(this.directory, `${envelope.ticketId}.json`);
    if (!existsSync(path)) throw Error("body_peer_refused");
    const ticket = BodyTransferPeerTicketSchema.parse(readPrivateJson(path));
    if (ticket.ticketId !== envelope.ticketId || Date.parse(ticket.expiresAt) <= Date.now())
      throw Error("body_peer_refused");
    const payload = BodyTransferPeerPayloadSchema.parse(
      JSON.parse(
        openGatewayValue(
          ticketKey(ticket.secret),
          envelope.sealedRequest,
          aad("request", envelope.ticketId, envelope.requestId),
        ),
      ),
    );
    if (payload.transferId !== ticket.transferId) throw Error("body_peer_refused");
    return {
      sealedResponse: sealGatewayValue(
        ticketKey(payload.responseSecret),
        JSON.stringify(witness(payload.transferId, envelope.requestId)),
        aad("response", envelope.ticketId, envelope.requestId),
      ),
    };
  }
}

/** The service contacts the selected peer itself; a coordinator cannot supply its key or reply. */
export async function readBodyTransferPeer(
  raw: BodyTransferPeerDescriptor,
  transferId: string,
  fetcher: typeof fetch,
) {
  const peer = BodyTransferPeerDescriptorSchema.parse(raw);
  if (peer.ticket.transferId !== transferId) throw Error("body_peer_transfer_mismatch");
  const url = new URL(peer.url);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
  )
    throw Error("body_peer_url_refused");
  const requestId = randomUUID(),
    responseSecret = randomBytes(32).toString("base64url");
  const response = await fetcher(url.href.replace(/\/$/u, "") + BODY_TRANSFER_PEER_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
    body: JSON.stringify({
      ticketId: peer.ticket.ticketId,
      requestId,
      sealedRequest: sealGatewayValue(
        ticketKey(peer.ticket.secret),
        JSON.stringify({ transferId, responseSecret }),
        aad("request", peer.ticket.ticketId, requestId),
      ),
    }),
  });
  if (!response.ok || !response.body) throw Error("body_peer_unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 16_384) throw Error("body_peer_response_too_large");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { sealedResponse?: unknown };
  if (typeof envelope.sealedResponse !== "string" || envelope.sealedResponse.length > 8192)
    throw Error("body_peer_response_invalid");
  return {
    requestId,
    witness: JSON.parse(
      openGatewayValue(
        ticketKey(responseSecret),
        envelope.sealedResponse,
        aad("response", peer.ticket.ticketId, requestId),
      ),
    ) as unknown,
  };
}
