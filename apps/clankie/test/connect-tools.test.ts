import { describe, expect, it } from "vitest";
import { connectionTools } from "../src/captain/connect-tools.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { EmailPort } from "../src/email.ts";

const unused = (): never => {
  throw new Error("unused");
};

function deps(overrides: { email?: Partial<EmailPort> }): CaptainDeps {
  return {
    mcp: { catalog: async () => [], call: unused },
    email: {
      list: async () => ({ outcome: "ok", messages: [] }),
      read: unused,
      search: async () => ({ outcome: "ok", messages: [] }),
      send: async () => ({ outcome: "ok", messageId: "m1" }),
      ...overrides.email,
    },
    browser: { catalog: unused, call: unused },
    media: { generateImage: unused, generateVideo: unused, finishedRenders: unused },
    embodiment: { submitIntent: unused, getSession: unused, getLiveSession: unused },
    activity: { current: unused },
    streamWatch: { current: unused },
    presence: { listSessions: unused, listVoiceHistory: unused, listRecentVoiceSpeech: unused },
    memory: { appendEpisode: unused, recallEpisodeCard: unused },
  };
}

async function exec(
  name: string,
  lane: "operator" | "discord_presence",
  params: Record<string, unknown> = {},
) {
  const tool = connectionTools(deps({}), lane).find((entry) => entry.name === name);
  if (tool === undefined) throw new Error(`missing ${name}`);
  return tool.execute("call-1", params as never, undefined, undefined, {} as never);
}

describe("connection tools", () => {
  it("refuses to open the inbox from Discord", async () => {
    const inbox = await exec("email_list", "discord_presence", {});
    expect(JSON.parse((inbox.content[0] as { text: string }).text)).toMatchObject({
      refused: "operator_only",
    });
  });

  it("lets the operator list mail", async () => {
    const inbox = await exec("email_list", "operator", {});
    expect(JSON.parse((inbox.content[0] as { text: string }).text)).toEqual({ outcome: "ok", messages: [] });
  });
});
