import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createLocalAgentHost, piSessionRoots } from "../src/index.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
test("native Pi session-dir overrides native agent-dir; home-only fixtures preserve defaults", () => {
  expect(piSessionRoots({}, "/fixture")).toEqual(["/fixture/.pi/agent/sessions"]);
  expect(piSessionRoots({ PI_CODING_AGENT_DIR: "/profile" }, "/fixture")).toEqual(["/profile/sessions"]);
  expect(
    piSessionRoots({ PI_CODING_AGENT_DIR: "/profile", PI_CODING_AGENT_SESSION_DIR: "/sessions" }, "/fixture"),
  ).toEqual(["/sessions"]);
  expect(() => piSessionRoots({ PI_CODING_AGENT_SESSION_DIR: "relative" })).toThrow("absolute");
});
test("existing transcript source reads only the selected Pi profile and denies escaped symlinks", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-roots-"));
  dirs.push(home);
  const profile = join(home, "selected");
  await mkdir(profile);
  const file = join(profile, "native.jsonl");
  await writeFile(file, '{"type":"session"}\n');
  const outside = join(home, "outside.jsonl");
  await writeFile(outside, "outside");
  const escaped = join(profile, "escaped.jsonl");
  await symlink(outside, escaped);
  const host = createLocalAgentHost({ home, piSessionRoots: [profile] });
  expect(await host.list()).toEqual([expect.objectContaining({ harness: "pi", path: file })]);
  expect((await host.readBytes(file, 0, 100)).bytes.toString()).toContain('"session"');
  await expect(host.readBytes(escaped, 0, 100)).rejects.toThrow("outside");
});
