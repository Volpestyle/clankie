import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { LinearTrackerClient, type LinearClient } from "../src/index.ts";

const enabled = process.env.CLANKIE_LINEAR_LIVE_SMOKE === "1";

describe.skipIf(!enabled)("owner-only Linear OAuth app smoke", () => {
  it("reads through an owner-supplied actor=app client", async () => {
    const modulePath = process.env.CLANKIE_LINEAR_LIVE_CLIENT_MODULE;
    const issueId = process.env.CLANKIE_LINEAR_LIVE_ISSUE_ID;
    if (!modulePath || !issueId) {
      throw new Error("CLANKIE_LINEAR_LIVE_CLIENT_MODULE and CLANKIE_LINEAR_LIVE_ISSUE_ID are required");
    }
    const loaded = (await import(pathToFileURL(modulePath).href)) as {
      createLinearClient?: () => Promise<LinearClient> | LinearClient;
    };
    if (!loaded.createLinearClient) throw new Error("Live module must export createLinearClient()");
    const connector = new LinearTrackerClient(await loaded.createLinearClient());
    const ref = { connector: "linear", workspaceId: "live", issueId } as const;
    await expect(connector.getAppIdentity()).resolves.toMatchObject({ kind: "app" });
    await expect(connector.getIssue(ref)).resolves.toMatchObject({ ref: { issueId } });
    await expect(
      connector.postComment({
        ref,
        body: "Clankie tracker connector owner-only live smoke.",
        idempotencyKey: `clankie:live-smoke:${issueId}`,
      }),
    ).resolves.toMatchObject({ commentId: expect.any(String) });
  });
});
