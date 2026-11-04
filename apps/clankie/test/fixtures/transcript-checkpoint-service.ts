// A disposable conversation service: real store, parser and HTTP replay, no
// provider, pane, screen, account, native admission or model turn.
import { serve } from "@hono/node-server";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { ConversationStore } from "../../src/captain/conversations.ts";
import { readHerdrSeatTranscript, type HerdrTranscriptEntry } from "../../src/captain/herdr-transcript.ts";

const root = process.argv[2]!;
if (!root || resolve(root) !== resolve(homedir()) || process.env.NODE_ENV !== "test")
  throw new Error("Checkpoint fixture requires its scratch HOME and NODE_ENV=test");
const store = new ConversationStore(join(root, "conversations"), async () => {});
const id = store.defaultGlobalConversationId();
const server = serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async () => {
    const replay = {
      schemaVersion: 1 as const,
      conversationId: id,
      surfaceClientId: "checkpoint-fixture",
      limit: 500,
    };
    let result = await store.serve({ op: "replay", schemaVersion: 1, replay });
    if (result.op === "replay" && result.result.status === "recover")
      result = await store.serve({
        op: "replay",
        schemaVersion: 1,
        replay: { ...replay, cursor: result.result.resetCursor },
      });
    return Response.json(result);
  },
});
server.once("listening", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture HTTP address");
  process.send?.({ ready: true, port: address.port });
});
process.on("message", async (raw) => {
  const command = raw as { id: number; action: string; file?: string; entries?: HerdrTranscriptEntry[] };
  try {
    let result: unknown;
    if (command.action === "sync") {
      const transcript = readHerdrSeatTranscript("codex", {
        source: "herdr:codex",
        kind: "path",
        value: join(root, command.file ?? "rollout.jsonl"),
      });
      if (!transcript) throw new Error("Fixture transcript did not parse");
      store.syncHeadTranscript("fixture-head", transcript);
      const path = join(root, "conversations", id, "meta.json");
      const meta = JSON.parse(readFileSync(path, "utf8"));
      result = {
        tailEntries: transcript.entries.length,
        checkpoint: meta.seatTranscript,
        checkpointBytes: Buffer.byteLength(JSON.stringify(meta.seatTranscript)),
        metaBytes: statSync(path).size,
      };
    } else if (command.action === "save") {
      store.rememberNativeHead(id, "metadata-save-only");
      result = true;
    } else if (command.action === "hook") {
      result = store.syncNativeSeatTranscript(
        id,
        "8805423d-89cc-42a7-b4a8-cd692c722c00",
        command.entries ?? [],
      );
    } else if (command.action === "reset") {
      result = await store.serve({
        op: "reset",
        schemaVersion: 1,
        conversationId: id,
        expectedRevision: store.conversation(id)!.revision,
      });
    } else throw new Error("Unknown checkpoint fixture command");
    process.send?.({ id: command.id, result });
  } catch (error) {
    process.send?.({ id: command.id, error: String(error) });
  }
});
process.once("disconnect", () => process.exit(0));
