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
          appendEpisode: () => Promise.resolve({ corrected: false, retained: false }),
          recallEpisodeCard: (lane) => {
            recalled.push(lane);
            return Promise.resolve("## recent\n- won the badge");
          },
          searchEpisodeCard: () => Promise.resolve(""),
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
          appendEpisode: () => Promise.resolve({ corrected: false, retained: false }),
          recallEpisodeCard: () => Promise.reject(new Error("offline")),
          searchEpisodeCard: () => Promise.resolve(""),
        },
        "operator",
      ),
    );
    await expect(unavailable({ systemPrompt: "base" })).resolves.toBeUndefined();
  });

  it("says the memory is empty rather than leaving it out of the prompt", async () => {
    const handler = await beforeAgentStartHandler(
      captainMemoryExtension(
        {
          appendEpisode: () => Promise.resolve({ corrected: false, retained: false }),
          recallEpisodeCard: () => Promise.resolve(""),
          searchEpisodeCard: () => Promise.resolve(""),
        },
        "discord_presence",
      ),
    );

    const result = (await handler({ systemPrompt: "base" })) as { systemPrompt: string };
    expect(result.systemPrompt).toContain("What you remember doing recently");
    expect(result.systemPrompt).toContain("remember_episode");
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
          return Promise.resolve({ corrected: false, retained: input.retained ?? false });
        },
        recallEpisodeCard: () => Promise.resolve(""),
        searchEpisodeCard: () => Promise.resolve(""),
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

  it("carries his retain and correct choices, and tells him what actually happened", async () => {
    const writes: Parameters<CaptainDeps["memory"]["appendEpisode"]>[0][] = [];
    const searched: string[] = [];
    const deps = {
      embodiment: {
        submitIntent: () => Promise.reject(new Error("unused")),
        getSession: () => Promise.reject(new Error("unused")),
        getLiveSession: () => Promise.reject(new Error("unused")),
      },
      memory: {
        appendEpisode: (input: Parameters<CaptainDeps["memory"]["appendEpisode"]>[0]) => {
          writes.push(input);
          // The full shelf answers rather than throwing: the note was written, unkept.
          return Promise.resolve(
            input.retained === true
              ? { corrected: false, retained: false, retentionRefused: "Retained memory is full." }
              : { corrected: input.corrects !== undefined, retained: false },
          );
        },
        recallEpisodeCard: () => Promise.resolve(""),
        searchEpisodeCard: (_lane: string, query: string) => {
          searched.push(query);
          return Promise.resolve('## What you remember about "gateway"\n- operator · self · 2026-08-01');
        },
      },
    } as unknown as CaptainDeps;
    const tools = captainTools(deps, { targetId: "global-default" }, {} as LaneLog, "operator");
    const remember = tools.find((candidate) => candidate.name === "remember_episode");
    const recall = tools.find((candidate) => candidate.name === "recall_episodes");
    if (remember === undefined || recall === undefined) throw new Error("memory tools are missing");

    const refused = await remember.execute(
      "call-1",
      { summary: "Keep this one.", retain: true },
      undefined,
      undefined,
      {} as never,
    );
    expect(writes[0]).toMatchObject({ retained: true, summary: "Keep this one." });
    expect(refused.details).toMatchObject({
      remembered: true,
      retained: false,
      retentionRefused: "Retained memory is full.",
    });

    const corrected = await remember.execute(
      "call-2",
      { summary: "Actually 4321.", corrects: "decision-1" },
      undefined,
      undefined,
      {} as never,
    );
    expect(writes[1]).toMatchObject({ corrects: "decision-1" });
    expect(corrected.details).toMatchObject({ remembered: true, corrected: true });

    const found = await recall.execute("call-3", { query: "gateway" }, undefined, undefined, {} as never);
    expect(searched).toEqual(["gateway"]);
    expect((found.details as { card: string }).card).toContain("operator · self");
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
