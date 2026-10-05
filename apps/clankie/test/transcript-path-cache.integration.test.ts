import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

// Count real filesystem operations; the native lookup still reads actual files.
const io = vi.hoisted(() => ({ stats: 0, directories: 0, glob: 0, syncWalks: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: (...args: unknown[]) => {
      io.stats += 1;
      return Reflect.apply(actual.stat, undefined, args);
    },
    readdir: (...args: unknown[]) => {
      io.directories += 1;
      return Reflect.apply(actual.readdir, undefined, args);
    },
    glob: (...args: unknown[]) => {
      io.glob += 1;
      return Reflect.apply(actual.glob, undefined, args);
    },
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    globSync: (...args: unknown[]) => {
      io.syncWalks += 1;
      return Reflect.apply(actual.globSync, undefined, args);
    },
    readdirSync: (...args: unknown[]) => {
      io.syncWalks += 1;
      return Reflect.apply(actual.readdirSync, undefined, args);
    },
  };
});

const { resolveHerdrSeatTranscriptPath, resolveHerdrSeatTranscriptPathAsync } =
  await import("@clankie/agent-transcript");
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  resetIo();
});

function resetIo() {
  io.stats = 0;
  io.directories = 0;
  io.glob = 0;
  io.syncWalks = 0;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clankie-transcript-path-"));
  roots.push(root);
  vi.stubEnv("HOME", root);
  vi.stubEnv("CODEX_HOME", join(root, "codex"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", "");
  vi.stubEnv("CLANKIE_SETTINGS_FILE", join(root, "settings.json"));
  const directory = join(root, "codex", "sessions", "2026", "10", "05");
  await mkdir(directory, { recursive: true });
  return { root, directory };
}

function idFor(index: number) {
  const prefix = Date.UTC(2026, 9, 5).toString(16).padStart(12, "0");
  return `${prefix.slice(0, 8)}-${prefix.slice(8)}-7000-8000-${String(index).padStart(12, "0")}`;
}
const nativeSession = (value: string) => ({ source: "herdr:codex", kind: "id" as const, value });

test("ten concurrent Codex ID lookups share discovery and warm reads never walk the large tree", async () => {
  const f = await fixture();
  await Promise.all(
    Array.from({ length: 30 }, async (_, day) => {
      const directory = join(f.root, "codex", "sessions", "2025", "09", String(day + 1).padStart(2, "0"));
      await mkdir(directory, { recursive: true });
      await Promise.all(
        Array.from({ length: 30 }, (_, file) =>
          writeFile(join(directory, `rollout-old-${file}.jsonl`), "{}\n"),
        ),
      );
    }),
  );
  const ids = Array.from({ length: 10 }, (_, index) => idFor(index));
  const files = ids.map((id) => join(f.directory, `rollout-${id}.jsonl`));
  await Promise.all(files.map((file) => writeFile(file, "{}\n")));
  resetIo();
  const cold = await Promise.all(
    Array.from({ length: 20 }, () =>
      ids.map((id) => resolveHerdrSeatTranscriptPathAsync("codex", nativeSession(id))),
    ).flat(),
  );
  expect(cold).toEqual(Array.from({ length: 20 }, () => files).flat());
  expect(io.directories).toBe(1);
  expect(io.glob).toBe(0);
  expect(io.syncWalks).toBe(0);

  resetIo();
  const warm = await Promise.all(
    Array.from({ length: 20 }, () =>
      ids.map((id) => resolveHerdrSeatTranscriptPathAsync("codex", nativeSession(id))),
    ).flat(),
  );
  expect(warm).toEqual(cold);
  expect(io.stats).toBeLessThanOrEqual(50);
  expect(io.directories + io.glob + io.syncWalks).toBe(0);
});

test("cached misses coalesce, then a newly written rollout invalidates the dated directory", async () => {
  const f = await fixture();
  const session = nativeSession(idFor(11));
  resetIo();
  expect(
    await Promise.all(
      Array.from({ length: 20 }, () => resolveHerdrSeatTranscriptPathAsync("codex", session)),
    ),
  ).toEqual(Array(20).fill(undefined));
  expect(io.glob).toBe(1);
  resetIo();
  expect(await resolveHerdrSeatTranscriptPathAsync("codex", session)).toBeUndefined();
  expect(io.directories + io.glob + io.syncWalks).toBe(0);
  const file = join(f.directory, `rollout-${session.value}.jsonl`);
  await writeFile(file, "{}\n");
  expect(await resolveHerdrSeatTranscriptPathAsync("codex", session)).toBe(file);
});

test("positive lookups detect renames and ambiguity instead of retaining a stale file", async () => {
  const f = await fixture();
  const session = nativeSession(idFor(12));
  const first = join(f.directory, `rollout-first-${session.value}.jsonl`);
  const moved = join(f.directory, `rollout-moved-${session.value}.jsonl`);
  await writeFile(first, "{}\n");
  expect(await resolveHerdrSeatTranscriptPathAsync("codex", session)).toBe(first);
  await rename(first, moved);
  expect(await resolveHerdrSeatTranscriptPathAsync("codex", session)).toBe(moved);
  await writeFile(first, "{}\n");
  expect(await resolveHerdrSeatTranscriptPathAsync("codex", session)).toBeUndefined();
  expect(resolveHerdrSeatTranscriptPath("codex", session)).toBeUndefined();
});

test("account registry replacement removes old cached ownership and discovers the new account", async () => {
  const f = await fixture();
  const id = idFor(13);
  const account = join(f.root, "extra");
  const directory = join(account, "sessions", "2026", "10", "05");
  await mkdir(directory, { recursive: true });
  const file = join(directory, `rollout-${id}.jsonl`);
  await writeFile(file, "{}\n");
  const settings = join(f.root, "settings.json");
  await writeFile(
    settings,
    JSON.stringify({ schemaVersion: 1, codexAccounts: [{ label: "extra", home: account }] }),
  );
  expect(await resolveHerdrSeatTranscriptPathAsync("codex", nativeSession(id))).toBe(file);
  const replacement = join(f.root, "settings-next.json");
  await writeFile(replacement, JSON.stringify({ schemaVersion: 1, codexAccounts: [] }));
  await rename(replacement, settings);
  expect(await resolveHerdrSeatTranscriptPathAsync("codex", nativeSession(id))).toBeUndefined();
  const defaultFile = join(f.directory, `rollout-${id}.jsonl`);
  await writeFile(defaultFile, "{}\n");
  expect(await resolveHerdrSeatTranscriptPathAsync("codex", nativeSession(id))).toBe(defaultFile);
});

test("changing an account's symlink target invalidates positive file and directory identities", async () => {
  const f = await fixture();
  const id = idFor(14);
  const second = join(f.root, "second");
  const secondDirectory = join(second, "sessions", "2026", "10", "05");
  await mkdir(secondDirectory, { recursive: true });
  const file = join(f.directory, `rollout-${id}.jsonl`);
  await writeFile(file, "{}\n");
  const homeLink = join(f.root, "active");
  await symlink(join(f.root, "codex"), homeLink, "dir");
  vi.stubEnv("CODEX_HOME", homeLink);
  const path = join(homeLink, "sessions", "2026", "10", "05", `rollout-${id}.jsonl`);
  expect(await resolveHerdrSeatTranscriptPathAsync("codex", nativeSession(id))).toBe(path);
  await rm(homeLink);
  await symlink(second, homeLink, "dir");
  expect(await resolveHerdrSeatTranscriptPathAsync("codex", nativeSession(id))).toBeUndefined();
  await writeFile(join(secondDirectory, `rollout-${id}.jsonl`), "{}\n");
  expect(await resolveHerdrSeatTranscriptPathAsync("codex", nativeSession(id))).toBe(path);
});

test("a negative lookup expires when only a deep legacy folder changes", async () => {
  const f = await fixture();
  const directory = join(f.root, "codex", "sessions", "legacy", "existing");
  await mkdir(directory, { recursive: true });
  const session = nativeSession("legacy-session");
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
  expect(await resolveHerdrSeatTranscriptPathAsync("codex", session)).toBeUndefined();
  const file = join(directory, `rollout-${session.value}.jsonl`);
  await writeFile(file, "{}\n");
  resetIo();
  expect(await resolveHerdrSeatTranscriptPathAsync("codex", session)).toBeUndefined();
  expect(io.glob).toBe(0);
  clock.mockReturnValue(2_001);
  expect(await resolveHerdrSeatTranscriptPathAsync("codex", session)).toBe(file);
});

test("an explicitly addressed rollout takes one asynchronous stat and rejects non-files or ID patterns", async () => {
  const f = await fixture();
  const file = join(f.directory, "rollout.jsonl");
  await writeFile(file, "{}\n");
  resetIo();
  expect(
    await resolveHerdrSeatTranscriptPathAsync("codex", { source: "herdr:codex", kind: "path", value: file }),
  ).toBe(file);
  expect(io.stats).toBe(1);
  expect(io.directories + io.glob + io.syncWalks).toBe(0);
  expect(
    await resolveHerdrSeatTranscriptPathAsync("codex", {
      source: "herdr:codex",
      kind: "path",
      value: f.directory,
    }),
  ).toBeUndefined();
  expect(await resolveHerdrSeatTranscriptPathAsync("codex", nativeSession("*"))).toBeUndefined();
  expect(await resolveHerdrSeatTranscriptPathAsync("codex", nativeSession("../../other"))).toBeUndefined();
});
