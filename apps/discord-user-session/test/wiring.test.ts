import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("sole-Vox package wiring", () => {
  it("creates one child, shares it, and contains no discordjs voice adapter", async () => {
    const sourceDirectory = new URL("../src/", import.meta.url);
    const sources = await Promise.all(
      (await readdir(sourceDirectory))
        .filter((name) => name.endsWith(".ts"))
        .map((name) => readFile(new URL(name, sourceDirectory), "utf8")),
    );
    const source = sources.join("\n");
    const index = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(source.match(/createVoxClient\s*\(/gu)).toHaveLength(1);
    expect(index).toMatch(/new DiscordVoiceSession\(\{\s*vox,/u);
    expect(index).toMatch(/startStreamWatch\(\{[\s\S]*?vox,[\s\S]*?membership,/u);
    expect(source).not.toContain("DiscordUserVoiceAdapters");
    expect(source).not.toContain("@discordjs/voice");
    expect(manifest.dependencies).not.toHaveProperty("@discordjs/voice");
    expect(manifest.scripts?.["watch-live-proof"]).toContain("live-proof-cli.ts watch");
    expect(manifest.scripts?.["publish-live-proof"]).toContain("live-proof-cli.ts publish");
  });
});
