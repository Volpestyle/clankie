import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { inspectMainPushGuard, installMainPushGuard, MAIN_PUSH_GUARD } from "../src/main-push-guard.ts";

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), "clankie-main-guard-"));
  roots.push(root);
  const source = join(root, name),
    origin = join(root, `${name}.git`);
  await mkdir(source);
  const git = async (...args: string[]) => (await execute("git", ["-C", source, ...args])).stdout.trim();
  await git("init", "--bare", origin);
  await git("init", "-b", "main");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await git("config", "commit.gpgsign", "false");
  await git("remote", "add", "origin", origin);
  await writeFile(join(source, "feature"), "initial");
  await git("add", ".");
  await git("commit", "-m", "initial");
  await git("push", "origin", "HEAD:main");
  const base = await git("rev-parse", "HEAD");
  await git("commit", "--allow-empty", "-m", "candidate");
  return { root, source, origin, git, base };
}

it.each(["clankie", "clankie-app"])(
  "doctor offers and installs the tracked %s guard; real Git blocks main and permits branches / explicit owner bypass",
  async (name) => {
    const f = await fixture(name);
    const offer = await inspectMainPushGuard(f.source);
    expect(offer.status).toBe("offered");
    expect(offer.installCommand).toContain("clankie doctor --install-main-guard");
    await expect(readFile(offer.hook!, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const { stdout } = await execute(
      process.execPath,
      [join(import.meta.dirname, "../bin/clankie.ts"), "doctor", "--install-main-guard", f.source, "--json"],
      { cwd: f.source, env: process.env },
    );
    expect(JSON.parse(stdout).status).toBe("installed");
    expect(await readFile(offer.hook!, "utf8")).toBe(MAIN_PUSH_GUARD);
    for (const ref of ["main", "HEAD:main", "HEAD:refs/heads/main", ":refs/heads/main"])
      await expect(f.git("push", "origin", ref)).rejects.toThrow(
        /Direct push to main refused[\s\S]*clankie integrate <sha> --push --no-wait[\s\S]*clankie integrate status/u,
      );
    expect(await f.git("ls-remote", "origin", "refs/heads/main")).toContain(f.base);
    await f.git("push", "origin", "HEAD:refs/heads/candidate");
    const linked = join(f.root, "linked");
    await f.git("worktree", "add", "--detach", linked, "HEAD");
    expect((await inspectMainPushGuard(linked)).status).toBe("installed");
    await expect(execute("git", ["-C", linked, "push", "origin", "HEAD:main"])).rejects.toThrow(
      "Direct push to main refused",
    );
    await expect(
      execute("git", ["-C", f.source, "push", "origin", "HEAD:main"], {
        env: { ...process.env, CLANKIE_MAIN_PUSH_BYPASS: "owner", CLANKIE_MAIN_PUSH_REASON: "" },
      }),
    ).rejects.toThrow("Direct push to main refused");
    await execute("git", ["-C", f.source, "push", "origin", "HEAD:main"], {
      env: {
        ...process.env,
        CLANKIE_MAIN_PUSH_BYPASS: "owner",
        CLANKIE_MAIN_PUSH_REASON: "James approved fixture recovery",
      },
    });
    const audit = await readFile(join(f.source, ".git", "clankie-main-push-bypass.log"), "utf8");
    expect(audit).toContain("James approved fixture recovery");
    expect(await f.git("ls-remote", "origin", "refs/heads/main")).toContain(await f.git("rev-parse", "HEAD"));
  },
);

it("preserves existing hooks and detects disabled or non-executable guards", async () => {
  const f = await fixture("clankie");
  const offer = await inspectMainPushGuard(f.source);
  await mkdir(dirname(offer.hook!), { recursive: true });
  await writeFile(offer.hook!, "#!/bin/sh\nexit 0\n");
  expect((await inspectMainPushGuard(f.source)).status).toBe("conflict");
  await expect(installMainPushGuard(f.source)).rejects.toThrow("nothing was replaced");
  expect(await readFile(offer.hook!, "utf8")).toBe("#!/bin/sh\nexit 0\n");
  await rm(offer.hook!);
  await installMainPushGuard(f.source);
  await chmod(offer.hook!, 0o644);
  expect((await inspectMainPushGuard(f.source)).status).toBe("offered");
  await installMainPushGuard(f.source);
  expect((await inspectMainPushGuard(f.source)).status).toBe("installed");
  await f.git("config", "core.hooksPath", "/dev/null");
  expect((await inspectMainPushGuard(f.source)).status).toBe("conflict");
  await expect(installMainPushGuard(f.source)).rejects.toThrow("nothing was replaced");
});
