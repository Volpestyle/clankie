import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import { emptySettings } from "@clankie/settings";
import { OpenCodeProfiles } from "../src/opencode-profiles.ts";
import { createAgentSessionRoutes } from "../src/agent-session-routes.ts";
import { createAgentSessions, savedSessionHarness } from "../src/agent-sessions.ts";
import { writeOpenCodeNativeSession } from "./helpers/opencode-native-db.ts";
import { nativeResumeArgs, savedCodexAccount } from "../src/captain/native-session-resume.ts";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opencode-profiles-")));
  roots.push(root);
  const profiles = new OpenCodeProfiles(root);
  const profile = await profiles.allocate();
  return { root, profiles, profile, id: "ses_profileNative123" };
}

test("only original prepared profile and fresh binding plus exact native DB row register history", async () => {
  const f = await fixture();
  const verify = vi.fn(async () => {});
  await expect(f.profiles.register({ ...f.profile }, f.id, f.root, verify)).rejects.toThrow("Original");
  expect(verify).not.toHaveBeenCalled();
  await expect(f.profiles.register(f.profile, f.id, f.root, verify)).rejects.toThrow();
  expect(await readdir(f.profile.directory)).toEqual([]);
  await writeOpenCodeNativeSession(f.profile.database, f.root, f.id);
  await f.profiles.register(f.profile, f.id, f.root, verify);
  expect(verify.mock.calls.length).toBeGreaterThanOrEqual(4);
  expect(await f.profiles.resolve(f.id)).toMatchObject({
    sessionId: f.id,
    workingDirectory: f.root,
    kind: "opencode-sqlite",
  });
  await expect(f.profiles.register(f.profile, f.id, f.root, verify)).rejects.toThrow("Original");
  expect((await new OpenCodeProfiles(f.root).list()).map((v) => v.source.sessionId)).toEqual([f.id]);
});

test.each(["proof-loss", "row-retarget", "wrong-session"])(
  "%s prevents descriptor publication and preserves native DB",
  async (mode) => {
    const f = await fixture();
    await writeOpenCodeNativeSession(f.profile.database, f.root, f.id);
    let calls = 0;
    const verify = async () => {
      if (++calls === 2) {
        if (mode === "proof-loss") throw new Error("root changed");
        if (mode === "row-retarget") {
          const db = new DatabaseSync(f.profile.database);
          db.prepare("UPDATE session SET directory=?").run("/replacement");
          db.close();
        }
      }
    };
    await expect(
      f.profiles.register(f.profile, mode === "wrong-session" ? "ses_wrongNative123" : f.id, f.root, verify),
    ).rejects.toThrow();
    expect(await readdir(f.profile.directory)).toEqual(["opencode.db"]);
  },
);

test("API session service returns native source without fake file/size; stored metadata cannot launch", async () => {
  const f = await fixture();
  await writeOpenCodeNativeSession(f.profile.database, f.root, f.id);
  await f.profiles.register(f.profile, f.id, f.root, async () => {});
  const host = {
    id: "local",
    list: async () => [],
    readBytes: async () => {
      throw new Error("native DB cannot use JSONL bytes");
    },
  };
  const sessions = createAgentSessions({ load: async () => emptySettings() }, () => host, f.profiles);
  const listed = await sessions.list({ host: "local" });
  expect(listed.errors).toEqual([]);
  expect(listed.sessions[0]).toMatchObject({
    harness: "opencode",
    source: { kind: "opencode-sqlite", scope: "stored-v1-export" },
  });
  expect(listed.sessions[0]).not.toHaveProperty("size");
  const hire = vi.fn(async () => ({
    outcome: "failed" as const,
    reason: "harness_unavailable" as const,
    detail: "Original native exit unproven",
  }));
  const routes = createAgentSessionRoutes(sessions, async () => true, hire);
  const response = await routes.request("/v1/agent-sessions/resume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref: `local:${f.id}`, conversationId: "original-hire" }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ outcome: "failed", detail: "Original native exit unproven" });
  expect(hire).toHaveBeenCalledWith(
    expect.objectContaining({ harness: "opencode", resume: `local:${f.id}`, workingDirectory: f.root }),
    undefined,
    "original-hire",
  );
  const saved = await sessions.resolve(`local:${f.id}`);
  expect(saved).not.toHaveProperty("file");
  expect(savedSessionHarness(saved)).toBe("opencode");
  expect(() => nativeResumeArgs(saved)).toThrow("exit proof");
  await expect(savedCodexAccount(saved, [])).rejects.toThrow("not a Codex");
  expect((await sessions.read(`local:${f.id}`)).session).toMatchObject({
    source: { kind: "opencode-sqlite" },
  });
  const metadata = JSON.parse(await readFile(join(f.profile.directory, "source.json"), "utf8"));
  metadata.machineId = "pc";
  await writeFile(join(f.profile.directory, "source.json"), JSON.stringify(metadata));
  expect((await sessions.list({ host: "local" })).errors).toEqual([
    { host: "local/opencode", error: expect.any(String) },
  ]);
  await expect(sessions.read(`local:${f.id}`)).rejects.toThrow();
});
