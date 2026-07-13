import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OperatorConversation } from "@clankie/protocol";
import {
  createCaptainOperatorConversationClient,
  OperatorConversationSelection,
  OperatorConversationSelectionStore,
  OperatorConversationSelectionStoreError,
  parseDirectConversation,
  resolveInitialConversation,
  type OperatorConversationClient,
} from "../src/session/operator-conversations.ts";

const DEFAULT: OperatorConversation = {
  schemaVersion: 1,
  conversationId: "global-default",
  scope: { kind: "global" },
  title: "Clankie",
  isDefault: true,
  createdAt: "2026-07-12T00:00:00.000Z",
  updatedAt: "2026-07-12T00:00:00.000Z",
  sessionState: "active",
  revision: 2,
};
const WORKSPACE: OperatorConversation = {
  ...DEFAULT,
  conversationId: "workspace-1",
  title: "Workspace",
  isDefault: false,
  scope: { kind: "workspace", workspaceId: "w1" },
};

function client(extra: OperatorConversation[] = []): OperatorConversationClient {
  const conversations = [DEFAULT, ...extra];
  return {
    list: async () => conversations,
    get: async (id) => conversations.find((conversation) => conversation.conversationId === id),
    create: async (input) => ({ ...DEFAULT, ...input, conversationId: "created", isDefault: false }),
    replay: async (input) => ({
      schemaVersion: 1,
      status: "page",
      conversationId: input.conversationId,
      surfaceClientId: input.surfaceClientId,
      events: [],
      retainedFromCursor: "event:0",
      nextCursor: input.cursor ?? "event:0",
      safeCursor: "event:0",
      hasMore: false,
    }),
    tail: async function* () {},
    send: async (input) => ({
      schemaVersion: 1,
      status: "accepted",
      conversationId: input.conversationId,
      runId: "run:test",
      revision: input.expectedRevision + 1,
      safeCursor: "event:1",
    }),
  };
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function tempStore(): Promise<OperatorConversationSelectionStore> {
  const root = await mkdtemp(join(tmpdir(), "operator-selection-"));
  roots.push(root);
  return new OperatorConversationSelectionStore(join(root, "nested", "operator-conversation.json"));
}

describe("TUI operator conversation selection", () => {
  it("enumerates and selects the server-owned default across restart", async () => {
    const first = new OperatorConversationSelection(client());
    expect((await first.selectDefault()).conversationId).toBe("global-default");
    const restarted = new OperatorConversationSelection(client(), first.conversationId);
    expect((await restarted.select(restarted.conversationId as string)).conversationId).toBe(
      "global-default",
    );
  });

  it("supports the stable direct --chat form without inventing a conversation", () => {
    expect(parseDirectConversation(["--chat", "workspace-chat"])).toEqual({
      conversationId: "workspace-chat",
      remaining: [],
    });
    expect(() => parseDirectConversation(["--chat"])).toThrow(/--chat <conversationId>/u);
  });

  it("persists and reloads the selected conversation atomically across restart", async () => {
    const store = await tempStore();
    expect(await store.read()).toBeUndefined(); // ENOENT -> no selection
    await store.write("workspace-1");
    expect(await store.read()).toBe("workspace-1");
    // A fresh process (new store instance, same path) reloads it.
    const reopened = new OperatorConversationSelectionStore((store as unknown as { path: string }).path);
    expect(await reopened.read()).toBe("workspace-1");
  });

  it("fails closed on a corrupt or wrong-version selection store", async () => {
    const store = await tempStore();
    const path = (store as unknown as { path: string }).path;
    await store.write("global-default"); // creates the parent dir
    await writeFile(path, "{ not json", "utf8");
    await expect(store.read()).rejects.toBeInstanceOf(OperatorConversationSelectionStoreError);
    await writeFile(path, JSON.stringify({ version: 2, conversationId: "x" }), "utf8");
    await expect(store.read()).rejects.toBeInstanceOf(OperatorConversationSelectionStoreError);
    await store.write("bad".repeat(1)); // valid id write still works
    expect(await store.read()).toBe("bad");
  });

  it("confirms --chat and persisted selections against the server before attaching", async () => {
    const store = await tempStore();
    // --chat confirmed via get(), then persisted.
    const confirmed = await resolveInitialConversation({
      client: client([WORKSPACE]),
      store,
      directConversationId: "workspace-1",
    });
    expect(confirmed.conversationId).toBe("workspace-1");
    expect(await store.read()).toBe("workspace-1");
    // Restart: persisted selection reloads and is confirmed.
    const reloaded = await resolveInitialConversation({ client: client([WORKSPACE]), store });
    expect(reloaded.conversationId).toBe("workspace-1");
    // A --chat for an unknown id is rejected, never silently attached.
    await expect(
      resolveInitialConversation({ client: client([WORKSPACE]), store, directConversationId: "ghost" }),
    ).rejects.toThrow(/Unknown operator conversation/u);
    // A persisted id the server no longer knows is dropped, falling back to default.
    const stale = await resolveInitialConversation({ client: client(), store });
    expect(stale.conversationId).toBe("global-default");
    expect(await store.read()).toBeUndefined();
  });

  it("builds a production client over an authenticated Client.fetch transport", async () => {
    const captain = createCaptainOperatorConversationClient({
      fetch: async (path, init) => {
        expect(path).toBe("/operator/v1/dispatch");
        const request = JSON.parse(String(init?.body)) as { op: string };
        if (request.op === "list") {
          return new Response(JSON.stringify({ op: "list", schemaVersion: 1, conversations: [DEFAULT] }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ op: "get", schemaVersion: 1, conversation: DEFAULT }), {
          status: 200,
        });
      },
    });
    expect((await captain.list()).some((conversation) => conversation.isDefault)).toBe(true);
    expect((await captain.get("global-default"))?.conversationId).toBe("global-default");
  });
});
