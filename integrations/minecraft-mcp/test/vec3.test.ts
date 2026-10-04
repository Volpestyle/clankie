import { createRequire } from "node:module";
import { expect, it } from "vitest";

const Vec3 = createRequire(import.meta.url)("../../../packages/vec3/index.cjs").Vec3;

it("routes the installed Minecraft runtime and every vector dependency to this implementation", () => {
  const require = createRequire(import.meta.url);
  expect(require("vec3").Vec3).toBe(Vec3);
  for (const name of [
    "mineflayer",
    "mineflayer-pathfinder",
    "prismarine-physics",
    "prismarine-world",
    "prismarine-chunk",
    "prismarine-viewer",
    "prismarine-entity",
  ]) {
    const consumer =
      name.startsWith("prismarine-") && !["prismarine-viewer"].includes(name)
        ? createRequire(require.resolve("mineflayer"))
        : require;
    const from = createRequire(consumer.resolve(name));
    expect(from("vec3").Vec3, name).toBe(Vec3);
  }
});
