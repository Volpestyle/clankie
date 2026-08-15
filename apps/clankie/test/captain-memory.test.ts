import type { CaptainSessionLaneV2 } from "@clankie/protocol";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { captainMemoryExtension } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { LaneLog } from "../src/captain/lane-log.ts";
import { captainTools } from "../src/captain/tools.ts";

describe("captain memory", () => {
  it("refreshes trusted episodic recall in the system prompt and fails open", async () => {
    const recalled: CaptainSessionLaneV2[] = [];
    const handler = await beforeAgentStartHandler(
      captainMemoryExtension(
        {
          appendEpisode: () => Promise.resolve(),
          recallEpisodeCard: (lane) => {
            recalled.push(lane);
            return Promise.resolve("## recent\n- won the badge");
          },
        },
        "discord_presence",
      ),
    );

    await expect(handler({ systemPrompt: "base" })).resolves.toEqual({
      systemPrompt: "base\n\n## recent\n- won the badge",
    });
    expect(recalled).toEqual(["discord_presence"]);

    const unavailable = await beforeAgentStartHandler(
      captainMemoryExtension(
        {
          appendEpisode: () => Promise.resolve(),
          recallEpisodeCard: () => Promise.reject(new Error("offline")),
        },
        "operator",
      ),
    );
    await expect(unavailable({ systemPrompt: "base" })).resolves.toBeUndefined();
  });

  it("stamps remember_episode with the host room instead of model input", async () => {
    const writes: Parameters<CaptainDeps["memory"]["appendEpisode"]>[0][] = [];
    const deps = {
      embodiment: {
        submitIntent: () => Promise.reject(new Error("unused")),
        getSession: () => Promise.reject(new Error("unused")),
        getLiveSession: () => Promise.reject(new Error("unused")),
      },
      memory: {
        appendEpisode: (input: Parameters<CaptainDeps["memory"]["appendEpisode"]>[0]) => {
          writes.push(input);
          return Promise.resolve();
        },
        recallEpisodeCard: () => Promise.resolve(""),
      },
    } as unknown as CaptainDeps;
    const tool = captainTools(
      deps,
      { targetId: "guild-1:channel-1" },
      {} as LaneLog,
      "discord_presence",
    ).find((candidate) => candidate.name === "remember_episode");
    if (tool === undefined) throw new Error("remember_episode is missing");

    await tool.execute(
      "call-1",
      { summary: "Beat Roxanne", visibility: "shareable" },
      undefined,
      undefined,
      {} as never,
    );

    expect(writes).toEqual([
      {
        lane: "discord_presence",
        targetId: "guild-1:channel-1",
        summary: "Beat Roxanne",
        visibility: "shareable",
      },
    ]);
  });
});

async function beforeAgentStartHandler(extension: ReturnType<typeof captainMemoryExtension>) {
  let handler: ((event: { systemPrompt: string }) => Promise<unknown>) | undefined;
  await extension.factory({
    on(event: string, candidate: (event: { systemPrompt: string }) => Promise<unknown>) {
      if (event === "before_agent_start") handler = candidate;
    },
  } as unknown as ExtensionAPI);
  if (handler === undefined) throw new Error("before_agent_start handler is missing");
  return handler;
}
