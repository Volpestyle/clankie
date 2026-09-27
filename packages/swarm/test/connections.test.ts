import { mkdtemp, rm } from "node:fs/promises";
import { SettingsStore } from "@clankie/settings";
import { FileCredentialStore } from "@clankie/credential-broker";
import { afterEach, expect, it, vi } from "vitest";
import { connectExternal } from "../src/connections.ts";

const bootstrap = vi.hoisted(() => vi.fn());
vi.mock("swarm-mcp/runtime", () => ({
  CoordinationClient: { connect: async () => ({ request: bootstrap, close() {} }) },
}));
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const path = await mkdtemp("/tmp/swarm-connect-test-");
  directories.push(path);
  bootstrap.mockResolvedValue({ actor: "clankie", scope: "project" });
  const stores = {
    settings: new SettingsStore(`${path}/settings.json`),
    credentials: new FileCredentialStore(`${path}/credentials.json`),
    transport: { endpoint: vi.fn(async () => "/tmp/private/local.sock"), close: vi.fn() },
  };
  const input = {
    id: "rivals",
    conversationId: "global-default",
    ssh: "pc",
    endpoint: String.raw`\\.\pipe\owner`,
    capability: "s".repeat(64),
  };
  return { stores, input };
}

it("passes no capability to the transport and pins the SSH target before another import", async () => {
  const { stores, input } = await fixture();
  await connectExternal(stores, input);
  expect(stores.transport.endpoint).toHaveBeenCalledExactlyOnceWith({
    id: "rivals",
    ssh: "pc",
    endpoint: input.endpoint,
  });
  expect((await stores.settings.load()).swarm.connections[0]).toMatchObject({
    ssh: "pc",
    endpoint: input.endpoint,
    actor: "clankie",
  });
  await expect(connectExternal(stores, { ...input, ssh: "other" })).rejects.toThrow("pinned");
  expect(stores.transport.endpoint).toHaveBeenCalledTimes(1);
  expect(stores.transport.close).not.toHaveBeenCalled();
});

it("closes a new link on failed authentication without saving a connection", async () => {
  const { stores, input } = await fixture();
  bootstrap.mockRejectedValueOnce(new Error("unauthorized"));
  await expect(connectExternal(stores, input)).rejects.toThrow("unauthorized");
  expect(stores.transport.close).toHaveBeenCalledWith("rivals");
  expect((await stores.settings.load()).swarm.connections).toEqual([]);
});

it("removes the link and broker credential when settings persistence fails", async () => {
  const { stores, input } = await fixture();
  vi.spyOn(stores.settings, "update").mockRejectedValueOnce(new Error("save failed"));
  const remove = vi.spyOn(stores.credentials, "delete");
  await expect(connectExternal(stores, input)).rejects.toThrow("save failed");
  expect(remove).toHaveBeenCalledOnce();
  expect(stores.transport.close).toHaveBeenCalledWith("rivals");
});
