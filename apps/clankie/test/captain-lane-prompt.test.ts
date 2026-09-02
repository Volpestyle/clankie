import { describe, expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain, type CaptainPromptSection } from "../src/captain/port.ts";

/**
 * The prompt and memory card leave a pi session by HTTP (VUH-1086). What this
 * guards is the lane boundary: a bearer reads its own lane and no other, since
 * the operator card carries operator-private notes.
 */

interface Read {
  readonly lane: string;
  readonly sections?: readonly CaptainPromptSection[];
}

async function laneApp(): Promise<{
  readonly app: Awaited<ReturnType<typeof createClankieApp>>;
  readonly prompts: Read[];
  readonly cards: string[];
}> {
  const prompts: Read[] = [];
  const cards: string[] = [];
  const app = await createClankieApp({
    captain: createStubCaptain({
      lanePrompt: ({ lane, sections }) => {
        prompts.push({ lane, ...(sections === undefined ? {} : { sections }) });
        return Promise.resolve(`prompt for ${lane}\n`);
      },
      laneMemoryCard: (lane) => {
        cards.push(lane);
        return Promise.resolve(`card for ${lane}\n`);
      },
    }),
    authenticateCaptain: (request) =>
      Promise.resolve(
        request.headers.get("authorization") === "Bearer discord-text"
          ? { captainId: "captain-clankie", steerSourceLane: "discord_text" as const }
          : undefined,
      ),
    authenticateOperator: (request) =>
      Promise.resolve(
        request.headers.get("authorization") === "Bearer operator"
          ? { operatorId: "operator-james" }
          : undefined,
      ),
  });
  return { app, prompts, cards };
}

describe("captain lane prompt and memory card", () => {
  it("gives the operator bearer the operator lane as plain text", async () => {
    const { app, prompts, cards } = await laneApp();
    const operator = { authorization: "Bearer operator" };

    const prompt = await app.app.request("/v1/captain/prompt", { headers: operator });
    const card = await app.app.request("/v1/captain/memory-card", { headers: operator });

    expect(prompt.status).toBe(200);
    expect(prompt.headers.get("content-type")).toContain("text/plain");
    await expect(prompt.text()).resolves.toBe("prompt for operator\n");
    expect(card.status).toBe(200);
    expect(card.headers.get("content-type")).toContain("text/plain");
    await expect(card.text()).resolves.toBe("card for operator\n");
    // The lane defaults to the bearer's own, so a seat launcher need not name it.
    expect(prompts).toEqual([{ lane: "operator" }]);
    expect(cards).toEqual(["operator"]);
    app.close();
  });

  it("forwards only the sections that were asked for", async () => {
    const { app, prompts } = await laneApp();

    const response = await app.app.request("/v1/captain/prompt?sections=persona,%20model", {
      headers: { authorization: "Bearer operator" },
    });

    expect(response.status).toBe(200);
    expect(prompts).toEqual([{ lane: "operator", sections: ["persona", "model"] }]);
    app.close();
  });

  it("refuses a section name the captain assembles nothing from", async () => {
    const { app, prompts } = await laneApp();

    const response = await app.app.request("/v1/captain/prompt?sections=identity,secrets", {
      headers: { authorization: "Bearer operator" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(prompts).toEqual([]);
    app.close();
  });

  it("keeps a Discord bearer inside its own lane", async () => {
    const { app, prompts, cards } = await laneApp();
    const bridge = { authorization: "Bearer discord-text" };

    const own = await app.app.request("/v1/captain/prompt", { headers: bridge });
    const ownCard = await app.app.request("/v1/captain/memory-card?lane=discord_presence", {
      headers: bridge,
    });
    const other = await app.app.request("/v1/captain/prompt?lane=operator", { headers: bridge });
    const otherCard = await app.app.request("/v1/captain/memory-card?lane=operator", { headers: bridge });

    expect(own.status).toBe(200);
    await expect(own.text()).resolves.toBe("prompt for discord_presence\n");
    expect(ownCard.status).toBe(200);
    expect(other.status).toBe(403);
    await expect(other.json()).resolves.toEqual({ error: "lane_forbidden" });
    expect(otherCard.status).toBe(403);
    // Nothing about the operator lane was assembled, let alone rendered.
    expect(prompts).toEqual([{ lane: "discord_presence" }]);
    expect(cards).toEqual(["discord_presence"]);
    app.close();
  });

  it("says nothing at all to an unauthenticated reader", async () => {
    const { app, prompts, cards } = await laneApp();

    const prompt = await app.app.request("/v1/captain/prompt");
    const card = await app.app.request("/v1/captain/memory-card");

    expect(prompt.status).toBe(401);
    expect(card.status).toBe(401);
    await expect(prompt.json()).resolves.toEqual({ error: "authentication_required" });
    expect(prompts).toEqual([]);
    expect(cards).toEqual([]);
    app.close();
  });
});
