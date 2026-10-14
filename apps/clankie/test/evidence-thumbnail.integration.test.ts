import { serve } from "@hono/node-server";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import {
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OperatorConversationServiceResultSchema,
  TAKE_CONTROL_GRANTS,
} from "@clankie/protocol";
import { EVIDENCE_PREVIEW_MAX_BYTES } from "@clankie/protocol/evidence";
import { decode as decodeJpeg } from "jpeg-js";
import { expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createBearerAuthenticator } from "../src/app/http-auth.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../src/device-session.ts";
import { EvidenceStore } from "../src/evidence-store.ts";
import {
  EVIDENCE_THUMBNAIL_LIMITS,
  EvidenceThumbnails,
  EvidenceThumbnailUnavailable,
  evidenceThumbnails,
} from "../src/evidence-thumbnail.ts";

const actor = { kind: "worker" as const, id: "worker-1", name: "Sorrel", onBehalfOf: [] };

function chunk(type: string, data: Buffer) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** A PNG of any colour type and depth whose rows cycle through all five filter types, as real encoders mix them. */
function rawPng(
  width: number,
  height: number,
  depth: number,
  colorType: number,
  pixel: (x: number, y: number) => number[],
  extra: Buffer[] = [],
) {
  const bits = depth * pixel(0, 0).length;
  const stride = Math.ceil((width * bits) / 8);
  const bpp = Math.max(1, bits >> 3);
  const raw = Buffer.alloc((stride + 1) * height);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(stride);
    for (let x = 0; x < width; x++)
      pixel(x, y).forEach((sample, channel) => {
        const bit = (x * pixel(0, 0).length + channel) * depth;
        if (depth === 16) row.writeUInt16BE(sample, bit >> 3);
        else row[bit >> 3] = row[bit >> 3]! | (sample << (8 - depth - (bit & 7)));
      });
    const filter = y % 5;
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? row[i - bpp]! : 0;
      const up = previous[i]!;
      const corner = i >= bpp ? previous[i - bpp]! : 0;
      const p = left + up - corner;
      const paeth =
        Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - corner)
          ? left
          : Math.abs(p - up) <= Math.abs(p - corner)
            ? up
            : corner;
      const predict = [0, left, up, (left + up) >> 1, paeth][filter]!;
      raw[y * (stride + 1) + 1 + i] = (row[i]! - predict) & 255;
    }
    previous = row;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([depth, colorType, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    ...extra,
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function rgbaPng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => number[],
  extra: Buffer[] = [],
) {
  return rawPng(width, height, 8, 6, pixel, extra);
}

/** A phone-screenshot-shaped raster: flat panels, noisy "text" lines, and corner markers. */
function screenshot(alpha: (x: number, y: number) => number = () => 255) {
  let seed = 1954;
  const random = () => (seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff) / 0x7fffffff;
  return rgbaPng(1206, 2622, (x, y) => {
    if (x < 120 && y < 120) return [230, 20, 20, alpha(x, y)];
    if (x >= 1086 && y >= 2502) return [20, 40, 230, alpha(x, y)];
    const panel = Math.floor(y / 300) % 2 === 0 ? 245 : 32;
    const line = y % 40 < 14 && x > 60 && x < 1100 && random() < 0.11;
    const value = line ? 255 - panel : panel;
    return [value, value, Math.min(255, value + 8), alpha(x, y)];
  });
}

/** Inflates a PNG's IDAT and checks its complete raster length; returns its IHDR size. */
function completePng(bytes: Buffer) {
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  const idat: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    expect(bytes.readUInt32BE(offset + 8 + length)).toBe(
      crc32(bytes.subarray(offset + 4, offset + 8 + length)),
    );
    if (type === "IDAT") idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  expect(raw.length).toBe(height * (width * 4 + 1));
  // Unfilter the 8-bit RGBA rendition to read its pixels back.
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++)
    for (let i = 0; i < stride; i++) {
      const left = i >= 4 ? pixels[y * stride + i - 4]! : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + i]! : 0;
      const corner = i >= 4 && y > 0 ? pixels[(y - 1) * stride + i - 4]! : 0;
      const p = left + up - corner;
      const paeth =
        Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - corner)
          ? left
          : Math.abs(p - up) <= Math.abs(p - corner)
            ? up
            : corner;
      const filter = raw[y * (stride + 1)]!;
      pixels[y * stride + i] =
        (raw[y * (stride + 1) + 1 + i]! + [0, left, up, (left + up) >> 1, paeth][filter]!) & 255;
    }
  return { width, height, pixels };
}

async function record(store: EvidenceStore, bytes: Buffer, fileName: string, contentType: string) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const receipt = await store.upload(actor, {
    idempotencyKey: `key-${sha256.slice(0, 24)}`,
    sha256,
    size: bytes.length,
    contentType,
    fileName,
    issueKey: "VUH-1954",
    caption: `Proof: ${fileName}`,
  });
  await store.acceptBlob(
    EvidenceStore.actorKey(actor),
    receipt.receiptId,
    (async function* () {
      yield bytes;
    })(),
  );
  return sha256;
}

async function pairedDeviceServer(store: EvidenceStore, root: string) {
  const key = randomBytes(32);
  const captain = randomBytes(24).toString("base64url");
  const now = Math.floor(Date.now() / 1000) * 1000;
  const base = {
    occurredAt: new Date(now).toISOString(),
    missionId: "device:owner",
    correlationId: "fixture",
    profileHash: "fixture",
  };
  const eventLogPath = join(root, "events.jsonl");
  await writeFile(
    eventLogPath,
    [
      {
        ...base,
        id: randomUUID(),
        type: "device.pairing.redeemed",
        data: {
          schemaVersion: 1,
          deviceId: "owner",
          offerId: "owner",
          name: "owner",
          platform: "ios",
          offeredGrants: TAKE_CONTROL_GRANTS,
          mintedBy: "local-operator",
          pendingExpiresAt: new Date(now + 600_000).toISOString(),
        },
      },
      {
        ...base,
        id: randomUUID(),
        type: "device.activated",
        data: {
          schemaVersion: 1,
          deviceId: "owner",
          grants: TAKE_CONTROL_GRANTS,
          sessionExpiresAt: new Date(now + 600_000).toISOString(),
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
  );
  const { app } = await createClankieApp({
    captain: createStubCaptain(),
    evidenceStore: store,
    eventLogPath,
    deviceSessionKey: key,
    clock: () => new Date(now),
    authenticateOperator: async () => undefined,
    // The production captain bearer check; devices reach evidence_preview on that relay credential.
    authenticateCaptain: createBearerAuthenticator(captain, {
      captainId: "captain-clankie",
      steerSourceLane: "api",
    }),
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test HTTP port");
  const token = new DeviceSessionSigner(key).issue(
    mintDeviceSessionClaims({ deviceId: "owner", nowEpochSeconds: now / 1000, ttlSeconds: 600 }),
  );
  const post = (body: unknown, bearer: string | undefined) =>
    fetch(`http://127.0.0.1:${address.port}${OPERATOR_CONVERSATION_DISPATCH_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });
  const dispatch = async (body: unknown, bearer = captain) => {
    const response = await post(body, bearer);
    expect(response.status).toBe(200);
    return OperatorConversationServiceResultSchema.parse(await response.json());
  };
  const preview = async (sha256: string) => {
    const value = await dispatch({ op: "evidence_preview", schemaVersion: 1, sha256 });
    if (value.op !== "evidence_preview") throw new Error("Expected an evidence preview");
    return value.result;
  };
  return { server, post, dispatch, preview, token };
}

it("gives a paired device a complete thumbnail of a large recorded PNG, cached by sha256, over the real route", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-thumbnail-"));
  // The real local store, with blob opens counted to show where large previews read bytes.
  const local = EvidenceStore.local(join(root, "evidence"));
  const opened: string[] = [];
  const store = new EvidenceStore(
    {
      backend: local.blobs.backend,
      location: local.blobs.location,
      has: (sha256) => local.blobs.has(sha256),
      write: (sha256, size, body) => local.blobs.write(sha256, size, body),
      readRange: (sha256, offset, length) => local.blobs.readRange!(sha256, offset, length),
      open: (sha256) => {
        opened.push(sha256);
        return local.blobs.open(sha256);
      },
    },
    local.metadata,
  );
  const opaque = screenshot();
  const transparent = screenshot((x) => (x < 603 ? 255 : 96));
  for (const source of [opaque, transparent]) {
    expect(source.length).toBeGreaterThan(75_000);
    expect(source.length).toBeLessThan(280_000);
  }
  const small = rgbaPng(64, 64, (x, y) => [x * 4, y * 4, 128, 255]);
  const text = Buffer.from("line of a long proof log\n".repeat(4_000));
  const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(80_000, 1)]);
  const huge = Buffer.alloc(13);
  huge.writeUInt32BE(5_000, 0);
  huge.writeUInt32BE(4_000, 4);
  huge.set([8, 6, 0, 0, 0], 8);
  const padding = chunk("tEXt", Buffer.concat([Buffer.from("Comment\0"), Buffer.alloc(70_000, 65)]));
  const tooManyPixels = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", huge),
    padding,
    chunk("IEND", Buffer.alloc(0)),
  ]);
  // A 100x100 header whose IDAT inflates to 8 MiB: stops at the exact IHDR length.
  const bomb = rgbaPng(100, 100, () => [0, 0, 0, 255], [padding]);
  const bombHeader = bomb.indexOf("IDAT") - 4;
  const inflating = Buffer.concat([
    bomb.subarray(0, bombHeader),
    chunk("IDAT", deflateSync(Buffer.alloc(8 * 1024 * 1024))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const corrupt = Buffer.from(opaque);
  const flipped = corrupt.indexOf("IDAT") + 100;
  corrupt[flipped] = corrupt[flipped]! ^ 0xff;

  const sha = {
    opaque: await record(store, opaque, "docs/testing/phone.png", "image/png"),
    transparent: await record(store, transparent, "docs/testing/overlay.png", "image/png"),
    small: await record(store, small, "docs/testing/small.png", "image/png"),
    text: await record(store, text, "docs/testing/run.log", "text/plain"),
    gif: await record(store, gif, "docs/testing/anim.gif", "image/gif"),
    tooManyPixels: await record(store, tooManyPixels, "docs/testing/wall.png", "image/png"),
    inflating: await record(store, inflating, "docs/testing/bomb.png", "image/png"),
    corrupt: await record(store, corrupt, "docs/testing/corrupt.png", "image/png"),
  };
  // Stored bytes nobody recorded: never previewed, whatever the thumbnail cache holds.
  const unrecorded = screenshot((x, y) => ((x + y) % 2 ? 255 : 254));
  const unrecordedSha = createHash("sha256").update(unrecorded).digest("hex");
  expect(
    await store.blobs.write(
      unrecordedSha,
      unrecorded.length,
      (async function* () {
        yield unrecorded;
      })(),
    ),
  ).toEqual({ ok: true });
  // Even with a rendition already cached for those bytes, the route answers only for recorded ones.
  expect(
    await evidenceThumbnails.preview(unrecordedSha, unrecorded.length, () => store.blobs.open(unrecordedSha)),
  ).toMatchObject({ available: true });
  const { server, post, dispatch, preview, token } = await pairedDeviceServer(store, root);
  try {
    // Authentication still gates the route before any preview is read.
    for (const bearer of [undefined, "not-the-captain"])
      expect(
        (await post({ op: "evidence_preview", schemaVersion: 1, sha256: sha.opaque }, bearer)).status,
      ).toBe(401);
    expect(await preview("0".repeat(64))).toMatchObject({ outcome: "unavailable" });
    expect(await preview(unrecordedSha)).toMatchObject({ outcome: "unavailable" });

    const rendersBefore = evidenceThumbnails.renders;
    opened.length = 0;
    const thumbnail = await preview(sha.opaque);
    // The large blob is opened once, by the thumbnail render after the record and cache checks.
    expect(opened).toEqual([sha.opaque]);
    expect(thumbnail).toMatchObject({
      outcome: "ready",
      sha256: sha.opaque,
      available: true,
      contentType: "image/jpeg",
    });
    const jpeg = Buffer.from(thumbnail.outcome === "ready" ? thumbnail.data! : "", "base64");
    expect(jpeg.length).toBeLessThanOrEqual(EVIDENCE_PREVIEW_MAX_BYTES);
    const decoded = decodeJpeg(jpeg, { useTArray: true });
    // Downscaled whole to a ladder edge with its aspect kept, both corner markers present.
    expect(EVIDENCE_THUMBNAIL_LIMITS.edges).toContain(decoded.height);
    expect(decoded.width).toBe(Math.round((1206 * decoded.height) / 2622));
    const at = (x: number, y: number) =>
      Array.from(decoded.data.subarray((y * decoded.width + x) * 4, (y * decoded.width + x) * 4 + 3));
    const [red, , blueOfRed] = at(15, 15);
    const [redOfBlue, , blue] = at(decoded.width - 15, decoded.height - 15);
    expect(red).toBeGreaterThan(180);
    expect(blueOfRed).toBeLessThan(80);
    expect(blue).toBeGreaterThan(180);
    expect(redOfBlue).toBeLessThan(80);
    expect(evidenceThumbnails.renders).toBe(rendersBefore + 1);

    // The same sha256 reuses the rendition without opening or decoding the blob again.
    expect(await preview(sha.opaque)).toEqual(thumbnail);
    expect(evidenceThumbnails.renders).toBe(rendersBefore + 1);
    expect(opened).toEqual([sha.opaque]);

    // Transparency keeps a PNG rendition, complete and under the cap.
    const overlay = await preview(sha.transparent);
    expect(overlay).toMatchObject({ outcome: "ready", available: true, contentType: "image/png" });
    const overlayBytes = Buffer.from(overlay.outcome === "ready" ? overlay.data! : "", "base64");
    expect(overlayBytes.length).toBeLessThanOrEqual(EVIDENCE_PREVIEW_MAX_BYTES);
    expect(completePng(overlayBytes).height).toBeLessThanOrEqual(768);

    // Small images, text and large non-PNG answers are unchanged.
    expect(await preview(sha.small)).toMatchObject({
      available: true,
      contentType: "image/png",
      data: small.toString("base64"),
    });
    expect(await preview(sha.text)).toMatchObject({ available: false, reason: "too_large" });
    expect(await preview(sha.gif)).toMatchObject({ available: false, reason: "too_large" });
    // Refusal bounds: pixels before decode, inflated length, and corrupt data.
    expect(await preview(sha.tooManyPixels)).toMatchObject({ available: false, reason: "too_large" });
    expect(await preview(sha.inflating)).toMatchObject({ available: false, reason: "not_previewable" });
    expect(await preview(sha.corrupt)).toMatchObject({ available: false, reason: "not_previewable" });

    // The original stays byte-identical and fetchable by the owner device.
    const fetched = await dispatch(
      { op: "evidence_fetch", schemaVersion: 1, sha256: sha.opaque, offset: 0, length: 262_144 },
      token,
    );
    if (fetched.op !== "evidence_fetch" || fetched.result.outcome !== "ready")
      throw new Error("Expected the original");
    expect(Buffer.from(fetched.result.data, "base64")).toEqual(opaque.subarray(0, 262_144));
    expect(createHash("sha256").update(opaque).digest("hex")).toBe(sha.opaque);
  } finally {
    server.close();
    store.close();
  }
});

it("bounds thumbnail time, concurrency and output without caching transient refusals", async () => {
  const store = EvidenceStore.local(await mkdtemp(join(tmpdir(), "evidence-thumbnail-bounds-")));
  const source = screenshot();
  const sha256 = await record(store, source, "docs/testing/phone.png", "image/png");
  const open = () => store.blobs.open(sha256);

  const slow = new EvidenceThumbnails({ ...EVIDENCE_THUMBNAIL_LIMITS, deadlineMs: 1 });
  await expect(slow.preview(sha256, source.length, open)).rejects.toEqual(
    new EvidenceThumbnailUnavailable("timeout"),
  );
  // Within the retry window the same sha256 answers at once instead of rendering again.
  await expect(slow.preview(sha256, source.length, open)).rejects.toEqual(
    new EvidenceThumbnailUnavailable("timeout"),
  );
  expect(slow.renders).toBe(1);

  const tight = new EvidenceThumbnails({
    ...EVIDENCE_THUMBNAIL_LIMITS,
    outputMaxBytes: 1_000,
    edges: [256, 128],
  });
  expect(await tight.preview(sha256, source.length, open)).toEqual({
    sha256,
    available: false,
    reason: "too_large",
  });

  // A stalled storage read is cut off by the deadline, frees its slot, and isn't retried at once.
  const stalled = new EvidenceThumbnails({ ...EVIDENCE_THUMBNAIL_LIMITS, concurrency: 1, deadlineMs: 50 });
  await expect(stalled.preview(sha256, source.length, () => new Promise(() => {}))).rejects.toEqual(
    new EvidenceThumbnailUnavailable("timeout"),
  );
  await expect(stalled.preview(sha256, source.length, open)).rejects.toEqual(
    new EvidenceThumbnailUnavailable("timeout"),
  );
  expect(stalled.renders).toBe(1);
  // The single slot was freed: another sha256 renders on the same instance.
  const small = rgbaPng(64, 64, (x, y) => [x * 4, y * 4, 128, 255]);
  const smallSha = await record(store, small, "docs/testing/small.png", "image/png");
  expect(await stalled.preview(smallSha, small.length, () => store.blobs.open(smallSha))).toMatchObject({
    available: true,
  });

  // A transparent image whose PNG fits at no edge flattens to a JPEG.
  const overlay = screenshot((x) => (x < 603 ? 255 : 96));
  const overlaySha = await record(store, overlay, "docs/testing/overlay.png", "image/png");
  const flat = new EvidenceThumbnails({ ...EVIDENCE_THUMBNAIL_LIMITS, edges: [512], outputMaxBytes: 40_000 });
  const flattened = await flat.preview(overlaySha, overlay.length, () => store.blobs.open(overlaySha));
  expect(flattened).toMatchObject({ available: true, contentType: "image/jpeg" });
  const flatImage = decodeJpeg(Buffer.from(flattened.data!, "base64"), { useTArray: true });
  expect(flatImage.height).toBe(512);
  // The translucent half sits over white, so its dark panels lighten.
  const lightness = (x: number, y: number) => flatImage.data[(y * flatImage.width + x) * 4]!;
  expect(lightness(flatImage.width - 30, 150)).toBeGreaterThan(lightness(60, 150) - 10);

  const capped = new EvidenceThumbnails({ ...EVIDENCE_THUMBNAIL_LIMITS, sourceMaxBytes: source.length - 1 });
  expect(await capped.preview(sha256, source.length, open)).toEqual({
    sha256,
    available: false,
    reason: "too_large",
  });
  expect(capped.renders).toBe(0);

  const single = new EvidenceThumbnails({ ...EVIDENCE_THUMBNAIL_LIMITS, concurrency: 1, maxQueued: 0 });
  // A second source: the same raster with one ancillary chunk after IHDR.
  const other = Buffer.concat([
    source.subarray(0, 33),
    chunk("tEXt", Buffer.from("Comment\0b")),
    source.subarray(33),
  ]);
  const otherSha = await record(store, other, "docs/testing/other.png", "image/png");
  const openOther = () => store.blobs.open(otherSha);
  const first = single.preview(sha256, source.length, open);
  await expect(single.preview(otherSha, other.length, openOther)).rejects.toEqual(
    new EvidenceThumbnailUnavailable("busy"),
  );
  expect(await first).toMatchObject({ available: true, contentType: "image/jpeg" });
  expect(await single.preview(otherSha, other.length, openOther)).toMatchObject({ available: true });

  // A queued request that isn't admitted in time is refused as busy, not left waiting.
  const queued = new EvidenceThumbnails({
    ...EVIDENCE_THUMBNAIL_LIMITS,
    concurrency: 1,
    maxQueued: 1,
    queueWaitMs: 1,
  });
  const running = queued.preview(sha256, source.length, open);
  await expect(queued.preview(otherSha, other.length, openOther)).rejects.toEqual(
    new EvidenceThumbnailUnavailable("busy"),
  );
  await running;
  store.close();
});

/**
 * The costliest supported raster: 16.7M pixels of 16-bit RGBA (134 MB inflated),
 * Paeth-filtered on every row, in translucent random square blocks, compressible
 * under the 16 MiB source cap. Small blocks defeat every encode on the ladder.
 */
function costliestPng(blockShift: number) {
  const side = 4096;
  const stride = side * 8;
  let seed = 1954;
  const random = () => (seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0) >>> 24;
  const blocks = Array.from({ length: (side >> blockShift) ** 2 * 4 }, random);
  const filtered = Buffer.alloc((stride + 1) * side);
  let previous = new Uint8Array(stride);
  let row = new Uint8Array(stride);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++)
      for (let channel = 0; channel < 4; channel++) {
        const block =
          blocks[(((y >> blockShift) * (side >> blockShift) + (x >> blockShift)) << 2) + channel]!;
        const value = channel === 3 ? 128 + (block >> 1) : block;
        row[(x * 4 + channel) * 2] = row[(x * 4 + channel) * 2 + 1] = value;
      }
    const at = y * (stride + 1);
    filtered[at] = 4;
    for (let i = 0; i < stride; i++) {
      const left = i >= 8 ? row[i - 8]! : 0;
      const up = previous[i]!;
      const corner = i >= 8 ? previous[i - 8]! : 0;
      const p = left + up - corner;
      const predict =
        Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - corner)
          ? left
          : Math.abs(p - up) <= Math.abs(p - corner)
            ? up
            : corner;
      filtered[at + 1 + i] = (row[i]! - predict) & 255;
    }
    [previous, row] = [row, previous];
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header.set([16, 6, 0, 0, 0], 8);
  return {
    pixels: side * side,
    bytes: Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(filtered, { level: 6 })),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  };
}

it.each([
  { blocks: "16-pixel", blockShift: 4, expected: { available: false, reason: "too_large" } },
  { blocks: "256-pixel", blockShift: 8, expected: { available: true, contentType: "image/png" } },
])(
  "finishes the costliest supported raster ($blocks blocks) inside the deadline, checking it between codec steps",
  async ({ blockShift, expected }) => {
    const store = EvidenceStore.local(await mkdtemp(join(tmpdir(), "evidence-thumbnail-cost-")));
    const { pixels, bytes: costliest } = costliestPng(blockShift);
    expect(pixels).toBe(EVIDENCE_THUMBNAIL_LIMITS.maxPixels);
    expect(costliest.length).toBeLessThanOrEqual(EVIDENCE_THUMBNAIL_LIMITS.sourceMaxBytes);
    const sha256 = await record(store, costliest, "docs/testing/costliest.png", "image/png");
    const open = () => store.blobs.open(sha256);
    // Shipped limits, with every deadline check timed: a complete answer arrives
    // inside the deadline, and the longest stretch between checks bounds overshoot.
    let last = performance.now();
    let longestGap = 0;
    const timed = new EvidenceThumbnails(EVIDENCE_THUMBNAIL_LIMITS, {
      clock: () => {
        const now = performance.now();
        longestGap = Math.max(longestGap, now - last);
        last = now;
        return now;
      },
    });
    const started = performance.now();
    const outcome = await timed.preview(sha256, costliest.length, open);
    expect(performance.now() - started).toBeLessThan(EVIDENCE_THUMBNAIL_LIMITS.deadlineMs);
    expect(longestGap).toBeLessThan(500);
    expect(outcome).toMatchObject(expected);
    if (outcome.available) {
      const data = Buffer.from(outcome.data!, "base64");
      expect(data.length).toBeLessThanOrEqual(EVIDENCE_PREVIEW_MAX_BYTES);
      // Complete: every chunk CRC checks and the IDAT inflates to the exact raster length.
      expect(completePng(data).width).toBeLessThanOrEqual(768);
    }
    store.close();
  },
);

it("discards a rendition that finished past the deadline without caching it", async () => {
  const store = EvidenceStore.local(await mkdtemp(join(tmpdir(), "evidence-thumbnail-late-")));
  // Small enough to inflate in one chunk, so every render makes the same checks.
  const source = rgbaPng(32, 32, (x, y) => [x * 8, y * 8, 128, 255]);
  const sha256 = await record(store, source, "docs/testing/tiny.png", "image/png");
  const open = () => store.blobs.open(sha256);
  // Count the deadline checks in a successful render of this image.
  let calls = 0;
  const counted = new EvidenceThumbnails(EVIDENCE_THUMBNAIL_LIMITS, { clock: () => (calls++, 0) });
  expect(await counted.preview(sha256, source.length, open)).toMatchObject({ available: true });
  const checks = calls;
  // The same render with time passing only during the final encode, which no timer can interrupt.
  let seen = 0;
  const late = new EvidenceThumbnails(
    { ...EVIDENCE_THUMBNAIL_LIMITS, timeoutRetryMs: 0 },
    { clock: () => (++seen >= checks ? EVIDENCE_THUMBNAIL_LIMITS.deadlineMs + 1 : 0) },
  );
  await expect(late.preview(sha256, source.length, open)).rejects.toEqual(
    new EvidenceThumbnailUnavailable("timeout"),
  );
  // It failed at the last check, after the final encode.
  expect(seen).toBe(checks);
  // Nothing was cached: asking again renders again.
  seen = -Infinity;
  expect(await late.preview(sha256, source.length, open)).toMatchObject({ available: true });
  expect(late.renders).toBe(2);
  store.close();
});

it("decodes every PNG colour type and depth to the right pixels", async () => {
  const store = EvidenceStore.local(await mkdtemp(join(tmpdir(), "evidence-thumbnail-colours-")));
  // Quadrants of known colour; a 64x64 source boxed to 32x32 keeps each quadrant exact.
  const quadrant = (x: number, y: number) => (y < 32 ? 0 : 2) + (x < 32 ? 0 : 1);
  const plte = (colours: number[][]) => chunk("PLTE", Buffer.from(colours.flat()));
  const trns = (data: number[]) => chunk("tRNS", Buffer.from(data));
  const rgbQuads = [
    [230, 20, 20],
    [20, 200, 40],
    [20, 40, 230],
    [250, 250, 250],
  ];
  const cases: { name: string; png: Buffer; expect: number[][] }[] = [
    {
      name: "rgb8",
      png: rawPng(64, 64, 8, 2, (x, y) => rgbQuads[quadrant(x, y)]!),
      expect: rgbQuads.map((c) => [...c, 255]),
    },
    {
      name: "rgb16+key",
      png: rawPng(64, 64, 16, 2, (x, y) => rgbQuads[quadrant(x, y)]!.map((v) => v * 257), [
        trns([250, 250, 250, 250, 250, 250]),
      ]),
      expect: [...rgbQuads.slice(0, 3).map((c) => [...c, 255]), [0, 0, 0, 0]],
    },
    ...[1, 2, 4].map((depth) => ({
      name: `gray${depth}`,
      png: rawPng(64, 64, depth, 0, (x, y) => [quadrant(x, y) % 2 ? (1 << depth) - 1 : 0]),
      expect: [
        [0, 0, 0, 255],
        [255, 255, 255, 255],
        [0, 0, 0, 255],
        [255, 255, 255, 255],
      ],
    })),
    {
      name: "gray8+key",
      png: rawPng(64, 64, 8, 0, (x, y) => [[0, 85, 170, 255][quadrant(x, y)]!], [trns([0, 170])]),
      expect: [
        [0, 0, 0, 255],
        [85, 85, 85, 255],
        [0, 0, 0, 0],
        [255, 255, 255, 255],
      ],
    },
    {
      name: "gray16",
      png: rawPng(64, 64, 16, 0, (x, y) => [[0, 85, 170, 255][quadrant(x, y)]! * 257]),
      expect: [0, 85, 170, 255].map((v) => [v, v, v, 255]),
    },
    {
      name: "grayalpha8",
      png: rawPng(64, 64, 8, 4, (x, y) => [
        [10, 90, 170, 250][quadrant(x, y)]!,
        [255, 128, 255, 0][quadrant(x, y)]!,
      ]),
      expect: [
        [10, 10, 10, 255],
        [90, 90, 90, 128],
        [170, 170, 170, 255],
        [0, 0, 0, 0],
      ],
    },
    {
      name: "grayalpha16",
      png: rawPng(64, 64, 16, 4, (x, y) => [
        [10, 90, 170, 250][quadrant(x, y)]! * 257,
        [255, 128, 255, 255][quadrant(x, y)]! * 257,
      ]),
      expect: [
        [10, 10, 10, 255],
        [90, 90, 90, 128],
        [170, 170, 170, 255],
        [250, 250, 250, 255],
      ],
    },
    {
      name: "rgba16",
      png: rawPng(64, 64, 16, 6, (x, y) =>
        [...rgbQuads[quadrant(x, y)]!, quadrant(x, y) === 3 ? 64 : 255].map((v) => v * 257),
      ),
      expect: [...rgbQuads.slice(0, 3).map((c) => [...c, 255]), [250, 250, 250, 64]],
    },
    ...[1, 2, 4, 8].map((depth) => ({
      name: `palette${depth}`,
      png: rawPng(64, 64, depth, 3, (x, y) => [quadrant(x, y) % (1 << depth)], [
        plte(depth === 1 ? rgbQuads.slice(0, 2) : rgbQuads),
        trns(depth === 1 ? [255, 120] : [255, 255, 255, 120]),
      ]),
      expect:
        depth === 1
          ? [
              [230, 20, 20, 255],
              [20, 200, 40, 120],
              [230, 20, 20, 255],
              [20, 200, 40, 120],
            ]
          : [...rgbQuads.slice(0, 3).map((c) => [...c, 255]), [250, 250, 250, 120]],
    })),
  ];
  const thumbnails = new EvidenceThumbnails({ ...EVIDENCE_THUMBNAIL_LIMITS, edges: [32], pngMinEdge: 0 });
  for (const { name, png, expect: quads } of cases) {
    const sha256 = await record(store, png, `docs/testing/${name}.png`, "image/png");
    const preview = await thumbnails.preview(sha256, png.length, () => store.blobs.open(sha256));
    expect(preview, name).toMatchObject({ available: true });
    const bytes = Buffer.from(preview.data!, "base64");
    const centres = [
      [8, 8],
      [24, 8],
      [8, 24],
      [24, 24],
    ] as const;
    if (preview.contentType === "image/png") {
      const { width, height, pixels } = completePng(bytes);
      expect([width, height], name).toEqual([32, 32]);
      centres.forEach(([x, y], index) => {
        const actual = Array.from(pixels.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4));
        // Fully transparent pixels carry no colour.
        expect(actual[3] === 0 ? [0, 0, 0, 0] : actual, `${name} quadrant ${index}`).toEqual(quads[index]);
      });
    } else {
      expect(preview.contentType, name).toBe("image/jpeg");
      expect(
        quads.every((quad) => quad[3] === 255),
        name,
      ).toBe(true);
      const image = decodeJpeg(bytes, { useTArray: true });
      expect([image.width, image.height], name).toEqual([32, 32]);
      centres.forEach(([x, y], index) => {
        const actual = Array.from(image.data.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 3));
        actual.forEach((value, channel) =>
          expect(Math.abs(value - quads[index]![channel]!), `${name} quadrant ${index}`).toBeLessThanOrEqual(
            12,
          ),
        );
      });
    }
  }
  store.close();
});
