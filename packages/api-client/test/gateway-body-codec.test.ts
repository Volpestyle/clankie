import { expect, it, vi } from "vitest";
import { createGatewayEncryptedFetch, createWebGatewayCrypto } from "../src/gateway-encryption.ts";
import { gatewayRequestAad, gatewayResponseAad } from "@clankie/protocol/gateway-encryption";
const credential = { hostId: "a".repeat(16), key: "A".repeat(43) + "=", ticket: "A".repeat(40) };
async function request(codec: boolean, bytes: Uint8Array, damage = "") {
  const crypto = createWebGatewayCrypto();
  const decode = vi.fn((chunks: readonly string[]) => {
    const buffers = chunks.map((chunk) => {
      const value = Buffer.from(chunk, "base64");
      if (value.toString("base64") !== chunk) throw new Error("Noncanonical encrypted data");
      return value;
    });
    const joined = Uint8Array.from(Buffer.concat(buffers));
    return { bytes: joined.buffer, text: new TextDecoder().decode(joined) };
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/challenge")) return Response.json({ version: 1, challenge: "a".repeat(64) });
    const envelope = JSON.parse(String(init?.body));
    const plain = JSON.parse(
      await crypto.open(credential.key, envelope.sealed, gatewayRequestAad(credential.hostId, envelope)),
    );
    const frames: unknown[] = [{ kind: "start", status: damage === "204" ? 204 : 200, headers: [] }];
    for (const byte of bytes)
      frames.push({ kind: "chunk", bodyBase64: Buffer.from([byte]).toString("base64") });
    if (damage === "bits") frames.push({ kind: "chunk", bodyBase64: "Zh==" });
    if (damage !== "end") frames.push({ kind: "end" });
    if (damage === "afterEnd") frames.push({ kind: "chunk", bodyBase64: "AA==" });
    const lines = await Promise.all(
      frames.map(async (frame, sequence) =>
        JSON.stringify({
          sealed: await crypto.seal(
            plain.responseKey,
            JSON.stringify(frame),
            gatewayResponseAad(credential.hostId, envelope, sequence),
          ),
        }),
      ),
    );
    if (damage === "tag") lines[1] = JSON.stringify({ sealed: "A".repeat(40) });
    if (damage === "order") [lines[1], lines[2]] = [lines[2]!, lines[1]!];
    return new Response(lines.join("\n") + "\n");
  };
  const send = createGatewayEncryptedFetch({
    crypto,
    credential: () => credential,
    fetchImpl,
    ...(codec ? { bodyCodec: { decode } } : {}),
  });
  return { result: send(`https://example.test/h/${credential.hostId}/v1/fleet/roster`), decode };
}
it.each([false, true])("retains byte/text/clone/consumption semantics (%s)", async (codec) => {
  const body = '\ufeff{"text":"café 🌱\\u0000"}';
  const bytes = new TextEncoder().encode(body);
  const { result, decode } = await request(codec, bytes);
  const response = await result;
  const text = response.clone(),
    binary = response.clone(),
    blob = response.clone();
  expect(response.bodyUsed).toBe(false);
  expect(await response.json()).toEqual({ text: "café 🌱\0" });
  expect(response.bodyUsed).toBe(true);
  await expect(response.text()).rejects.toThrow();
  expect(() => response.clone()).toThrow();
  expect(await text.text()).toBe(body.slice(1));
  expect(new Uint8Array(await binary.arrayBuffer())).toEqual(bytes);
  expect(new Uint8Array(await (await blob.blob()).arrayBuffer())).toEqual(bytes);
  expect(decode).toHaveBeenCalledTimes(codec ? 1 : 0);
});
it.each([false, true])("retains malformed UTF-8 replacement (%s)", async (codec) => {
  const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, 0xe2, 0x82, 0x41, 0xed, 0xa0, 0x80, 0xf0, 0x9f]);
  const { result } = await request(codec, bytes);
  expect(await (await result).text()).toBe(new TextDecoder().decode(bytes));
});
it.each(["tag", "end", "order", "afterEnd"])("waits for complete authentication (%s)", async (damage) => {
  const { result, decode } = await request(true, new TextEncoder().encode("hello"), damage);
  await expect(result).rejects.toThrow();
  expect(decode).not.toHaveBeenCalled();
});
it("propagates codec canonical refusal without fallback", async () => {
  const { result, decode } = await request(true, new TextEncoder().encode("hello"), "bits");
  await expect(result).rejects.toThrow("Noncanonical encrypted data");
  expect(decode).toHaveBeenCalledOnce();
});

it.each([false, true])("keeps empty-status response semantics (%s)", async (codec) => {
  const { result } = await request(codec, new TextEncoder().encode("discarded"), "204");
  const response = await result;
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
});
it("rejects a locked body before returning cached native text", async () => {
  const { result } = await request(true, new TextEncoder().encode("hello"));
  const response = await result;
  const reader = response.body!.getReader();
  await expect(response.text()).rejects.toThrow();
  reader.releaseLock();
  expect(await response.text()).toBe("hello");
});
it("rejects an incorrectly sized platform buffer", async () => {
  const { result, decode } = await request(true, new TextEncoder().encode("hello"));
  decode.mockReturnValue({ bytes: new ArrayBuffer(0), text: "" });
  await expect(result).rejects.toThrow("Invalid decoded response size");
});
