/** Manual-only real Paper/AuthMe/FastLogin boundary, using pre-provisioned immutable artifacts. */
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FileCredentialStore } from "@clankie/credential-broker";
import mineflayer, { type Bot } from "mineflayer";
import { expect, test } from "vitest";
import { MinecraftHost } from "../src/hosting.ts";

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function copyImmutableArtifacts(source: string, destination: string) {
  // Never copy an account DB, credential, config, world, or existing process state.
  for (const file of [
    "paper.jar",
    "plugins/AuthMe.jar",
    "plugins/FastLoginBukkit.jar",
    "plugins/ProtocolLib.jar",
    "plugins/ViaVersion.jar",
  ]) {
    await mkdir(join(destination, file, ".."), { recursive: true });
    await cp(join(source, file), join(destination, file));
  }
  for (const directory of ["cache", "libraries", "versions"])
    await cp(join(source, directory), join(destination, directory), { recursive: true });
}

function authMeAccount(dataDir: string, name: string) {
  const db = new DatabaseSync(join(dataDir, "plugins/AuthMe/authme.db"), { readOnly: true });
  try {
    return db
      .prepare("SELECT username, password FROM authme WHERE LOWER(username) = ?")
      .get(name.toLowerCase());
  } finally {
    db.close();
  }
}

function client(port: number, name: string) {
  return mineflayer.createBot({
    host: "127.0.0.1",
    port,
    username: name,
    version: "1.21.4",
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

async function commandReply(bot: Bot, command: string, expected: string) {
  await new Promise<void>((resolve, reject) => {
    let commandTimer: ReturnType<typeof setTimeout> | undefined;
    const observed: string[] = [];
    const safe = (text: string) => text.replace(/[a-f0-9]{24,}/giu, "[REDACTED]").slice(0, 512);
    const timer = setTimeout(
      () => finish(new Error(`AuthMe '${expected}' reply absent; observed: ${observed.join(" | ")}`)),
      15000,
    );
    const scheduleCommand = () => {
      if (commandTimer) return;
      commandTimer = setTimeout(() => bot.chat(command), 1500);
    };
    const onMessage = (message: string) => {
      observed.push(safe(message));
      if (observed.length > 5) observed.shift();
      // AuthMe can prompt an unregistered player before mineflayer's spawn
      // event; its own prompt proves the command handler is available.
      if (/\/(?:register|login)\b/iu.test(message)) scheduleCommand();
      if (message === expected) finish();
    };
    const onEnd = () => finish(new Error(`AuthMe client disconnected before '${expected}' reply`));
    const onError = () => finish(new Error("AuthMe client transport failed"));
    const onKicked = (reason: unknown) => {
      const text = (JSON.stringify(reason) ?? "").toLowerCase();
      const category = /throttl/u.test(text)
        ? "connection throttle"
        : /command too fast/u.test(text)
          ? "join command throttle"
          : /whitelist|white.?list/u.test(text)
            ? "whitelist"
            : /register/u.test(text)
              ? "registration"
              : /owner|restricted|ip/u.test(text)
                ? "identity restriction"
                : /premium|verify|authenticate/u.test(text)
                  ? "account authentication"
                  : "server rejection";
      finish(new Error(`AuthMe client rejected before '${expected}' reply (${category}): ${safe(text)}`));
    };
    const finish = (error?: Error) => {
      clearTimeout(timer);
      clearTimeout(commandTimer);
      bot.off("messagestr", onMessage);
      bot.off("end", onEnd);
      bot.off("error", onError);
      bot.off("kicked", onKicked);
      bot.off("spawn", onSpawn);
      if (error) reject(error);
      else resolve();
    };
    bot.on("messagestr", onMessage);
    bot.once("end", onEnd);
    bot.once("error", onError);
    bot.once("kicked", onKicked);
    const onSpawn = () => {
      // AuthMe rejects registration sent before its post-join anti-bot gate settles.
      scheduleCommand();
    };
    bot.once("spawn", onSpawn);
  });
}

test.skipIf(process.env.MINECRAFT_AUTH_INTEGRATION !== "1")(
  "owner premium enrollment registers AuthMe once while cracked in-game registration stays closed",
  async () => {
    const artifacts = process.env.MINECRAFT_AUTH_ARTIFACTS;
    assert.ok(artifacts, "MINECRAFT_AUTH_ARTIFACTS must point at the already provisioned pinned stack");
    const dataDir = await mkdtemp(join(tmpdir(), "clankie-premium-real-"));
    const credentials = new FileCredentialStore(join(dataDir, "private-credentials.json"));
    const gamePort = await freePort();
    const rconPort = await freePort();
    const host = new MinecraftHost({
      dataDir,
      credentials,
      gamePort,
      rconPort,
      memoryMiB: 1024,
      idleTimeoutMs: 900000,
    });
    const clients: Bot[] = [];
    try {
      await copyImmutableArtifacts(artifacts, dataDir);
      const ready = await host.start();
      expect(ready.authReady).toBe(true);
      const name = "Notch";
      expect(authMeAccount(dataDir, name)).toBeUndefined();
      expect(await host.enroll(name)).toEqual({ username: name, classification: "premium" });
      const account = authMeAccount(dataDir, name);
      assert.ok(account && typeof account.password === "string" && account.password.length > 0);
      const originalHash = account.password;
      const premiumDb = new DatabaseSync(join(dataDir, "plugins/FastLogin/FastLogin.db"), {
        readOnly: true,
      });
      try {
        expect(
          Number(
            premiumDb.prepare("SELECT Premium FROM premium WHERE LOWER(Name) = ?").get("notch")?.Premium,
          ),
        ).toBe(1);
      } finally {
        premiumDb.close();
      }
      await host.admin({ operation: "whitelist_add", username: name });
      expect(await host.enroll(name)).toEqual({ username: name, classification: "premium" });
      expect(authMeAccount(dataDir, name)?.password === originalHash).toBe(true);
      expect(await credentials.get("clankie_minecraft_friend_notch")).toBeUndefined();

      const botSecret = await host.botLogin(ready.gameEndpoint);
      assert.ok(botSecret);
      const bot = client(gamePort, ready.botUsername);
      clients.push(bot);
      await commandReply(bot, `/login ${botSecret}`, "Successful login!");

      const friendName = "ClankiePass26";
      const friendEnrollment = await host.enroll(friendName);
      expect(friendEnrollment.classification).toBe("nonpremium");
      assert.ok(friendEnrollment.providerId);
      const friendCredential = await credentials.get(friendEnrollment.providerId);
      assert.ok(friendCredential?.type === "api");
      await host.admin({ operation: "whitelist_add", username: friendName });
      const friend = client(gamePort, friendName);
      clients.push(friend);
      await commandReply(friend, `/login ${friendCredential.key}`, "Successful login!");
      await expect
        .poll(() => credentials.get(friendEnrollment.providerId!), { timeout: 7000 })
        .toBeUndefined();

      const repairName = "jeb_";
      const unwhitelistedName = "Dinnerbone";
      expect(await host.enroll(repairName)).toEqual({ username: repairName, classification: "premium" });
      await host.admin({ operation: "whitelist_add", username: repairName });
      expect(await host.enroll(unwhitelistedName)).toEqual({
        username: unwhitelistedName,
        classification: "premium",
      });
      for (const connected of clients.splice(0)) connected.quit();
      await host.stop();
      const whitelistBefore = await readFile(join(dataDir, "whitelist.json"), "utf8");
      const fixtureDb = new DatabaseSync(join(dataDir, "plugins/AuthMe/authme.db"));
      try {
        // Simulate the old premium-enrollment bug only in this stopped fixture.
        const remove = fixtureDb.prepare("DELETE FROM authme WHERE LOWER(username) = ?");
        remove.run(repairName.toLowerCase());
        remove.run(unwhitelistedName.toLowerCase());
      } finally {
        fixtureDb.close();
      }
      expect(authMeAccount(dataDir, repairName)).toBeUndefined();
      expect(authMeAccount(dataDir, unwhitelistedName)).toBeUndefined();
      expect((await host.start()).authReady).toBe(true);
      const repaired = authMeAccount(dataDir, repairName);
      expect(typeof repaired?.password === "string" && repaired.password.length > 0).toBe(true);
      expect(authMeAccount(dataDir, name)?.password === originalHash).toBe(true);
      expect(authMeAccount(dataDir, unwhitelistedName)).toBeUndefined();
      expect(await readFile(join(dataDir, "whitelist.json"), "utf8")).toBe(whitelistBefore);

      const crackedName = "ClankieNoReg26";
      // Fixture setup uses the real private RCON transport to reach AuthMe's
      // registration gate without enrollment having created an account first.
      const fixtureConsole = host as unknown as { command(command: string): Promise<string> };
      await fixtureConsole.command(`whitelist add ${crackedName}`);
      const cracked = client(gamePort, crackedName);
      clients.push(cracked);
      await commandReply(
        cracked,
        "/register fixturePassword26 fixturePassword26",
        "In order to use this command you must be authenticated!",
      );
      expect(authMeAccount(dataDir, crackedName)).toBeUndefined();
      const authMeConfig = (await readFile(join(dataDir, "plugins/AuthMe/config.yml"), "utf8")).replace(
        /^[ \t]*#.*$/gmu,
        "",
      );
      expect(/registration:\s+enabled: false/u.test(authMeConfig)).toBe(true);
      expect(/useAsyncTasks: true/u.test(authMeConfig)).toBe(true);
      // A positive premium Mojang-session join is a separate live acceptance.
    } finally {
      for (const bot of clients) bot.quit();
      await host.stop();
      expect(host.status().phase).toBe("stopped");
      await rm(dataDir, { recursive: true, force: true });
    }
  },
  180000,
);
