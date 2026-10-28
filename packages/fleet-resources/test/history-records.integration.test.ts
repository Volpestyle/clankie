import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createResourceGovernor } from "../src/governor.ts";
import { defaultResourcePolicy } from "../src/model.ts";
import { recordBulkOperation } from "../src/records.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "clankie-history-records-"));
  roots.push(root);
  return root;
}
const lines = async (path: string) =>
  (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

async function governorIn(registry: string) {
  const governor = createResourceGovernor({
    directory: registry,
    probe: async () => ({ loadRatio: 0.1, availableMemoryMb: 64_000 }),
  });
  await governor.configure({ ...defaultResourcePolicy(), heavySlots: 1 });
  return governor;
}

it("a heavy command keeps its own exit code when its lease history cannot be written (VUH-2933)", async () => {
  const registry = join(await scratch(), "registry");
  // A directory where the history file belongs makes every append fail.
  await mkdir(join(registry, "leases.jsonl"), { recursive: true });
  const governor = await governorIn(registry);
  try {
    expect(
      await governor.runHeavy(process.execPath, ["-e", "process.exit(0)"], { holderId: "history" }),
    ).toBe(0);
    expect(
      await governor.runHeavy(process.execPath, ["-e", "process.exit(7)"], { holderId: "history" }),
    ).toBe(7);
  } finally {
    await governor.close();
  }
});

it("lease history withholds environment assignments and secret flag values", async () => {
  const registry = join(await scratch(), "registry");
  const governor = await governorIn(registry);
  try {
    expect(
      await governor.runHeavy(
        process.execPath,
        [
          "-e",
          "process.exit(0)",
          "API_KEY=secret-one",
          "--token",
          "secret-two",
          "--auth-header=secret-three",
        ],
        { holderId: "history" },
      ),
    ).toBe(0);
  } finally {
    await governor.close();
  }
  const text = await readFile(join(registry, "leases.jsonl"), "utf8");
  expect(text).not.toContain("secret-");
  expect(await lines(join(registry, "leases.jsonl"))).toEqual([
    expect.objectContaining({
      event: "admitted",
      command: "node -e *** API_KEY=*** --token *** --auth-header=***",
    }),
    expect.objectContaining({ event: "released", exitCode: 0 }),
  ]);
});

it.each([
  {
    withheld: "a shell script",
    command: "/bin/sh",
    args: ["-c", "exit 0 # curl -H 'Authorization: Bearer secret-one'"],
    recorded: "sh -c ***",
  },
  {
    withheld: "user credentials",
    command: process.execPath,
    args: ["-e", "process.exit(0)", "--", "-u", "alice:secret-two", "--user=bob:secret-three"],
    recorded: "node -e *** -- -u *** --user=***",
  },
  {
    withheld: "URL userinfo",
    command: process.execPath,
    args: ["-e", "process.exit(0)", "--", "https://carol:secret-four@example.invalid/repo"],
    recorded: "node -e *** -- https://***@example.invalid/repo",
  },
  {
    withheld: "single-dash secret assignments",
    command: process.execPath,
    args: ["-e", "process.exit(0)", "--", "-token=secret-five", "-Dpassword=secret-six"],
    recorded: "node -e *** -- -token=*** -Dpassword=***",
  },
])("lease history withholds $withheld", async ({ command, args, recorded }) => {
  const registry = join(await scratch(), "registry");
  const governor = await governorIn(registry);
  try {
    expect(await governor.runHeavy(command, args, { holderId: "history" })).toBe(0);
  } finally {
    await governor.close();
  }
  expect(await readFile(join(registry, "leases.jsonl"), "utf8")).not.toContain("secret-");
  expect(await lines(join(registry, "leases.jsonl"))).toEqual([
    expect.objectContaining({ event: "admitted", command: recorded }),
    expect.objectContaining({ event: "released", exitCode: 0 }),
  ]);
});

it("lease history keeps ordinary capital flags readable", async () => {
  const registry = join(await scratch(), "registry");
  const governor = await governorIn(registry);
  try {
    expect(
      await governor.runHeavy(
        process.execPath,
        ["-e", "process.exit(0)", "--", "-C", "apps/clankie", "-E", "foo|bar", "-U", "3"],
        { holderId: "history" },
      ),
    ).toBe(0);
  } finally {
    await governor.close();
  }
  expect(await lines(join(registry, "leases.jsonl"))).toEqual([
    expect.objectContaining({ event: "admitted", command: "node -e *** -- -C apps/clankie -E foo|bar -U 3" }),
    expect.objectContaining({ event: "released", exitCode: 0 }),
  ]);
});

it("bulk operation history records a failure, rethrows it, and never fails the work it describes", async () => {
  const root = await scratch();
  await expect(
    recordBulkOperation(
      root,
      "prune_worktree",
      async () => {
        throw new Error("prune failed");
      },
      () => ({}),
    ),
  ).rejects.toThrow("prune failed");
  expect(
    await recordBulkOperation(
      root,
      "reclaim_caches",
      async () => 5,
      (count) => ({ count }),
    ),
  ).toBe(5);
  expect(await lines(join(root, "bulk-ops.jsonl"))).toMatchObject([
    { operation: "prune_worktree", outcome: "failed" },
    { operation: "reclaim_caches", outcome: "ok", count: 5 },
  ]);

  const blocked = join(root, "blocked");
  await mkdir(join(blocked, "bulk-ops.jsonl"), { recursive: true });
  expect(
    await recordBulkOperation(
      blocked,
      "reclaim_caches",
      async () => 6,
      () => ({}),
    ),
  ).toBe(6);
});
