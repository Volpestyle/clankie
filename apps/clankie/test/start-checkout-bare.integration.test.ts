import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { Project } from "@clankie/protocol/projects";
import { SettingsStore, verifyHireCheckout } from "@clankie/settings";
import { ProjectMirrors } from "../src/captain/project-mirrors.ts";
import { pruneTidyWorktree } from "../src/captain/prune-worktree.ts";
import { runExtensionsCommand } from "../../tui/src/command/extensions.ts";

const exec = promisify(execFile);
// The prune reads the account process cwd census through the native helper (VUH-2926).
beforeAll(async () => {
  if (process.platform === "darwin")
    await exec(process.execPath, [join(import.meta.dirname, "../../../scripts/build-fleet-proof.mjs")]);
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of cleanups.splice(0).reverse()) await close();
});

/** Git with no inherited repository variables, as the fixture's own setup. */
const git = async (cwd: string, args: string[]) =>
  (
    await exec(
      "git",
      ["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
      {
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      },
    )
  ).stdout.trim();

/** An owner checkout cloned from a real origin, with a linked worktree like any hire's. */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-start-bare-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const owner = join(root, "owner");
  await git(root, ["init", "-q", "--bare", "--initial-branch=main", origin]);
  await git(root, ["clone", "-q", origin, owner]);
  await writeFile(join(owner, "source.txt"), "landed\n");
  await writeFile(join(owner, ".gitignore"), ".local/\n");
  await git(owner, ["add", "."]);
  await git(owner, ["commit", "-q", "-m", "baseline"]);
  await git(owner, ["push", "-q", "origin", "HEAD:main"]);
  await git(owner, ["fetch", "-q", "origin"]);
  return { root, origin, owner, config: join(owner, ".git", "config") };
}

/** The GIT_DIR a real git hook gets in a linked worktree of the owner's checkout. */
async function hookGitDir(owner: string, root: string): Promise<string> {
  const tree = join(owner, ".local", "wt-hooked");
  await git(owner, ["worktree", "add", "-q", "--detach", tree, "HEAD"]);
  const hooks = join(root, "hooks");
  await mkdir(hooks);
  const seen = join(root, "hook-git-dir");
  await writeFile(join(hooks, "pre-commit"), `#!/bin/sh\nprintf %s "$GIT_DIR" > '${seen}'\n`);
  await chmod(join(hooks, "pre-commit"), 0o755);
  await git(tree, ["-c", `core.hooksPath=${hooks}`, "commit", "-q", "--allow-empty", "-m", "hooked"]);
  const gitDir = await readFile(seen, "utf8");
  expect(gitDir).toBe(join(owner, ".git", "worktrees", "wt-hooked"));
  return gitDir;
}

it("hire, tidy, extension and mirror git run from a hook's environment leave the start checkout's config alone", async () => {
  const f = await fixture();
  const gitDir = await hookGitDir(f.owner, f.root);
  // The extension's pinned source, fetched by commit.
  const upstream = join(f.root, "upstream");
  await mkdir(join(upstream, "ext"), { recursive: true });
  await writeFile(
    join(upstream, "ext", "clankie-extension.json"),
    JSON.stringify({
      id: "fixture-tool",
      version: "1.0.0",
      contracts: [1],
      kind: "extension",
      entry: "index.mjs",
      permissions: ["options"],
    }),
  );
  await writeFile(join(upstream, "ext", "index.mjs"), "export const extension = {};\n");
  await git(f.root, ["init", "-q", upstream]);
  await git(upstream, ["add", "."]);
  await git(upstream, ["commit", "-q", "-m", "extension"]);
  const commit = await git(upstream, ["rev-parse", "HEAD"]);
  // An untracked draft keeps the owner's checkout in place, so the hire gets a worktree.
  await writeFile(join(f.owner, "draft.txt"), "owner's own work\n");
  const before = await readFile(f.config, "utf8");
  expect(before).toContain("bare = false");

  vi.stubEnv("GIT_DIR", gitDir);
  const hire = await verifyHireCheckout(f.owner, async () => {}, { name: "hooked hire" });
  expect(hire, JSON.stringify(hire)).toMatchObject({ outcome: "worktree" });
  const tree = (hire as { path: string }).path;
  const pruned = await pruneTidyWorktree(
    f.owner,
    tree,
    join(f.root, "evidence"),
    { list: async () => [] },
    async () => {},
  );
  expect(pruned, JSON.stringify(pruned)).toMatchObject({ outcome: "removed" });
  await expect(stat(tree)).rejects.toThrow();
  const state = join(f.root, "state");
  const added = await runExtensionsCommand(
    ["add", `file://${upstream}`, "--commit", commit, "--path", "ext", "--grant", "options"],
    { env: { CLANKIE_STATE: state }, settings: new SettingsStore(join(f.root, "settings.json")) },
  );
  expect(added).toMatchObject({ extension: { id: "fixture-tool" } });
  // A remote project's mirror: the fetch fails fast, after init, remote add and config ran.
  await new ProjectMirrors(join(f.root, "mirrors"), async () => "git://127.0.0.1:9/fixture.git").refresh([
    {
      id: "remote-garden",
      name: "Remote garden",
      auto: true,
      workspaces: [{ id: "pc", machineId: "pc", platform: "posix", path: "/srv/garden" }],
    } as unknown as Project,
  ]);
  vi.unstubAllEnvs();

  expect(await readFile(f.config, "utf8")).toBe(before);
  expect(await git(f.owner, ["rev-parse", "--is-bare-repository"])).toBe("false");
});

it("a start checkout marked bare refuses the hire with the cause and the repair", async () => {
  const f = await fixture();
  const tree = join(f.owner, ".local", "wt-linked");
  await git(f.owner, ["worktree", "add", "-q", "--detach", tree, "HEAD"]);
  // What the leaked-GIT_DIR init leaves behind.
  await git(f.owner, ["config", "core.bare", "true"]);
  const refused = await verifyHireCheckout(f.owner, async () => {}, { name: "refused hire" });
  expect(refused, JSON.stringify(refused)).toMatchObject({
    outcome: "refused",
    reason: expect.stringContaining("marked bare (core.bare=true) although it has a working tree"),
  });
  expect((refused as { reason: string }).reason).toContain(
    `git -C ${JSON.stringify(f.owner)} config core.bare false`,
  );
  // A linked worktree keeps its own work tree, so a hire started there still runs.
  expect(await verifyHireCheckout(tree, async () => {}, { name: "linked hire" })).toMatchObject({
    outcome: "fresh",
  });
  // A real bare repository is named as one, not as a damaged checkout.
  expect(await verifyHireCheckout(f.origin)).toMatchObject({
    outcome: "refused",
    reason: "Start directory is a bare repository; start the hire in a checkout",
  });
  // The repair the refusal names restores hiring.
  await git(f.owner, ["config", "core.bare", "false"]);
  expect(await verifyHireCheckout(f.owner, async () => {}, { name: "repaired hire" })).not.toMatchObject({
    outcome: "refused",
  });
});

it.skipIf(process.platform !== "darwin")(
  "the fleet load driver and the land helper's tests, run from `git bisect run`, leave the start checkout non-bare",
  async () => {
    const f = await fixture();
    const tree = join(f.owner, ".local", "wt-bisect");
    await git(f.owner, ["worktree", "add", "-q", "--detach", tree, "HEAD"]);
    for (const step of ["first", "second"]) await git(tree, ["commit", "-q", "--allow-empty", "-m", step]);
    // What `git bisect run` hands its step in a linked worktree (#846).
    const seen = join(f.root, "step-git-dir");
    await git(tree, ["bisect", "start", "HEAD", "HEAD~2"]);
    await git(tree, ["bisect", "run", "sh", "-c", `printf %s "$GIT_DIR" > '${seen}'`]);
    await git(tree, ["bisect", "reset"]);
    const gitDir = await readFile(seen, "utf8");
    expect(gitDir).toBe(join(f.owner, ".git", "worktrees", "wt-bisect"));
    const before = await readFile(f.config, "utf8");
    const env = { ...process.env, GIT_DIR: gitDir };
    const repo = join(import.meta.dirname, "../../..");

    // The load driver inits its own workspace, then stops at a Herdr that will not start.
    const herdr = join(f.root, "herdr");
    await writeFile(herdr, "#!/bin/sh\nexit 1\n");
    await chmod(herdr, 0o755);
    const load = await exec(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        join(repo, "apps/clankie/scripts/fleet-load.ts"),
        "--herdr-binary",
        herdr,
        "--workers",
        "1",
        "--large-session-mb",
        "1",
        "--output",
        join(f.root, "load.json"),
      ],
      { cwd: tree, env, timeout: 120_000 },
    ).catch((error: { stdout?: string; stderr?: string }) => error);
    expect(JSON.stringify(load)).toContain("Owned Herdr startup failed");
    expect(await readFile(f.config, "utf8")).toBe(before);

    await exec(
      process.execPath,
      ["--test", join(repo, ".agents/skills/shared-checkout/scripts/land.test.mjs")],
      {
        cwd: tree,
        env,
        timeout: 120_000,
      },
    );
    expect(await readFile(f.config, "utf8")).toBe(before);
    expect(await git(f.owner, ["rev-parse", "--is-bare-repository"])).toBe("false");
  },
);
