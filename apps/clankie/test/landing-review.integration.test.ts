import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const execute = promisify(execFile);
const roots: string[] = [];
const checkout = resolve(import.meta.dirname, "../../..");
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A private HOME with no owner stores and dead service URLs, under CI semantics. */
async function environment() {
  const root = await mkdtemp(join(tmpdir(), "landing-review-"));
  roots.push(root);
  const home = join(root, "home");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    CLANKIE_STATE: join(home, ".clankie"),
    CLANKIE_SETTINGS_FILE: join(home, ".config", "clankie", "settings.json"),
    CLANKIE_CREDENTIALS_FILE: join(home, ".config", "clankie", "credentials.json"),
    CLANKIE_CONTROL_PLANE_URL: "http://127.0.0.1:1",
    CLANKIE_CAPTAIN_URL: "http://127.0.0.1:1",
    CI: "1",
  };
  return { root, env };
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

it("holds a CI gate with a configured reviewer and an unreachable service", async () => {
  const { env } = await environment();
  await mkdir(dirname(env.CLANKIE_SETTINGS_FILE!), { recursive: true });
  await writeFile(
    env.CLANKIE_SETTINGS_FILE!,
    JSON.stringify({ projects: { projects: [{ id: "clankie", review: { role: "reviewer" } }] } }),
  );
  const result = await gate({ ...env, CLANKIE_OPERATOR_TOKEN: "fixture-token" });
  expect(result.state).toBe("unavailable");
  expect(result.message).toContain("landing held");
});

it("skips review in external CI with no owner settings", async () => {
  const { env } = await environment();
  const result = await gate(env);
  expect(result.state).toBe("skipped");
  expect(result.detail).toContain("Reviews need the operator credential");
});
