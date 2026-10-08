/** Synthetic native-process seam only. No GUI, permissions, capture or native input. */
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
const [choice, journal, stopProof = "certain"] = process.argv.slice(2);
let bound = "",
  consent = false,
  effects = 0;
const table = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function chunk(kind, data) {
  const tag = Buffer.from(kind);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([tag, data])) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  const length = Buffer.alloc(4),
    sum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, tag, data, sum]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(256, 0);
header.writeUInt32BE(128, 4);
header[8] = 8;
header[9] = 6;
// Valid PNG with enough random pixels to exercise several bounded media chunks.
let seed = 123456;
const pixels = Buffer.alloc((256 * 4 + 1) * 128);
for (let y = 0; y < 128; y++)
  for (let x = 1; x <= 1024; x++) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    pixels[y * 1025 + x] = seed >>> 24;
  }
const png = Buffer.concat([
  Buffer.from("89504e470d0a1a0a", "hex"),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(pixels)),
  chunk("IEND", Buffer.alloc(0)),
]);
let text = "before";
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line),
    { id, action, value } = request;
  appendFileSync(
    journal,
    JSON.stringify({ action, ...(action === "input" ? { effect: ++effects } : {}) }) + "\n",
  );
  let result = {},
    ok = true;
  if (action === "consent") {
    consent = choice !== "deny";
    result = { approved: consent, allowInput: choice.startsWith("drive") };
    if (choice === "wait") await new Promise((resolve) => setTimeout(resolve, 250));
  } else if (action === "bind") {
    bound = value.leaseId;
    result = { bound: true };
  } else if (action === "end") {
    bound = "";
    consent = false;
  } else if (action === "inventory") {
    if (choice === "drive-stop") {
      setTimeout(() => process.stdout.write(JSON.stringify({ event: "stopped" }) + "\n"), 150);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    result = {
      complete: true,
      apps: [{ appId: "123", name: "Fixture" }],
      windows: [{ appId: "123", windowId: "456", title: "Fixture" }],
    };
  } else if (action === "capture") {
    if (!consent || !bound) ok = false;
    result = {
      png: png.toString("base64"),
      coordinates: {
        space: "global_display_points",
        origin: "top_left",
        bounds: { x: 10, y: 20, width: 256, height: 128 },
      },
      elements: [{ id: "press", label: "Fixture press", actionable: true }],
      accessibility: { tree: "fixture", document_text: text },
      reference: randomUUID(),
    };
  } else if (action === "input") {
    if (!consent || !choice.startsWith("drive")) ok = false;
    else {
      text = value.input.expect.equals;
      result = { outcome: "confirmed", detail: "Synthetic changed fixture value" };
    }
  } else if (action === "stop") {
    consent = false;
    result = { quiescent: stopProof === "certain" && effects === 0 };
  } else if (action !== "heartbeat") ok = false;
  process.stdout.write(JSON.stringify({ id, ok, result }) + "\n");
}
