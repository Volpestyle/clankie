import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MinecraftHost, serializeHostAdmin, hostShouldStop, pinnedAuthLogin } from "../src/hosting.ts";
const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
describe("host boundary", () => {
  it("rejects raw console, selectors and line injection", () => {
    for (const command of [
      { operation: "op", username: "Friend" },
      { operation: "kick", username: "@a" },
      { operation: "say", text: "hello\nop Friend" },
      { operation: "tell", username: "Friend", text: "hello\rban James" },
      { operation: "whitelist_add", username: "Friend", op: true },
    ])
      expect(() => serializeHostAdmin(command)).toThrow();
    expect(serializeHostAdmin({ operation: "gamerule", rule: "keepInventory", value: true })).toBe(
      "gamerule keepInventory true",
    );
    expect(serializeHostAdmin({ operation: "weather", value: "rain", durationSeconds: 30 })).toBe(
      "weather rain 30s",
    );
  });
  it("does not classify outages or inconsistent profile responses as offline friends", async () => {
    for (const response of [
      new Response("", { status: 429 }),
      new Response("", { status: 503 }),
      Response.json({ name: "OtherName", id: "a".repeat(32) }),
    ]) {
      const host = new MinecraftHost({ fetch: vi.fn().mockResolvedValue(response) });
      await expect(host.classify("Friend")).rejects.toThrow();
    }
    const host = new MinecraftHost({ fetch: vi.fn().mockResolvedValue(new Response("", { status: 404 })) });
    await expect(host.classify("Friend")).resolves.toBe("offline");
  });
  it("refuses a modified pinned jar rather than accepting existing installation bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "minecraft-host-checksum-"));
    temporary.push(dir);
    await writeFile(join(dir, "paper.jar"), "tampered");
    const download = vi.fn();
    const host = new MinecraftHost({ dataDir: dir, fetch: download });
    await expect(host.prepare()).rejects.toThrow("checksum mismatch");
    expect(download).not.toHaveBeenCalled();
  });
  it("requires enrollment and authentication readiness before whitelist and RCON effects", async () => {
    const command = vi.fn();
    const host = new MinecraftHost({ command });
    expect(() => host.admin({ operation: "whitelist_add", username: "Friend" })).toThrow("enrollment");
    await expect(host.admin({ operation: "gamerule", rule: "keepInventory", value: true })).rejects.toThrow(
      "auth-ready",
    );
    expect(command).not.toHaveBeenCalled();
    expect(JSON.stringify(host.status())).not.toMatch(/password|secret|rcon/iu);
  });
  it("reserves hosted bot identity and rejects arbitrary public bot-login endpoints", async () => {
    const host = new MinecraftHost();
    await expect(
      host.botLogin({ host: "example.com", port: 25684, username: "ClankieLocal26" }),
    ).resolves.toBeNull();
    await expect(
      host.botLogin({ host: "127.0.0.1", port: 25684, username: "ClankieLocal26" }),
    ).rejects.toThrow("auth-ready");
    expect(() => new MinecraftHost({ gamePort: 25684, rconPort: 25684 })).toThrow();
  });
});

describe("host run deadline", () => {
  it("stops idle worlds and caps a busy session across crash restarts", () => {
    expect(hostShouldStop(900000, 0, 0, 900000, 21600000)).toBe(true);
    expect(hostShouldStop(899999, 0, 0, 900000, 21600000)).toBe(false);
    expect(hostShouldStop(21600000, 0, 21600000, 900000, 21600000)).toBe(true);
    expect(hostShouldStop(21599999, 0, 21599999, 900000, 21600000)).toBe(false);
  });
});

it("consumes only the pinned AuthMe logger event, never player chat or another plugin", () => {
  expect(pinnedAuthLogin("> \r  \r[14:13:27 INFO]: [AuthMe] Friend logged in 127.0.0.1")).toBe("Friend");
  for (const line of [
    "[14:13:27 INFO]: <Friend> [AuthMe] Friend logged in 127.0.0.1",
    "[14:13:27 INFO]: [Other] Friend logged in 127.0.0.1",
    "[14:13:27 INFO]: [AuthMe] Friend used the wrong password",
    "[14:13:27 INFO]: [AuthMe] Friend logged in 127.0.0.1 extra",
  ])
    expect(pinnedAuthLogin(line)).toBeNull();
});
