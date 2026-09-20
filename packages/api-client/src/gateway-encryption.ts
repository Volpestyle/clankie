import {
  GATEWAY_CHALLENGE_PATH,
  GATEWAY_ENCRYPTED_PATH,
  GATEWAY_PLAINTEXT_BYTES_MAX,
  GATEWAY_RESPONSE_BYTES_MAX,
  GatewayEncryptionCredentialSchema,
  GatewayPlainResponseSchema,
  gatewayRequestAad,
  gatewayResponseAad,
  type GatewayEnvelope,
  type GatewayEncryptionCredential,
  type GatewayPlainRequest,
} from "@clankie/protocol/gateway-encryption";

/** Implemented with node:crypto, Expo Crypto, or CryptoKit, never JavaScript ciphers. */
export interface GatewayCrypto {
  randomBytes(length: number): Uint8Array;
  /** Standard base64 key; sealed = 12-byte IV || ciphertext || 16-byte tag. Text and AAD are UTF-8. */
  seal(key: string, plaintext: string, aad: string): Promise<string>;
  open(key: string, sealed: string, aad: string): Promise<string>;
}
export interface GatewayEncryptedFetchOptions {
  crypto: GatewayCrypto;
  fetchImpl?: typeof fetch;
  credential: () => GatewayEncryptionCredential | undefined;
}
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function decodeUtf8Response(response: Response): Response {
  const clone = response.clone.bind(response);
  response.text = async () => decoder.decode(await response.arrayBuffer());
  response.json = async () => JSON.parse(await response.text()) as unknown;
  response.clone = () => decodeUtf8Response(clone());
  return response;
}

function base64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}
function unbase64(text: string): Uint8Array {
  const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  if (base64(bytes) !== text) throw new Error("Noncanonical encrypted data");
  return bytes;
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** All host application bytes, including authorization, go inside the envelope. No downgrade. */
export function createGatewayEncryptedFetch(options: GatewayEncryptedFetchOptions): typeof fetch {
  const fetcher = options.fetchImpl ?? fetch;
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const hostPath = /^\/h\/([A-Za-z0-9_-]{16,128})(\/.*)$/u.exec(url.pathname);
    const isPush =
      url.pathname === "/gateway/v1/push/registrations" ||
      url.pathname === "/gateway/v1/push/registrations/clear";
    if (hostPath === null && !isPush) {
      if (url.hostname === "api.clankie.bot" && url.pathname.startsWith("/v1/"))
        throw new Error("Scan the secure pairing QR or paste the full link from your Mac");
      return fetcher(input, init);
    }
    const request = new Request(input, init);
    // A clear can use its delivery key without a host or bearer (ADR 0159).
    if (isPush && !request.headers.has("authorization"))
      return fetcher(input, { ...init, redirect: "error" });
    const credential = GatewayEncryptionCredentialSchema.parse(options.credential());
    const pushBody = isPush ? ((await request.json()) as Record<string, unknown>) : undefined;
    const hostId = hostPath?.[1] ?? pushBody?.hostId;
    if (hostId !== credential.hostId || url.search || url.hash || url.username || url.password)
      throw new Error("Gateway host identity mismatch");
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
      throw new Error("Gateway requires TLS");
    const base = `${url.origin}/h/${credential.hostId}`;
    const transportOptions = { signal: request.signal, redirect: "error" as const };
    const challengeResponse = await fetcher(`${base}${GATEWAY_CHALLENGE_PATH}`, transportOptions);
    if (!challengeResponse.ok) throw new Error("Gateway challenge unavailable");
    const challengeBody = (await challengeResponse.json()) as { version?: unknown; challenge?: unknown };
    if (
      challengeBody.version !== 1 ||
      typeof challengeBody.challenge !== "string" ||
      !/^[a-f0-9]{64}$/u.test(challengeBody.challenge)
    )
      throw new Error("Invalid gateway challenge");
    const responseKey = base64(options.crypto.randomBytes(32));
    const body = isPush || request.method === "GET" ? undefined : new Uint8Array(await request.arrayBuffer());
    if (body !== undefined && body.length > GATEWAY_PLAINTEXT_BYTES_MAX)
      throw new Error("Gateway request too large");
    if (request.method !== "GET" && request.method !== "POST") throw new Error("Unsupported gateway method");
    const plaintext: GatewayPlainRequest = {
      method: isPush ? "GET" : request.method,
      path: isPush ? "/v1/devices/self" : hostPath![2]!,
      headers: Array.from(request.headers, ([name, value]) => ({ name, value })).filter((h) =>
        ["authorization", "content-type", "accept"].includes(h.name),
      ),
      ...(body === undefined ? {} : { bodyBase64: base64(body) }),
      responseKey,
    };
    const context = {
      ticket: credential.ticket,
      challenge: challengeBody.challenge,
      requestId: hex(options.crypto.randomBytes(32)),
    };
    const envelope: GatewayEnvelope = {
      version: 1,
      ...context,
      sealed: await options.crypto.seal(
        credential.key,
        JSON.stringify(plaintext),
        gatewayRequestAad(credential.hostId, context),
      ),
    };
    if (isPush) {
      // The gateway receives delivery metadata and a one-use opaque proof, never the bearer.
      return fetcher(url, {
        ...transportOptions,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...pushBody, deviceAuthorization: envelope }),
      });
    }
    const outer = await fetcher(`${base}${GATEWAY_ENCRYPTED_PATH}`, {
      ...transportOptions,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    if (!outer.ok)
      throw new Error(`Encrypted gateway request refused (${outer.status}); re-pair if the host key changed`);
    const encoded = await outer.text();
    if (encoder.encode(encoded).length > 32 * 1024 * 1024 || !encoded.endsWith("\n"))
      throw new Error("Truncated or oversized encrypted response");
    const lines = encoded.slice(0, -1).split("\n");
    let status: number | undefined;
    const headers = new Headers();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let ended = false;
    for (let sequence = 0; sequence < lines.length; sequence++) {
      if (ended || lines[sequence]!.length > 128 * 1024)
        throw new Error("Invalid encrypted response sequence");
      const record = JSON.parse(lines[sequence]!) as { sealed?: unknown };
      if (typeof record.sealed !== "string") throw new Error("Invalid encrypted response record");
      const plain = GatewayPlainResponseSchema.parse(
        JSON.parse(
          await options.crypto.open(
            responseKey,
            record.sealed,
            gatewayResponseAad(credential.hostId, context, sequence),
          ),
        ),
      );
      if (sequence === 0) {
        if (plain.kind !== "start") throw new Error("Missing encrypted response start");
        status = plain.status;
        for (const h of plain.headers) headers.set(h.name, h.value);
        if (plain.ticket !== undefined) headers.set("x-clankie-encryption-ticket", plain.ticket);
        if (plain.key !== undefined) headers.set("x-clankie-encryption-key", plain.key);
      } else if (plain.kind === "chunk") {
        const chunk = unbase64(plain.bodyBase64);
        total += chunk.length;
        if (total > GATEWAY_RESPONSE_BYTES_MAX) throw new Error("Encrypted response too large");
        chunks.push(chunk);
      } else if (plain.kind === "end") ended = true;
      else throw new Error("Unexpected encrypted response start");
    }
    if (!ended || status === undefined) throw new Error("Truncated encrypted response");
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    // Bounded HTTP/long-poll consumers see no unauthenticated partial result.
    const empty = status === 204 || status === 205 || status === 304;
    const response = new Response(empty ? null : bytes, {
      status,
      headers,
    });
    // React Native's Response treats UTF-8 bytes as Latin-1 in text()/json().
    return empty ? response : decodeUtf8Response(response);
  };
}
