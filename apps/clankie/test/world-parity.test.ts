import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WORLD_OPERATIONS } from "@pokeagents/world-protocol";
import { describe, expect, it } from "vitest";
import { HOSTED_WORLD_BODY_OPERATIONS, HOSTED_WORLD_MIND_OPERATIONS } from "../src/world/operations.ts";

const src = (...parts: string[]) => join(import.meta.dirname, "../src", ...parts);

describe("hosted world BODY/MIND partition", () => {
  it("covers WORLD_OPERATIONS without overlap", () => {
    const catalog = WORLD_OPERATIONS.map((operation) => operation.name).sort();
    const body = [...HOSTED_WORLD_BODY_OPERATIONS].sort();
    const mind = [...HOSTED_WORLD_MIND_OPERATIONS].sort();
    expect(body).toEqual(
      ["play.act", "play.frame", "play.observe", "play.watch", "world.join", "world.leave"].sort(),
    );
    expect(new Set(body).size).toBe(body.length);
    expect(new Set(mind).size).toBe(mind.length);
    expect(body.filter((name) => mind.includes(name))).toEqual([]);
    expect([...body, ...mind].sort()).toEqual(catalog);
  });

  it("reaches every BODY operation from HostedWorldBody", () => {
    const source = readFileSync(src("world", "body.ts"), "utf8");
    for (const name of HOSTED_WORLD_BODY_OPERATIONS) {
      if (name === "play.frame") {
        expect(source).toMatch(/\b(?:latestFrame|frames)\s*\(/u);
        continue;
      }
      expect(source).toContain(`client.call("${name}"`);
    }
  });

  it("feeds pokeagent_world from the derived mind list", () => {
    const tools = readFileSync(src("captain", "tools.ts"), "utf8");
    const session = readFileSync(src("world", "session.ts"), "utf8");
    expect(tools).toContain("HOSTED_WORLD_MIND_OPERATIONS");
    expect(session).toContain("HOSTED_WORLD_MIND_OPERATIONS");
    expect(session).not.toMatch(/"world\.session",\s*"world\.who"/u);
  });
});
