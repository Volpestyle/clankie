import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";

it("refuses managed local native hires through the real operator service before native startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "managed-native-hires-"));
  const detail = "Managed Clankie uses AI credits only. Hire on linked self-hosted hardware instead.";
  const captain = createCaptain(
    {
      herdrAvailable: () => true,
      localNativeHireRefusal: detail,
    } as CaptainDeps,
    {
      repoRoot: root,
      stateDir: root,
      settings: new SettingsStore(join(root, "settings.json")),
    },
  );
  try {
    const created = await captain.serveOperatorConversation({
      schemaVersion: 1,
      op: "create",
      scope: { kind: "global" },
      title: "Managed hire proof",
    });
    if (created.op !== "create") throw Error("create expected");
    for (const harness of ["claude", "codex"] as const) {
      const result = await captain.serveOperatorConversation({
        schemaVersion: 1,
        op: "spawn_seat",
        conversationId: created.conversation.conversationId,
        seat: { schemaVersion: 1, harness, title: "Refused managed hire", workingDirectory: root },
      });
      expect(result).toMatchObject({
        op: "spawn_seat",
        result: { outcome: "failed", reason: "not_ready", detail },
      });
    }
  } finally {
    captain.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
