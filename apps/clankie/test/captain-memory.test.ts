import type { CaptainSessionLaneV2 } from "@clankie/protocol";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { captainMemoryExtension } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { LaneLog } from "../src/captain/lane-log.ts";
import { captainTools } from "../src/captain/tools.ts";

describe("captain memory", () => {
  it("offers delivered files only to a host-authorized turn and returns its published descriptor", async () => {
    const deps = {
      embodiment: {
        submitIntent: () => Promise.reject(new Error("unused")),
        getSession: () => Promise.reject(new Error("unused")),
        getLiveSession: () => Promise.reject(new Error("unused")),
      },
    } as unknown as CaptainDeps;
    expect(
      captainTools(deps, {}, {} as LaneLog, "discord_presence").some((tool) => tool.name === "deliver_file"),
    ).toBe(false);
    const published = {
      artifactId: "artifact-1",
      filename: "report.pdf",
      mediaType: "application/pdf",
      byteCount: 12,
      sha256: "0".repeat(64),
    };
    const tool = captainTools(
      deps,
      { publishFile: async () => published },
      {} as LaneLog,
      "discord_presence",
    ).find((candidate) => candidate.name === "deliver_file");
    if (tool === undefined) throw new Error("deliver_file is missing");
    await expect(
      tool.execute("call", { path: "build/report.pdf" }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({ details: published });
  });

  it("refreshes trusted memory in the system prompt and fails open", async () => {
    const recalled: CaptainSessionLaneV2[] = [];
    const handler = await beforeAgentStartHandler(
      captainMemoryExtension(
        {
          writeMemory: () => Promise.resolve({ id: "unused", text: "unused" }),
          editMemory: () => Promise.resolve(undefined),
          forgetMemory: () => Promise.resolve(false),
          recallMemoryCard: (lane) => {
            recalled.push(lane);
            return Promise.resolve("## recent\n- won the badge");
          },
          searchMemory: () => Promise.resolve(""),
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
          writeMemory: () => Promise.resolve({ id: "unused", text: "unused" }),
          editMemory: () => Promise.resolve(undefined),
          forgetMemory: () => Promise.resolve(false),
          recallMemoryCard: () => Promise.reject(new Error("offline")),
          searchMemory: () => Promise.resolve(""),
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
          writeMemory: () => Promise.resolve({ id: "unused", text: "unused" }),
          editMemory: () => Promise.resolve(undefined),
          forgetMemory: () => Promise.resolve(false),
          recallMemoryCard: () => Promise.resolve(""),
          searchMemory: () => Promise.resolve(""),
        },
        "discord_presence",
      ),
    );

    const result = (await handler({ systemPrompt: "base" })) as { systemPrompt: string };
    expect(result.systemPrompt).toContain("## Your memory");
    expect(result.systemPrompt).toContain("`memory`");
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
