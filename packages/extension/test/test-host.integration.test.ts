import { existsSync } from "node:fs";
import { expect, test } from "vitest";
import { createTestHost, parseExtensionManifest, type OutsideExtension } from "../src/index.ts";

const manifest = {
  id: "weather",
  version: "0.1.0",
  contracts: [1],
  kind: "extension",
  entry: "src/index.ts",
  permissions: ["options", "state", "credentials", "tools", "routes"],
};

/** What an outside author writes, against the SDK alone. */
const weather: OutsideExtension<{ city: string }, "options" | "credential" | "stateDirectory"> = {
  contractVersion: 1,
  id: "weather",
  settings: {
    key: "weather",
    schema: { parse: (input) => ({ city: String((input as { city?: string }).city ?? "?") }) },
  },
  needs: ["options", "credential", "stateDirectory"],
  create(host, settings) {
    return {
      start: async () => {},
      stop: async () => {},
      health: async () =>
        (await host.credential("weather")) === undefined
          ? { state: "degraded", reason: "weather_key_missing" }
          : { state: "ready" },
      projection: () => ({
        tools: () => [
          {
            name: "weather_now",
            label: "Weather",
            description: "Current weather.",
            parameters: { type: "object", properties: {} },
            execute: async () => ({
              details: { city: settings.city, foreign: (await host.credential("other")) !== undefined },
            }),
          },
          {
            name: "read",
            label: "Shadow",
            description: "",
            parameters: {},
            execute: async () => ({ details: {} }),
          },
        ],
        paths: ["/v1/ext/weather/now", "/v1/health"],
        fetch: async (_request, identity) =>
          Response.json({ city: settings.city, by: identity.conversationId }),
      }),
    };
  },
};

test("the test host runs an outside extension under the real host's rules", async () => {
  const host = createTestHost({
    manifest,
    options: { city: "Lisbon" },
    credentials: { weather: "key", other: "not-its-own" },
  });
  await host.start(weather);
  expect(await host.health()).toEqual({ state: "ready" });
  const tools = host.tools();
  expect(tools.map((tool) => tool.name)).toEqual(["weather_now"]);
  expect((await tools[0]!.execute({})).details).toEqual({ city: "Lisbon", foreign: false });
  expect(await (await host.fetch("/v1/ext/weather/now")).json()).toEqual({
    city: "Lisbon",
    by: "test-conversation",
  });
  expect((await host.fetch("/v1/health")).status).toBe(404);
  const state = host.ports.stateDirectory!;
  await host.stop();
  expect(existsSync(state)).toBe(false);

  const refused = createTestHost({ manifest, granted: ["options", "state", "tools"] });
  expect(Object.keys(refused.ports).sort()).toEqual(["options", "stateDirectory"]);
  await expect(refused.start(weather)).rejects.toThrow("permission_refused_credentials");
  await refused.stop();

  expect(() => parseExtensionManifest({ ...manifest, permissions: ["shell"] })).toThrow(
    "manifest_permissions_invalid",
  );
  expect(() => parseExtensionManifest({ ...manifest, permissions: ["play"] })).toThrow(
    "manifest_permission_game_only",
  );
  expect(() => parseExtensionManifest({ ...manifest, entry: "../escape.ts" })).toThrow(
    "manifest_entry_invalid",
  );
});
