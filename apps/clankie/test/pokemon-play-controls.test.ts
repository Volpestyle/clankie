import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { InterjectionQueue } from "@clankie/play";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { HostedWorldSession } from "../src/world/session.ts";
import { fakeWorldBody } from "./world-body-fake.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("round-trips validated Pokémon budgets through authenticated API and the durable settings store", async () => {
  const root = await mkdtemp(join(tmpdir(), "pokemon-config-"));
  roots.push(root);
  const settings = new SettingsStore(join(root, "settings.json"));
  const { app } = await createClankieApp({
    captain: createStubCaptain(),
    settings,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer fixture" ? { operatorId: "owner" } : undefined,
  });
  const put = (body: unknown, token = "fixture") =>
    app.request("/v1/games/configuration", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await put({ pokeagentMmoEnabled: true }, "wrong")).status).toBe(401);
  expect((await put({ pokeagentMmoEnabled: true, pokemonBudget: { maxTokens: -1 } })).status).toBe(400);
  const games = { pokeagentMmoEnabled: true, pokemonBudget: { maxTokens: 5000, maxCostUsd: 0.25 } };
  expect((await put(games)).status).toBe(200);
  const response = await app.request("/v1/games/configuration", {
    headers: { authorization: "Bearer fixture" },
  });
  expect(await response.json()).toMatchObject({ games });
  expect((await settings.load()).gameplay).toEqual(games);
});

it("guides only the attached play mind after its owner guard, rechecking attachment across await", async () => {
  const live = new HostedWorldSession();
  const queue = new InterjectionQueue(32);
  const body = fakeWorldBody();
  live.attach(body, queue);
  await expect(
    live.guide("go east", async () => {
      throw Error("other conversation");
    }),
  ).rejects.toThrow("other conversation");
  expect(queue.take()).toBeNull();
  expect(await live.guide("try a different objective", async () => {})).toMatchObject({ outcome: "ok" });
  expect(queue.take()).toContain("try a different objective");
  expect(
    await live.guide("old direction", async () => {
      live.detach(body);
      live.attach(fakeWorldBody(), new InterjectionQueue(32));
    }),
  ).toMatchObject({ outcome: "refused", reason: "not_playing" });
  expect(queue.take()).toBeNull();
});
