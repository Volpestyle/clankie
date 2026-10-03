import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, renameSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { executeRuntimeUpdate, readRuntimeUpdate, type RuntimeUpdatePlan } from "../bin/runtime-update.ts";
import type { InstallCommand } from "../bin/pinned-runtime.ts";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "clankie-update-")));
  roots.push(home);
  const checkout = join(home, "source");
  const common = join(checkout, ".git");
  mkdirSync(common, { recursive: true });
  const directory = join(home, "update");
  mkdirSync(directory, { mode: 0o700 });
  const runtime = join(home, "pinned");
  const oldCommit = "a".repeat(40),
    newCommit = "b".repeat(40);
  const commits = new Map<string, string>();
  const dirty = new Set<string>();
  const make = (path: string, commit: string) => {
    mkdirSync(join(path, "apps/tui/bin"), { recursive: true });
    writeFileSync(join(path, ".git"), "fixture");
    mkdirSync(join(path, "apps/tui/src/command"), { recursive: true });
    writeFileSync(join(path, "apps/tui/src/command/update.ts"), "fixture");
    for (const n of ["clankie", "clankie-herdr"])
      writeFileSync(join(path, `apps/tui/bin/${n}.ts`), "fixture");
    commits.set(path, commit);
  };
  make(runtime, oldCommit);
  let install = () => {};
  const calls: string[] = [];
  const run: InstallCommand = (command, args, cwd) => {
    if (!existsSync(cwd)) throw Error("Git/install cwd disappeared");
    if (command === "pnpm") {
      calls.push("install");
      install();
      return "";
    }
    if (args.includes("--git-common-dir")) return common;
    if (args.includes("--verify")) return args.at(-1) === "HEAD^{commit}" ? commits.get(cwd)! : newCommit;
    if (args[0] === "status") return dirty.has(cwd) ? "?? edit" : "";
    if (args[0] === "branch") return "";
    if (args[0] === "worktree" && args[1] === "add") {
      make(args[3]!, args[4]!);
      calls.push("stage");
      return "";
    }
    if (args[0] === "worktree" && args[1] === "move") {
      const from = args[2]!,
        to = args[3]!;
      calls.push(`move:${from === runtime ? "pin" : from.endsWith("previous") ? "previous" : "stage"}`);
      renameSync(from, to);
      commits.set(to, commits.get(from)!);
      commits.delete(from);
      return "";
    }
    throw Error("Unexpected fake command");
  };
  const plan: RuntimeUpdatePlan = {
    id: "12345678-1234-1234-1234-123456789abc",
    ref: "main",
    checkout,
    runtime,
    home,
    directory,
    oldCommit,
    newCommit,
    oldInstanceId: "11111111-1111-1111-1111-111111111111",
  };
  let behavior = async (_runtime: string, _action: "down" | "restart") => true;
  const services = async (root: string, action: "down" | "restart") => {
    calls.push(`${action}:${commits.get(root) === oldCommit ? "old" : "new"}`);
    const ok = await behavior(root, action);
    return {
      ok,
      services: [{ id: "clankie", ok, state: action === "down" ? "unreachable" : "healthy" }],
      ...(action === "down"
        ? {}
        : {
            runtime: {
              root,
              commit: commits.get(root)!,
              instanceId: "22222222-2222-2222-2222-222222222222",
              pid: 12345,
            },
          }),
    };
  };
  return {
    plan,
    run,
    services,
    calls,
    commits,
    dirty,
    onInstall: (fn: () => void) => {
      install = fn;
    },
    onService: (fn: typeof behavior) => {
      behavior = fn;
    },
  };
}
it("installs completely before old shutdown and persists exact new health", async () => {
  const f = fixture();
  const result = await executeRuntimeUpdate(f.plan, f);
  expect(f.calls).toEqual(["stage", "install", "down:old", "move:pin", "move:stage", "restart:new"]);
  expect(result).toMatchObject({
    phase: "healthy",
    oldCommit: f.plan.oldCommit,
    newCommit: f.plan.newCommit,
    healthy: true,
  });
  expect(readRuntimeUpdate(f.plan.directory)).toEqual(result);
});
it("failed install leaves old pin and all services untouched", async () => {
  const f = fixture();
  f.onInstall(() => {
    throw Error("install fixture failure");
  });
  expect(await executeRuntimeUpdate(f.plan, f)).toMatchObject({
    phase: "failed",
    reason: "pre-cutover-failed",
  });
  expect(f.calls).toEqual(["stage", "install"]);
  expect(f.commits.get(f.plan.runtime)).toBe(f.plan.oldCommit);
});
it("a dirty pin at admission does not even stage", async () => {
  const f = fixture();
  f.dirty.add(f.plan.runtime);
  expect(await executeRuntimeUpdate(f.plan, f)).toMatchObject({
    phase: "failed",
    reason: "pre-cutover-failed",
  });
  expect(f.calls).toEqual([]);
});
it("detects owner edits during installation before stopping service", async () => {
  const f = fixture();
  f.onInstall(() => {
    f.dirty.add(f.plan.runtime);
  });
  expect(await executeRuntimeUpdate(f.plan, f)).toMatchObject({
    phase: "failed",
    reason: "pre-cutover-failed",
  });
  expect(f.calls).toEqual(["stage", "install"]);
});
it("an uncertain old stop does not activate or silently restart", async () => {
  const f = fixture();
  f.onService(async () => false);
  expect(await executeRuntimeUpdate(f.plan, f)).toMatchObject({ phase: "stop-unconfirmed" });
  expect(f.calls).toEqual(["stage", "install", "down:old"]);
  expect(f.commits.get(f.plan.runtime)).toBe(f.plan.oldCommit);
});
it("new health failure restores exact previous pin and records rollback health", async () => {
  const f = fixture();
  f.onService(async (root, action) => !(action === "restart" && f.commits.get(root) === f.plan.newCommit));
  expect(await executeRuntimeUpdate(f.plan, f)).toMatchObject({
    phase: "rolled-back",
    healthy: false,
    rollbackHealthy: true,
  });
  expect(f.calls).toEqual([
    "stage",
    "install",
    "down:old",
    "move:pin",
    "move:stage",
    "restart:new",
    "down:new",
    "move:pin",
    "move:previous",
    "restart:old",
  ]);
  expect(f.commits.get(f.plan.runtime)).toBe(f.plan.oldCommit);
});
it("uncertain new shutdown retains both runtime worktrees without unsafe rollback moves", async () => {
  const f = fixture();
  f.onService(async (root) => f.commits.get(root) === f.plan.oldCommit);
  expect(await executeRuntimeUpdate(f.plan, f)).toMatchObject({
    phase: "stop-unconfirmed",
    reason: "new-services-stop-unconfirmed",
  });
  expect(f.calls.at(-1)).toBe("down:new");
  expect(f.commits.get(f.plan.runtime)).toBe(f.plan.newCommit);
  expect(existsSync(join(f.plan.directory, "previous"))).toBe(true);
});

it("a lost shutdown result remains uncertain and never reports untouched services", async () => {
  const f = fixture();
  f.onService(async () => {
    throw Error("lost response");
  });
  expect(await executeRuntimeUpdate(f.plan, f)).toMatchObject({
    phase: "stop-unconfirmed",
    reason: "old-services-stop-unconfirmed",
  });
  expect(f.calls).toEqual(["stage", "install", "down:old"]);
});
it("owner changes during awaited old shutdown cannot be executed as rollback", async () => {
  const f = fixture();
  f.onService(async () => {
    f.dirty.add(f.plan.runtime);
    return true;
  });
  expect(await executeRuntimeUpdate(f.plan, f)).toMatchObject({
    phase: "failed",
    reason: "rollback-unconfirmed",
  });
  expect(f.calls).toEqual(["stage", "install", "down:old"]);
});

it("rejects a reachable old listener as new runtime health", async () => {
  const f = fixture();
  const services = async (root: string, action: "down" | "restart") => {
    const receipt = await f.services(root, action);
    return action === "restart" && f.commits.get(root) === f.plan.newCommit
      ? {
          ...receipt,
          runtime: { ...receipt.runtime!, commit: f.plan.oldCommit, instanceId: f.plan.oldInstanceId },
        }
      : receipt;
  };
  expect(await executeRuntimeUpdate(f.plan, { ...f, services })).toMatchObject({
    phase: "rolled-back",
    rollbackHealthy: true,
  });
});
it("a failed second worktree move restores the old pin before restart", async () => {
  const f = fixture();
  const run: InstallCommand = (command, args, cwd) => {
    if (args[0] === "worktree" && args[1] === "move" && args[2]?.endsWith("staged"))
      throw Error("move fixture failure");
    return f.run(command, args, cwd);
  };
  expect(await executeRuntimeUpdate(f.plan, { ...f, run })).toMatchObject({
    phase: "rolled-back",
    rollbackHealthy: true,
  });
  expect(f.commits.get(f.plan.runtime)).toBe(f.plan.oldCommit);
  expect(f.calls.at(-1)).toBe("restart:old");
});
it("unsupported target health protocol leaves old service untouched", async () => {
  const f = fixture();
  const run: InstallCommand = (command, args, cwd) => {
    const result = f.run(command, args, cwd);
    if (args[0] === "worktree" && args[1] === "add") rmSync(join(args[3]!, "apps/tui/src/command/update.ts"));
    return result;
  };
  expect(await executeRuntimeUpdate(f.plan, { ...f, run })).toMatchObject({
    phase: "refused",
    reason: "target-update-status-unsupported",
  });
  expect(f.calls).toEqual(["stage"]);
});

it("partial CLI link activation rolls back using the original pin path", async () => {
  const f = fixture();
  f.onInstall(() => rmSync(join(f.plan.directory, "staged/apps/tui/bin/clankie-herdr.ts")));
  expect(await executeRuntimeUpdate(f.plan, f)).toMatchObject({
    phase: "rolled-back",
    rollbackHealthy: true,
  });
  expect(f.calls).not.toContain("restart:new");
  expect(f.commits.get(f.plan.runtime)).toBe(f.plan.oldCommit);
});
