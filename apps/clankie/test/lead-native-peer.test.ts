import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

// The Python fixture mode only decodes supplied bytes; it never opens a socket.
function message(kind: number, body: Buffer, flags = 2) {
  const bytes = Buffer.alloc(16 + body.length);
  bytes.writeUInt32LE(bytes.length, 0);
  bytes.writeUInt16LE(kind, 4);
  bytes.writeUInt16LE(flags, 6);
  bytes.writeUInt32LE(1, 8);
  body.copy(bytes, 16);
  return bytes;
}
function attribute(kind: number, data: Buffer) {
  const bytes = Buffer.alloc((4 + data.length + 3) & ~3);
  bytes.writeUInt16LE(4 + data.length, 0);
  bytes.writeUInt16LE(kind, 2);
  data.copy(bytes, 4);
  return bytes;
}
function parse(input: Buffer) {
  return JSON.parse(
    execFileSync("python3", ["scripts/evals/lead-native-peer.py", "--parse-fixture"], {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
}
it("decodes pinned Linux UNIX_DIAG_NAME and UNIX_DIAG_PEER framing without a kernel probe", () => {
  const header = Buffer.alloc(16);
  header[0] = 1;
  header[1] = 1;
  header[2] = 1;
  header.writeUInt32LE(42, 4);
  const peer = Buffer.alloc(4);
  peer.writeUInt32LE(43);
  const frame = message(
    20,
    Buffer.concat([
      header,
      attribute(0, Buffer.from("/eval/control/herdr-client.sock\0")),
      attribute(2, peer),
    ]),
  );
  expect(parse(Buffer.concat([frame, message(3, Buffer.alloc(4))]))).toEqual([
    [{ inode: 42, state: 1, type: 1, path: "/eval/control/herdr-client.sock", peer: 43 }],
    true,
  ]);
});
it("rejects interrupted, malformed and error-completed socket inventories", () => {
  const error = Buffer.alloc(4);
  error.writeInt32LE(-1);
  for (const bytes of [
    message(3, error),
    message(3, Buffer.alloc(0)),
    message(3, Buffer.alloc(4), 0x10),
    Buffer.alloc(3),
    Buffer.concat([message(3, Buffer.alloc(4)), message(3, Buffer.alloc(4))]),
  ]) {
    expect(() => parse(bytes)).toThrow();
  }
});
