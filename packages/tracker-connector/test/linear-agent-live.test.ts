import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { LinearAgentClient } from "../src/index.ts";

const enabled = process.env.CLANKIE_LINEAR_AGENT_LIVE_SMOKE === "1";

describe.skipIf(!enabled)("owner-only Linear app-agent smoke", () => {
  it("queries a session and emits idempotent activity and reaction mutations", async () => {
    const modulePath = process.env.CLANKIE_LINEAR_LIVE_CLIENT_MODULE;
    const agentSessionId = process.env.CLANKIE_LINEAR_LIVE_AGENT_SESSION_ID;
    const issueId = process.env.CLANKIE_LINEAR_LIVE_ISSUE_ID;
    const activityId = process.env.CLANKIE_LINEAR_LIVE_ACTIVITY_ID;
    const reactionId = process.env.CLANKIE_LINEAR_LIVE_REACTION_ID;
    if (!modulePath || !agentSessionId || !issueId || !activityId || !reactionId) {
      throw new Error(
        "CLANKIE_LINEAR_LIVE_CLIENT_MODULE, CLANKIE_LINEAR_LIVE_AGENT_SESSION_ID, " +
          "CLANKIE_LINEAR_LIVE_ISSUE_ID, CLANKIE_LINEAR_LIVE_ACTIVITY_ID, and " +
          "CLANKIE_LINEAR_LIVE_REACTION_ID are required",
      );
    }
    const loaded = (await import(pathToFileURL(modulePath).href)) as {
      createLinearAgentClient?: () => Promise<LinearAgentClient> | LinearAgentClient;
    };
    if (!loaded.createLinearAgentClient) {
      throw new Error("Live module must export createLinearAgentClient()");
    }
    const client = await loaded.createLinearAgentClient();
    await expect(client.getAgentSession(agentSessionId)).resolves.toMatchObject({
      id: agentSessionId,
      appUser: { id: client.identity.appUserId },
    });
    await expect(
      client.createAgentActivity({
        agentSessionId,
        activityId,
        content: { type: "thought", body: "Clankie owner-only Linear agent smoke." },
      }),
    ).resolves.toMatchObject({ id: activityId, content: { type: "thought" } });
    await expect(client.reactionCreate({ issueId, reactionId, emoji: "eyes" })).resolves.toMatchObject({
      id: reactionId,
      emoji: "eyes",
    });
  });
});
