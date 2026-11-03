import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  FileCredentialStore,
  ProtectedFirstCredentialStore,
  isProtectedCredentialId,
  loginProtectedIds,
  protectStoredCredentials,
  resolveCaptainCredential,
  type CredentialStore,
} from "../src/index.ts";

const roots: string[] = [];
async function stores() {
  const root = await mkdtemp(join(tmpdir(), "clankie-protected-"));
  roots.push(root);
  // Two real broker files stand in for the login and the protected keychains.
  return {
    login: new FileCredentialStore(join(root, "login.json")),
    protectedStore: new FileCredentialStore(join(root, "protected.json")),
  };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const CAPTAIN = "clankie_cap_" + "a".repeat(43);

it("names Clankie's own bearers and leaves provider accounts alone", () => {
  for (const id of [
    "clankie_captain",
    "clankie_operator",
    "clankie_discord_bridge",
    "clankie-joined-host-pc1",
  ])
    expect(isProtectedCredentialId(id), id).toBe(true);
  for (const id of ["openai", "anthropic", "email"]) expect(isProtectedCredentialId(id), id).toBe(false);
});

it("moves only Clankie's bearers out of the login keychain, once, and readers follow", async () => {
  const { login, protectedStore } = await stores();
  await login.set("clankie_captain", { type: "api", key: CAPTAIN });
  await login.set("clankie_discord_bridge", { type: "api", key: "clankie_bridge_" + "b".repeat(43) });
  await login.set("openai", { type: "api", key: "sk-provider" });
  expect(await loginProtectedIds(login)).toEqual(["clankie_captain", "clankie_discord_bridge"]);

  const moved = await protectStoredCredentials({ env: {}, legacy: login, primary: protectedStore });
  expect(moved).toEqual({ created: false, moved: ["clankie_captain", "clankie_discord_bridge"], failed: [] });
  expect(await login.get("clankie_captain")).toBeUndefined();
  expect(await login.get("openai")).toEqual({ type: "api", key: "sk-provider" });
  expect(await loginProtectedIds(login)).toEqual([]);
  // Idempotent: nothing left to move.
  expect((await protectStoredCredentials({ env: {}, legacy: login, primary: protectedStore })).moved).toEqual(
    [],
  );

  const owner = new ProtectedFirstCredentialStore({ legacy: login, primary: protectedStore });
  expect(await resolveCaptainCredential({ env: {}, store: owner })).toEqual({
    token: CAPTAIN,
    source: "store",
  });
  expect(await owner.get("openai")).toEqual({ type: "api", key: "sk-provider" });
});

it("reads the protected copy first, writes new bearers there, and keeps a pre-move copy readable", async () => {
  const { login, protectedStore } = await stores();
  const owner = new ProtectedFirstCredentialStore({ legacy: login, primary: protectedStore });
  await login.set("clankie_captain", { type: "api", key: CAPTAIN });
  expect(await owner.get("clankie_captain")).toEqual({ type: "api", key: CAPTAIN });
  await owner.set("clankie_play_voice", { type: "api", key: "new" });
  expect(await protectedStore.get("clankie_play_voice")).toEqual({ type: "api", key: "new" });
  expect(await login.get("clankie_play_voice")).toBeUndefined();
  await owner.set("openai", { type: "api", key: "sk" });
  expect(await protectedStore.get("openai")).toBeUndefined();
  expect(await owner.delete("clankie_captain")).toBe(true);
  expect(await owner.get("clankie_captain")).toBeUndefined();
});

it("a worker pane denied the protected keychain sees no protected bearer, and an owner process sees the fault", async () => {
  const { login } = await stores();
  const denied: CredentialStore = {
    get: async () => {
      throw new Error("Operation not permitted");
    },
    set: async () => undefined,
    delete: async () => false,
    list: async () => {
      throw new Error("Operation not permitted");
    },
  };
  const worker = new ProtectedFirstCredentialStore({ legacy: login, primary: denied, workerPane: true });
  expect(await worker.get("clankie_captain")).toBeUndefined();
  const owner = new ProtectedFirstCredentialStore({ legacy: login, primary: denied });
  await expect(owner.get("clankie_captain")).rejects.toThrow("Operation not permitted");
  await expect(
    protectStoredCredentials({ env: { CLANKIE_WORKER_PANE: "1" }, legacy: login, primary: denied }),
  ).rejects.toThrow("Hired workers");
});
