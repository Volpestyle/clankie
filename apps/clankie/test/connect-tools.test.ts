import { describe, expect, it } from "vitest";
import { connectionTools } from "../src/captain/connect-tools.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { EmailPort } from "../src/email.ts";
import type { LinearPort } from "../src/linear.ts";

const unused = (): never => {
  throw new Error("unused");
};

function deps(overrides: { linear?: Partial<LinearPort>; email?: Partial<EmailPort> }): CaptainDeps {
  return {
    linear: {
      search: async () => ({ outcome: "ok", issues: [] }),
      get: async () => ({
        outcome: "ok",
        issue: { id: "1", identifier: "ENG-1", title: "x", url: "https://linear.app/x" },
      }),
      create: async () => ({
        outcome: "ok",
        issue: { id: "1", identifier: "ENG-1", title: "x", url: "https://linear.app/x" },
      }),
      update: async () => ({
        outcome: "ok",
        issue: { id: "1", identifier: "ENG-1", title: "x", url: "https://linear.app/x" },
      }),
      comment: async () => ({ outcome: "ok", commentId: "c1" }),
      teams: async () => ({ outcome: "ok", teams: [] }),
      viewer: async () => ({ outcome: "ok", viewer: { name: "Ada" } }),
      ...overrides.linear,
    },
    email: {
      list: async () => ({ outcome: "ok", messages: [] }),
      read: unused,
      search: async () => ({ outcome: "ok", messages: [] }),
      send: async () => ({ outcome: "ok", messageId: "m1" }),
      ...overrides.email,
    },
    browser: { catalog: unused, call: unused },
    media: { generateImage: unused, generateVideo: unused, finishedRenders: unused },
    embodiment: { submitIntent: unused, getSession: unused, getLiveSession: unused, getPossession: unused },
    activity: { current: unused },
    presence: { listSessions: unused, listVoiceHistory: unused },
    memory: { appendEpisode: unused, recallEpisodes: unused },
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
  it("lets Discord search Linear and refuses to open the inbox there", async () => {
    const search = await exec("linear_search", "discord_presence", { query: "auth" });
    expect(JSON.parse((search.content[0] as { text: string }).text)).toEqual({ outcome: "ok", issues: [] });

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
