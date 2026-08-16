import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationStore, type ConversationTurnContext } from "../src/captain/conversations.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clankie-conversation-workspace-"));
  roots.push(root);
  return root;
}

describe("workspace-scoped operator conversations", () => {
  it("hands each turn the directory its conversation works in", async () => {
    const root = await temporaryRoot();
    const workspace = await temporaryRoot();
    const contexts: ConversationTurnContext[] = [];
    const store = new ConversationStore(root, async (_conversationId, _message, _publish, context) => {
      contexts.push(context);
    });

    const created = await store.serve({
      op: "create",
      schemaVersion: 1,
      scope: { kind: "workspace", workspaceId: workspace },
      title: "thing",
    });
    if (created.op !== "create") throw new Error("conversation was not created");

    for (const conversationId of [created.conversation.conversationId, "global-default"]) {
      const sent = await store.serve({
        op: "send",
        schemaVersion: 1,
        turn: {
          schemaVersion: 1,
          kind: "message",
          conversationId,
          surfaceClientId: "test",
          expectedRevision: 0,
          message: "where are you",
          herdrPaneId: "pane-3",
        },
      });
      if (sent.op !== "send" || sent.result.status !== "accepted") throw new Error("turn was not accepted");
      await store.awaitRun(sent.result.runId);
    }

    expect(contexts).toEqual([
      { workspace, seat: { herdrPaneId: "pane-3" } },
      // A global conversation names no workspace; the captain stays in his repo.
      { seat: { herdrPaneId: "pane-3" } },
    ]);
    await store.close();
  });

  it("refuses a workspace that is not an absolute directory on this machine", async () => {
    const root = await temporaryRoot();
    const workspace = await temporaryRoot();
    const file = join(workspace, "README.md");
    await writeFile(file, "# hi\n", "utf8");
    const store = new ConversationStore(root, async () => undefined);

    const create = (workspaceId: string) =>
      store.serve({
        op: "create",
        schemaVersion: 1,
        scope: { kind: "workspace", workspaceId },
        title: "thing",
      });
    await expect(create("relative/path")).rejects.toThrow(/not an absolute path/u);
    await expect(create(file)).rejects.toThrow(/not a directory/u);
    await expect(create(join(workspace, "ghost"))).rejects.toThrow(/not a directory/u);
    await expect(create(workspace)).resolves.toMatchObject({ op: "create" });
    await store.close();
  });
});
