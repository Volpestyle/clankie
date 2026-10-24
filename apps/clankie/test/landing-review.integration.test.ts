import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { integrationEnvironment } from "../src/integrate-environment.ts";
import { runReviewCommand } from "../../tui/src/command/review.ts";
import { readCandidatePatch } from "../../../integrations/claude-plugin/worker/bin/review-tools.mjs";

const execute = promisify(execFile);
const roots: string[] = [];
const checkout = resolve(import.meta.dirname, "../../..");
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const temp = await readlink(join(root, "tmp")).catch(() => undefined);
    if (temp) await rm(temp, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

async function environment() {
  const root = await mkdtemp(join(tmpdir(), "landing-review-"));
  roots.push(root);
  return { root, env: await integrationEnvironment(root) };
}

async function gate(env: NodeJS.ProcessEnv) {
  const { stdout } = await execute(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { landingReview, landingReviewMessage } from './scripts/testing/landing-review.mjs';
    const review = landingReview(process.cwd(), 'origin/main');
    console.log(JSON.stringify({ ...review, message: landingReviewMessage(review) }));
  `,
    ],
    { cwd: checkout, env, timeout: 60_000 },
  );
  return JSON.parse(stdout);
}

it("holds an integrate gate with CI=1, a configured reviewer and an unreachable service", async () => {
  const { env } = await environment();
  await mkdir(dirname(env.CLANKIE_SETTINGS_FILE!), { recursive: true });
  await writeFile(
    env.CLANKIE_SETTINGS_FILE!,
    JSON.stringify({ projects: { projects: [{ id: "clankie", review: { role: "reviewer" } }] } }),
  );
  // Also exercises the non-integrate CI branch with real settings and a dead HTTP target.
  for (const integrate of ["1", undefined]) {
    const result = await gate({
      ...env,
      CLANKIE_INTEGRATE: integrate,
      CLANKIE_OPERATOR_TOKEN: "fixture-token",
    });
    expect(result.state).toBe("unavailable");
    expect(result.message).toContain("landing held");
  }
});

it("holds a credentialless integrate sandbox even when owner settings are hidden", async () => {
  const { env } = await environment();
  expect((await gate(env)).state).toBe("unavailable");
  // The pre-fix batch environment: hidden owner stores, no integrate marker.
  // Its real CLI failure was missing operator credentials, even before fetching port 1.
  const originalIsolation = await gate({ ...env, CLANKIE_INTEGRATE: undefined });
  expect(originalIsolation.state).toBe("skipped");
  expect(originalIsolation.detail).toContain("Reviews need the operator credential");
});

it("review status uses only the service's verdict for the exact sandbox patch", async () => {
  const { root, env } = await environment();
  const git = async (...args: string[]) => (await execute("git", args, { cwd: root })).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.email", "fixture@example.invalid");
  await git("config", "user.name", "Fixture");
  await writeFile(join(root, "feature"), "before\n");
  await git("add", "feature");
  await git("commit", "-m", "base");
  await git("update-ref", "refs/remotes/origin/main", "HEAD");
  await writeFile(join(root, "feature"), "after\n");
  await git("commit", "-am", "feature");
  const patch = readCandidatePatch(root);
  const landing = {
    schemaVersion: 1,
    required: true,
    projectId: "clankie",
    patchId: patch.patchId,
    status: "changes",
    landable: false,
  };
  const record = { base: patch.base, head: patch.head, landing };
  const status = (value: unknown) =>
    runReviewCommand(["status", "--directory", root], {
      env: { ...env, CLANKIE_INTEGRATE_REVIEW: JSON.stringify(value) },
    });
  expect(await status(record)).toMatchObject({ ok: false, body: landing });
  expect(
    await status({ ...record, landing: { ...landing, status: "approved", landable: true } }),
  ).toMatchObject({ ok: true });
  for (const changed of [
    { head: "0".repeat(40) },
    { base: "0".repeat(40) },
    { landing: { ...landing, patchId: "0".repeat(40) } },
  ])
    await expect(status({ ...record, ...changed })).rejects.toThrow(/does not cover/u);
});
