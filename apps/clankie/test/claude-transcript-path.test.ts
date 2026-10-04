import { resolveHerdrSeatTranscriptPath } from "@clankie/agent-transcript";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function session(home: string, configDir: string, id: string): Promise<string> {
  const dir = join(home, configDir, "projects", "-Users-owner-dev");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  await writeFile(file, "{}\n");
  return file;
}

test("finds a Claude session under a named config home, not only ~/.claude", async () => {
  const home = await mkdtemp(join(tmpdir(), "clankie-claude-homes-"));
  roots.push(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("CLAUDE_CONFIG_DIR", "");
  await mkdir(join(home, ".claude", "projects"), { recursive: true });
  const named = await session(home, ".claude-james", "1640b841-f338-48c6-ba05-946fb70241a3");
  expect(resolveHerdrSeatTranscriptPath("claude", { source: "herdr:claude", kind: "id", value: "1640b841-f338-48c6-ba05-946fb70241a3" })).toBe(named);
  expect(resolveHerdrSeatTranscriptPath("claude", { source: "herdr:claude", kind: "id", value: "missing" })).toBeUndefined();
});

test("honors CLAUDE_CONFIG_DIR outside the home directory", async () => {
  const home = await mkdtemp(join(tmpdir(), "clankie-claude-config-"));
  roots.push(home);
  vi.stubEnv("HOME", join(home, "empty-home"));
  const file = await session(home, "custom-config", "2a0e");
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, "custom-config"));
  expect(resolveHerdrSeatTranscriptPath("claude", { source: "herdr:claude", kind: "id", value: "2a0e" })).toBe(file);
});
