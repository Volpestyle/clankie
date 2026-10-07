import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createDefaultCredentialStore, FileCredentialStore } from "../../../credential-broker/src/index.ts";
import { defaultSettingsPath, SettingsStore } from "../../src/index.ts";

const settings = new SettingsStore();
const store = createDefaultCredentialStore({ platform: "darwin" });

it("isolates default stores, fallback paths and inherited child environments before imports", async () => {
  const home = homedir();
  const path = join(home, ".config", "clankie", "settings.json");
  expect(home).not.toBe(process.env.TEST_OWNER_HOME);
  expect(process.env.XDG_CONFIG_HOME).toBe(join(home, ".config"));
  expect(defaultSettingsPath()).toBe(path);
  expect(defaultSettingsPath({})).toBe(path);
  expect(process.env.DISCORD_BOT_TOKEN).toBeUndefined();
  expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  const temp = tmpdir();
  expect(temp).not.toBe(process.env.TEST_OWNER_TEMP);
  expect(process.env.TMP).toBe(temp);
  expect(process.env.TEMP).toBe(temp);
  if (process.platform !== "win32") {
    expect((await stat(temp)).mode & 0o777).toBe(0o700);
    const socketRoot = await mkdtemp(join(temp, "clankie-world-body-"));
    const socketPath = join(socketRoot, "host.sock");
    expect(Buffer.byteLength(socketPath)).toBeLessThan(104);
    const server = createServer((socket) => socket.end("isolated"));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      const response = await new Promise<string>((resolve, reject) => {
        const client = createConnection(socketPath);
        let data = "";
        client.on("data", (chunk) => (data += chunk.toString()));
        client.once("error", reject);
        client.once("end", () => resolve(data));
      });
      expect(response).toBe("isolated");
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  // Check the preload canary against synthetic owner paths, never live bytes.
  expect(() => readFile(join(process.env.TEST_OWNER_HOME!, ".config", "clankie", "settings.json"))).toThrow(
    "live_config_access_forbidden",
  );
  expect(() =>
    writeFile(join(process.env.TEST_OWNER_HOME!, ".config", "clankie", "settings.json"), "canary"),
  ).toThrow("live_config_access_forbidden");
  expect(() => execFile("/usr/bin/security", ["find-generic-password"])).toThrow(
    "live_keychain_access_forbidden",
  );
  expect(() => promisify(execFile)("/usr/bin/security", ["find-generic-password"])).toThrow(
    "live_keychain_access_forbidden",
  );

  expect((await settings.load()).schemaVersion).toBe(1);
  await settings.update((current) => ({
    ...current,
    persona: { ...current.persona, displayName: "Fixture" },
  }));
  const fenced = await settings.loadFenced();
  fenced.assertCurrent();
  expect(fenced.settings.persona.displayName).toBe("Fixture");

  // macOS must select the file backend too; no security subprocess is allowed.
  expect(store).toBeInstanceOf(FileCredentialStore);
  expect(await store.list()).toEqual({});
  await store.set("fixture", { type: "api", key: "synthetic-test-key" });
  expect(await store.get("fixture")).toEqual({ type: "api", key: "synthetic-test-key" });
  const credentialPath = process.env.CLANKIE_CREDENTIALS_FILE!;
  expect(JSON.parse(await readFile(credentialPath, "utf8"))).toHaveProperty("fixture");
  if (process.platform !== "win32") expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);

  const child = await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "-e",
    `import { SettingsStore } from ${JSON.stringify(new URL("../../src/index.ts", import.meta.url).href)};
     import { createDefaultCredentialStore } from ${JSON.stringify(new URL("../../../credential-broker/src/index.ts", import.meta.url).href)};
     import { tmpdir } from 'node:os';
     if (tmpdir() !== ${JSON.stringify(temp)}) throw new Error('child temp escaped');
     const settings = new SettingsStore();
     if ((await settings.load()).persona.displayName !== 'Fixture') throw new Error('child settings escaped');
     if ((await createDefaultCredentialStore().get('fixture'))?.key !== 'synthetic-test-key') throw new Error('child credentials escaped');
     await settings.update(current => ({...current, persona: {...current.persona, displayName: 'Child'}}));`,
  ]);
  expect(child.stderr).toBe("");
  expect((await settings.load()).persona.displayName).toBe("Child");
  console.log(`ISOLATED_HOME=${home}`);
  console.log(`ISOLATED_TEMP=${temp}`);
});
