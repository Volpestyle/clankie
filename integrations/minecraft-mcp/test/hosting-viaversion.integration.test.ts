/** Manual-only real Paper/protocol/auth boundary. Never starts worlds in ordinary CI. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import type { Socket } from "node:net";
import { FileCredentialStore } from "@clankie/credential-broker";
import mineflayer, { type Bot } from "mineflayer";
import { expect, it } from "vitest";
import { MinecraftHost } from "../src/hosting.ts";

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

function client(port: number, username: string, version: string) {
  return mineflayer.createBot({
    host: "127.0.0.1",
    port,
    username,
    version,
    auth: "offline",
    hideErrors: true,
    connect(client) {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () =>
        socket.write(`PROXY TCP4 127.0.0.1 127.0.0.1 ${socket.localPort} ${port}\r\n`),
      );
      client.setSocket(socket);
    },
  });
}

async function authenticated(bot: Bot, secret: string) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Authentication did not complete")), 30000);
    bot.once("spawn", () => bot.chat(`/login ${secret}`));
    bot.on("messagestr", (message: string) => {
      if (message === "Successful login!") {
        clearTimeout(timer);
        resolve();
      }
    });
    bot.once("end", () => {
      clearTimeout(timer);
      reject(new Error("Client disconnected before authentication"));
    });
    bot.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Client transport failed"));
    });
  });
}

function varint(value: number): Buffer {
  const bytes: number[] = [];
  do {
    const next = value & 0x7f;
    value >>>= 7;
    bytes.push(next | (value ? 0x80 : 0));
  } while (value);
  return Buffer.from(bytes);
}
function string(value: string) {
  const data = Buffer.from(value);
  return Buffer.concat([varint(data.length), data]);
}
function packet(id: number, ...fields: Buffer[]) {
  const payload = Buffer.concat([varint(id), ...fields]);
  return Buffer.concat([varint(payload.length), payload]);
}
function readVarint(buffer: Buffer, start: number): { value: number; end: number } | undefined {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const next = buffer[start + i];
    if (next === undefined) return;
    value |= (next & 0x7f) << (7 * i);
    if (!(next & 0x80)) return { value, end: start + i + 1 };
  }
  throw new Error("Invalid protocol varint");
}

/** 26.3 login negotiation: an offline impersonator must encounter encryption, never login success. */
async function premiumGate26_3(port: number) {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("26.3 encryption request absent"));
    }, 15000);
    let received = Buffer.alloc(0);
    socket.once("connect", () => {
      const portBytes = Buffer.alloc(2);
      portBytes.writeUInt16BE(port);
      socket.write(`PROXY TCP4 127.0.0.1 127.0.0.1 ${socket.localPort} ${port}\r\n`);
      socket.write(packet(0, varint(777), string("127.0.0.1"), portBytes, varint(2)));
      socket.write(packet(0, string("Notch"), Buffer.from("069a79f444e94726a5befca90e38aaf5", "hex")));
    });
    socket.on("data", (data) => {
      received = Buffer.concat([received, data]);
      const length = readVarint(received, 0);
      if (!length || received.length < length.end + length.value) return;
      const id = readVarint(received, length.end);
      if (!id) return;
      clearTimeout(timer);
      socket.destroy();
      // Encryption Request is login packet 0x01. The client has no premium session/key.
      if (id.value === 1) resolve();
      else reject(new Error(`Unexpected 26.3 preauthentication packet ${id.value}`));
    });
    socket.once("error", () => {
      clearTimeout(timer);
      reject(new Error("26.3 transport failed"));
    });
    socket.once("end", () => {
      clearTimeout(timer);
      reject(new Error("26.3 login ended before encryption"));
    });
  });
}

/**
 * Finite-state 26.3 client grounded in ViaVersion 5.12.0 packet enum ordinals:
 * protocols/v26_2to26_3/packet and ServerboundConfigurationPackets1_21_9.
 * It negotiates login/configuration/play and AuthMe, not rendering/gameplay.
 */
async function authenticated26_3(port: number, username: string, secret: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("26.3 authentication did not complete"));
    }, 30000);
    let received = Buffer.alloc(0);
    let compression = false;
    let state: "login" | "configuration" | "play" = "login";
    let enteredPlay = false;
    let sentLogin = false;
    const fail = (reason: string) => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(reason));
    };
    const send = (id: number, ...fields: Buffer[]) => {
      const payload = Buffer.concat([varint(id), ...fields]);
      const framed = compression ? Buffer.concat([varint(0), payload]) : payload;
      socket.write(Buffer.concat([varint(framed.length), framed]));
    };
    socket.once("connect", () => {
      const portBytes = Buffer.alloc(2);
      portBytes.writeUInt16BE(port);
      socket.write(`PROXY TCP4 127.0.0.1 127.0.0.1 ${socket.localPort} ${port}\r\n`);
      send(0, varint(777), string("127.0.0.1"), portBytes, varint(2));
      send(0, string(username), Buffer.alloc(16));
    });
    socket.on("data", (data) => {
      try {
        received = Buffer.concat([received, data]);
        for (;;) {
          const length = readVarint(received, 0);
          if (!length || received.length < length.end + length.value) break;
          let payload = received.subarray(length.end, length.end + length.value);
          received = received.subarray(length.end + length.value);
          if (compression) {
            const size = readVarint(payload, 0);
            if (!size) throw new Error("Missing compression envelope");
            payload = size.value ? inflateSync(payload.subarray(size.end)) : payload.subarray(size.end);
          }
          const id = readVarint(payload, 0);
          if (!id) throw new Error("Missing packet identifier");
          const fields = payload.subarray(id.end);
          if (state === "login") {
            if (id.value === 3) compression = true;
            else if (id.value === 2) {
              send(3);
              state = "configuration";
            } else if (id.value === 0 || id.value === 1) return fail("26.3 nonpremium login refused");
          } else if (state === "configuration") {
            if (id.value === 0x0f)
              send(7, varint(0)); // no known packs: request complete registry data
            else if (id.value === 4) send(4, fields);
            else if (id.value === 5) send(5, fields);
            else if (id.value === 0x14) send(9);
            else if (id.value === 3) {
              send(3);
              state = "play";
            } else if (id.value === 2) return fail("26.3 configuration refused");
          } else {
            if (id.value === 0x32) {
              enteredPlay = true;
              send(0x2c);
            } else if (id.value === 0x2d) send(0x1c, fields);
            else if (id.value === 0x3e) send(0x2d, fields);
            else if (id.value === 0x0b) {
              const rate = Buffer.alloc(4);
              rate.writeFloatBE(10);
              send(0x0b, rate);
            } else if (id.value === 0x49) {
              const teleport = readVarint(fields, 0);
              if (teleport) {
                // 26.3 adds actual xyz/yaw/pitch to the teleport acknowledgement.
                send(
                  0,
                  varint(teleport.value),
                  fields.subarray(teleport.end, teleport.end + 24),
                  fields.subarray(teleport.end + 48, teleport.end + 56),
                );
              }
              if (!sentLogin) {
                sentLogin = true;
                send(7, string(`login ${secret}`));
              }
            } else if (id.value === 0x20) return fail("26.3 play connection refused");
            else if (id.value === 0x7c && enteredPlay && fields.includes(Buffer.from("Successful login!"))) {
              clearTimeout(timer);
              resolve(socket);
            }
          }
        }
      } catch {
        fail("26.3 packet negotiation failed");
      }
    });
    socket.once("error", () => fail("26.3 transport failed"));
    socket.once("end", () => fail("26.3 connection ended before authentication"));
  });
}

it.skipIf(process.env.MINECRAFT_VIAVERSION_INTEGRATION !== "1")(
  "admits a newer nonpremium client and the unchanged bot plus authenticated 26.3 play while enforcing the 26.3 premium gate",
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clankie-via-real-"));
    const credentials = new FileCredentialStore(join(dataDir, "private-credentials.json"));
    const gamePort = await freePort();
    const rconPort = await freePort();
    const host = new MinecraftHost({ dataDir, credentials, gamePort, rconPort, idleTimeoutMs: 900000 });
    const clients: Bot[] = [];
    const rawClients: Socket[] = [];
    try {
      const ready = await host.start();
      expect(ready.authReady).toBe(true);
      expect(ready.supportedClientVersions).toContain("26.3");
      const name = "ViaTestLocal26";
      const enrollment = await host.enroll(name);
      expect(enrollment.classification).toBe("nonpremium");
      assert.ok(enrollment.providerId);
      const friendSecret = await credentials.get(enrollment.providerId);
      assert.ok(friendSecret?.type === "api");
      await host.admin({ operation: "whitelist_add", username: name });
      const friend = client(gamePort, name, "1.21.11");
      clients.push(friend);
      await authenticated(friend, friendSecret.key);
      const bot = client(gamePort, ready.botUsername, "1.21.4");
      clients.push(bot);
      const botSecret = await host.botLogin(ready.gameEndpoint);
      assert.ok(botSecret);
      await authenticated(bot, botSecret);
      const occupancy = await host.admin({ operation: "list" });
      expect(occupancy.players).toEqual(expect.arrayContaining([name, ready.botUsername]));
      const rawName = "ViaRawLocal26";
      const rawEnrollment = await host.enroll(rawName);
      expect(rawEnrollment.classification).toBe("nonpremium");
      assert.ok(rawEnrollment.providerId);
      const rawSecret = await credentials.get(rawEnrollment.providerId);
      assert.ok(rawSecret?.type === "api");
      await host.admin({ operation: "whitelist_add", username: rawName });
      rawClients.push(await authenticated26_3(gamePort, rawName, rawSecret.key));
      expect((await host.admin({ operation: "list" })).players).toContain(rawName);
      const premium = await host.enroll("Notch");
      expect(premium.classification).toBe("premium");
      await host.admin({ operation: "whitelist_add", username: "Notch" });
      await premiumGate26_3(gamePort);
      expect((await host.admin({ operation: "list" })).players).not.toContain("Notch");
    } finally {
      for (const bot of clients) bot.quit();
      for (const socket of rawClients) socket.destroy();
      await host.stop();
      expect(host.status().phase).toBe("stopped");
      await rm(dataDir, { recursive: true, force: true });
    }
  },
  240000,
);
