import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  chmodSync,
  symlinkSync,
  cpSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createRuntimeUpdater,
  materializeUpdateHelper,
  verifyUpdateHelper,
  type RuntimeUpdaterOptions,
} from "../bin/runtime-updater.ts";
import type { InstallCommand } from "../bin/pinned-runtime.ts";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(extra: Partial<RuntimeUpdaterOptions> = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "clankie-updater-")));
  roots.push(home);
  const checkout = join(home, "source"),
    runtime = join(home, ".clankie/pinned"),
    common = join(checkout, ".git");
  mkdirSync(common, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, ".git"), "fixture");
  let allowed = true,
    guardCalls = 0;
  const launches: { command: string; args: readonly string[]; options: unknown }[] = [];
  const run: InstallCommand = (_command, args) => {
    if (args.includes("--git-common-dir")) return common;
    if (args.includes("--verify")) return args.at(-1) === "HEAD^{commit}" ? "a".repeat(40) : "b".repeat(40);
    if (["status", "branch", "fetch", "check-ref-format", "merge-base"].includes(args[0]!)) return "";
    throw Error("No fixture process permitted");
  };
  const updater = createRuntimeUpdater({
    repoRoot: runtime,
    env: { HOME: home, PATH: "/fixture", NODE_OPTIONS: "--bad-ambient", PI_SESSION_FILE: "/owner" },
    run,
    spawnHelper: (command, args, options) => {
      launches.push({ command, args, options });
      return Object.assign(new EventEmitter(), { pid: 1234, unref() {} }) as ChildProcess;
    },
    ...extra,
  });
  const authority = {
    guard: async () => {
      guardCalls++;
      if (!allowed) throw Error("revoked");
    },
    current: () => allowed,
  };
  return {
    home,
    runtime,
    updater,
    launches,
    authority,
    revoke: () => {
      allowed = false;
    },
    guards: () => guardCalls,
  };
}
it("accepts once after preparation and detaches fixed helper with private file stdio", async () => {
  const f = fixture();
  const result = await f.updater.request("main", f.authority);
  expect(result).toMatchObject({
    accepted: true,
    latest: { phase: "scheduled", oldCommit: "a".repeat(40), newCommit: "b".repeat(40) },
  });
  // Admission, owner-checkout synchronization, and final helper scheduling.
  expect(f.guards()).toBe(3);
  const plan = JSON.parse(
    readFileSync(join(f.home, ".clankie/updates", result.pending!, "plan.json"), "utf8"),
  );
  expect(plan.checkout).toBe(join(f.home, "source"));
  expect(f.launches).toHaveLength(1);
  expect(f.launches[0]?.command).toBe(process.execPath);
  expect(f.launches[0]?.args).toEqual([
    join(f.home, ".clankie/updates", result.pending!, "runtime-update-helper.mjs"),
  ]);
  expect(f.launches[0]?.options).toMatchObject({ detached: true, env: { HOME: f.home, PATH: "/fixture" } });
  const options = f.launches[0]!.options as { env: NodeJS.ProcessEnv; stdio: unknown[] };
  expect(options.env.NODE_OPTIONS).toBeUndefined();
  expect(options.env.PI_SESSION_FILE).toBeUndefined();
  expect(options.stdio[0]).toBe("ignore");
  expect(f.updater.status().latest).toEqual(result.latest);
});
it("revocation during materialization prevents any durable acceptance or spawn", async () => {
  let revoke = () => {};
  const f = fixture({
    materialize: async (directory) => {
      const hashes = await materializeUpdateHelper(directory);
      revoke();
      return hashes;
    },
  });
  revoke = f.revoke;
  await expect(f.updater.request("main", f.authority)).rejects.toThrow("revoked");
  expect(f.launches).toEqual([]);
  expect(f.updater.status().latest).toBeUndefined();
  expect(f.updater.status().pending).toBeUndefined();
});
it("synchronous current check rejects authority lost while final guard awaited", async () => {
  const f = fixture();
  let count = 0;
  await expect(
    f.updater.request("main", {
      current: f.authority.current,
      guard: async () => {
        if (++count === 3) {
          await Promise.resolve();
          f.revoke();
        }
      },
    }),
  ).rejects.toThrow("expired");
  expect(f.launches).toEqual([]);
});
it("concurrent request observes the original preparation and does not duplicate helper", async () => {
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture({
    materialize: async (directory) => {
      const hashes = await materializeUpdateHelper(directory);
      started();
      await wait;
      return hashes;
    },
  });
  const first = f.updater.request("main", f.authority);
  await ready;
  const second = await f.updater.request("main", f.authority);
  expect(second.accepted).toBe(false);
  expect(f.launches).toEqual([]);
  release();
  const accepted = await first;
  expect(accepted.pending).toBe(second.pending);
  expect(f.launches).toHaveLength(1);
});
it("uncertain spawn stays accepted and never retries the mutation", async () => {
  let attempts = 0;
  const f = fixture({
    spawnHelper: () => {
      attempts++;
      throw Error("uncertain spawn");
    },
  });
  const result = await f.updater.request("main", f.authority);
  expect(result).toMatchObject({ accepted: true, needsReconciliation: true });
  const again = await f.updater.request("main", f.authority);
  expect(again.accepted).toBe(false);
  expect(again.pending).toBe(result.pending);
  expect(attempts).toBe(1);
});
it("materialized helper tampering refuses before spawn", async () => {
  const f = fixture({
    materialize: async (directory) => {
      const hashes = await materializeUpdateHelper(directory);
      const path = join(directory, "runtime-update.ts");
      chmodSync(path, 0o600);
      writeFileSync(path, "throw Error('changed')");
      return hashes;
    },
  });
  await expect(f.updater.request("main", f.authority)).rejects.toThrow("helper changed");
  expect(f.launches).toEqual([]);
});
it("bounded result reads reject symlinks and malformed health, never trusting a JSON cast", async () => {
  const f = fixture();
  const result = await f.updater.request("main", f.authority);
  const path = join(f.home, ".clankie/updates", result.pending!, "result.json");
  writeFileSync(path, JSON.stringify({ ...result.latest, healthy: "yes" }), { mode: 0o600 });
  expect(f.updater.status()).toMatchObject({ error: "update_record_unreadable", needsReconciliation: true });
  rmSync(path);
  const elsewhere = join(f.home, "elsewhere");
  writeFileSync(elsewhere, "{}");
  symlinkSync(elsewhere, path);
  expect(f.updater.status()).toMatchObject({ error: "update_record_unreadable", needsReconciliation: true });
});
it("helper copies remain self-contained when their source location disappears", async () => {
  const f = fixture();
  const source = join(f.home, "old-source"),
    directory = join(f.home, "materialized");
  mkdirSync(source);
  mkdirSync(directory, { mode: 0o700 });
  for (const name of [
    "runtime-update-helper.mjs",
    "runtime-update.ts",
    "pinned-runtime.ts",
    "update-files.ts",
  ])
    cpSync(join(import.meta.dirname, "../bin", name), join(source, name));
  const hashes = await materializeUpdateHelper(directory, source);
  rmSync(source, { recursive: true });
  expect(() => verifyUpdateHelper(directory, hashes)).not.toThrow();
});
