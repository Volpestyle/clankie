import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  readlinkSync,
  realpathSync,
  linkSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  assertPinnedRuntime,
  createPinnedWorktree,
  installPinnedDependencies,
  installPinnedLinks,
  pinnedCommit,
  relocatePinnedDependencies,
  type InstallCommand,
} from "../bin/pinned-runtime.ts";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clankie-pin-")));
  roots.push(root);
  const checkout = join(root, "source");
  const runtime = join(root, "pinned");
  const common = join(checkout, ".git");
  mkdirSync(common, { recursive: true });
  mkdirSync(runtime);
  writeFileSync(join(runtime, ".git"), "fixture");
  const calls: { command: string; args: readonly string[]; cwd: string }[] = [];
  let dirty = "";
  const run: InstallCommand = (command, args, cwd) => {
    calls.push({ command, args, cwd });
    if (command === "pnpm") throw Error("fixture install failed");
    if (args.includes("--git-common-dir")) return common;
    if (args[0] === "status") return dirty;
    if (args[0] === "branch") return "";
    if (args.includes("--verify")) return "a".repeat(40);
    if (args[0] === "worktree") return "";
    throw Error("unexpected fixture command");
  };
  return {
    root,
    checkout,
    runtime,
    calls,
    run,
    dirty: (text: string) => {
      dirty = text;
    },
  };
}
it("rejects dirty tracked and untracked pins before install or worktree mutation", () => {
  for (const dirty of [" M file", "?? local-file"]) {
    const f = fixture();
    f.dirty(dirty);
    expect(() => assertPinnedRuntime(f.checkout, f.runtime, f.run)).toThrow("local changes");
    expect(
      f.calls.every((call) => call.command === "git" && ["rev-parse", "status"].includes(call.args[0]!)),
    ).toBe(true);
  }
});
it("resolves refs as argv with option termination and rejects option injection", () => {
  const f = fixture();
  expect(pinnedCommit(f.checkout, "main", f.run)).toBe("a".repeat(40));
  expect(f.calls[0]?.args).toEqual(["rev-parse", "--verify", "--end-of-options", "main^{commit}"]);
  expect(() => pinnedCommit(f.checkout, "--upload-pack=evil", f.run)).toThrow("Invalid runtime ref");
});
it("refuses symlinked runtime roots and never overwrites an existing stage", () => {
  const f = fixture();
  const link = join(f.root, "linked");
  symlinkSync(f.runtime, link);
  expect(() => assertPinnedRuntime(f.checkout, link, f.run)).toThrow("symlink");
  expect(() => createPinnedWorktree(f.checkout, f.runtime, "a".repeat(40), f.run)).toThrow("already exists");
  expect(f.calls).toEqual([]);
});
it("dependency failure is confined to the supplied stage, with no pin checkout", () => {
  const f = fixture();
  const stage = join(f.root, "stage");
  createPinnedWorktree(f.checkout, stage, "b".repeat(40), f.run);
  expect(() => installPinnedDependencies(stage, f.run)).toThrow("fixture install failed");
  expect(f.calls).toEqual([
    { command: "git", args: ["worktree", "add", "--detach", stage, "b".repeat(40)], cwd: f.checkout },
    { command: "pnpm", args: ["install", "--frozen-lockfile", "--prefer-offline"], cwd: stage },
  ]);
});
it("preflights both CLI destinations and installs fixture-owned links", async () => {
  const f = fixture();
  mkdirSync(join(f.runtime, "apps/tui/bin"), { recursive: true });
  for (const name of ["clankie", "clankie-herdr"])
    writeFileSync(join(f.runtime, `apps/tui/bin/${name}.ts`), "fixture");
  await installPinnedLinks(f.runtime, f.root);
  expect(readlinkSync(join(f.root, ".local/bin/clankie"))).toBe(join(f.runtime, "apps/tui/bin/clankie.ts"));
  rmSync(join(f.root, ".local/bin/clankie-herdr"));
  writeFileSync(join(f.root, ".local/bin/clankie-herdr"), "owner file");
  await expect(installPinnedLinks("/never-installed", f.root)).rejects.toThrow("not a symlink");
  expect(readlinkSync(join(f.root, ".local/bin/clankie"))).toBe(join(f.runtime, "apps/tui/bin/clankie.ts"));
});

it("relocates actual pnpm cmd-shim shape through fresh inode without mutating store hardlinks", () => {
  const f = fixture();
  const stage = join(f.root, "stage"),
    destination = join(f.root, "final");
  mkdirSync(join(stage, "node_modules/.bin"), { recursive: true });
  const target = join(stage, "node_modules/tool/index.js");
  mkdirSync(join(stage, "node_modules/tool"));
  writeFileSync(target, "fixture");
  const text = `#!/bin/sh\nexport NODE_PATH="${stage}/node_modules/.pnpm/node_modules"\nexec node "$basedir/../tool/index.js" "$@"\n# cmd-shim-target=${target}\n`;
  const outside = join(f.root, "store-wrapper"),
    wrapper = join(stage, "node_modules/.bin/tool");
  writeFileSync(outside, text, { mode: 0o755 });
  linkSync(outside, wrapper);
  writeFileSync(
    join(stage, "node_modules/.pnpm-workspace-state-v1.json"),
    JSON.stringify({ projects: { [stage]: { name: "fixture" } } }),
  );
  mkdirSync(join(f.root, ".data"));
  symlinkSync(join(f.root, ".data"), join(stage, ".data"));
  relocatePinnedDependencies(stage, destination, undefined, f.root);
  expect(readFileSync(wrapper, "utf8")).toBe(text.replaceAll(stage, destination));
  expect(readFileSync(outside, "utf8")).toBe(text);
  expect(statSync(wrapper).nlink).toBe(1);
  expect(statSync(wrapper).mode & 0o777).toBe(0o755);
  expect(readFileSync(join(stage, "node_modules/.pnpm-workspace-state-v1.json"), "utf8")).not.toContain(
    stage,
  );
});
it("dependency escapes and partial relocation failure refuse without touching other roots", () => {
  const f = fixture();
  const stage = join(f.root, "stage");
  mkdirSync(join(stage, "node_modules/.bin"), { recursive: true });
  symlinkSync(f.runtime, join(stage, "node_modules/escape"));
  expect(() => relocatePinnedDependencies(stage, join(f.root, "final"))).toThrow("escapes");
  rmSync(join(stage, "node_modules/escape"));
  const target = join(stage, "node_modules/tool.js");
  writeFileSync(target, "fixture");
  writeFileSync(join(stage, "node_modules/.bin/tool"), `# cmd-shim-target=${target}\n`);
  expect(() =>
    relocatePinnedDependencies(stage, join(f.root, "final"), () => {
      throw Error("fixture disk failure");
    }),
  ).toThrow("disk failure");
  expect(readFileSync(join(f.runtime, ".git"), "utf8")).toBe("fixture");
});
