import { createGithubBackend } from "../src/backends/github.ts";
import { mainCheckpoint } from "../src/main-checkpoint.ts";
import { afterEach, expect, it } from "vitest";
import { checkpointFixture } from "./fixtures/main-checkpoint.ts";
const fixtures: Awaited<ReturnType<typeof checkpointFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
async function fixture() {
  const f = await checkpointFixture();
  fixtures.push(f);
  return f;
}

it("resolves the actual first main merge across a parallel main commit and holds red until an issue names it", async () => {
  const f = await fixture();
  expect(await f.check()).toEqual({
    reason: "main_red",
    commit: f.merge,
    runUrl: f.runUrl,
    failingJobs: ["landing", "checkpoint", "mac"],
  });
  for (const link of ["sha-jobs", "url", "comment"] as const) {
    f.link(link);
    expect(await f.check()).toBeUndefined();
  }
});
it.each(["green", "descendant"])("allows %s post-merge checkpoint coverage", async (mode) => {
  const f = await fixture();
  f.mode(mode);
  expect(await f.check()).toBeUndefined();
});
it.each(["running", "cancelled", "unknown", "unreachable", "unrelated", "missing-job"])(
  "holds %s without positive checkpoint evidence",
  async (mode) => {
    const f = await fixture();
    f.mode(mode);
    expect(await f.check()).toMatchObject({
      reason: mode === "running" ? "main_pending" : mode === "missing-job" ? "main_red" : "main_unknown",
    });
  },
);

it("checks a direct-main worker HEAD at that commit itself", async () => {
  const f = await fixture();
  expect(await mainCheckpoint(f.api, "fixture/repo", f.merge)).toMatchObject({
    reason: "main_red",
    commit: f.merge,
  });
});
it("GitHub issue Done refuses a merged job's red run until a linked bug exists", async () => {
  const f = await fixture();
  const backend = createGithubBackend({ repo: "fixture/repo", api: f.api, checkpointCache: f.cache });
  await expect(backend.update("280", { status: "done" })).rejects.toThrow("main_red");
  expect(f.requests.some((path) => path === "/repos/fixture/repo/issues/280/parent")).toBe(false);
  f.link("url");
  expect(await backend.update("280", { status: "done" })).toMatchObject({ status: "done" });
});

it("the merge's filed red result still covers its job after another descendant runs red", async () => {
  const f = await fixture();
  f.mode("red-descendant");
  f.link("url");
  expect(await f.check()).toBeUndefined();
});
it.each(["running", "cancelled"])(
  "a linked issue cannot turn a %s run into a completed result",
  async (mode) => {
    const f = await fixture();
    f.mode(mode);
    f.link("url");
    expect(await f.check()).toMatchObject({ reason: mode === "running" ? "main_pending" : "main_unknown" });
  },
);

it.each(["no-checkpoint", "no-runs"])("does not hold a %s repository", async (mode) => {
  const f = await fixture();
  f.mode(mode);
  expect(await f.check()).toBeUndefined();
});

it("coalesces a sweep by merge and run, then refreshes a newly linked bug after three minutes", async () => {
  const f = await fixture();
  const results = await Promise.all(Array.from({ length: 35 }, () => f.check()));
  expect(results.every((result) => result?.reason === "main_red")).toBe(true);
  expect(f.requests.filter((path) => path.startsWith("/search/issues"))).toHaveLength(5);
  // One read of the repository's recent runs, one of the merge's own by head SHA.
  expect(f.requests.filter((path) => path.includes("/actions/runs?"))).toHaveLength(2);
  const reads = f.requests.length;
  await f.check();
  expect(f.requests).toHaveLength(reads);
  // A different landed HEAD that resolves to the same merge reuses its result.
  expect(await mainCheckpoint(f.api, "fixture/repo", f.merge, { cache: f.cache })).toMatchObject({
    reason: "main_red",
  });
  expect(f.requests.filter((path) => path.startsWith("/search/issues"))).toHaveLength(5);
  f.link("url", false);
  expect(await f.check()).toMatchObject({ reason: "main_red" });
  f.advance();
  expect(await f.check()).toBeUndefined();
});
it("caches rate-limited reads as unknown, then retries when the cache expires", async () => {
  const f = await fixture();
  f.mode("rate-limited");
  expect(await f.check()).toMatchObject({ reason: "main_unknown" });
  const reads = f.requests.length;
  expect(await f.check()).toMatchObject({ reason: "main_unknown" });
  expect(f.requests).toHaveLength(reads);
  f.advance();
  f.mode("green");
  expect(await f.check()).toBeUndefined();
});

it.each(["sha", "sha-comment", "sha-partial"] as const)(
  "keeps red held when %s evidence does not account for all failing jobs",
  async (link) => {
    const f = await fixture();
    f.link(link);
    expect(await f.check()).toMatchObject({ reason: "main_red", runUrl: f.runUrl });
  },
);
it.each(["red-descendant", "green-descendant-red-own"])(
  "uses the merge's own red result despite %s and a bug for the descendant",
  async (mode) => {
    const f = await fixture();
    f.mode(mode);
    f.link("descendant-url");
    expect(await f.check()).toMatchObject({ reason: "main_red", runUrl: f.runUrl });
  },
);
it("keeps the merge's own completed green result when a later checkpoint is red", async () => {
  const f = await fixture();
  f.mode("red-descendant-green-own");
  expect(await f.check()).toBeUndefined();
});
it("does not substitute a green descendant for a running own checkpoint", async () => {
  const f = await fixture();
  f.mode("green-descendant-running-own");
  expect(await f.check()).toMatchObject({ reason: "main_pending", runUrl: f.runUrl });
});
it("does not substitute a descendant when the merge's run is absent", async () => {
  const f = await fixture();
  f.mode("missing-own");
  expect(await f.check()).toMatchObject({ reason: "main_unknown" });
});
it("requires the descendant's bug when a cancelled own run uses red descendant coverage", async () => {
  const f = await fixture();
  f.mode("red-descendant-cancelled-own");
  f.link("url");
  expect(await f.check()).toMatchObject({ reason: "main_red", runUrl: f.runUrl.replace("280", "281") });
  f.link("sha-jobs");
  expect(await f.check()).toMatchObject({ reason: "main_red" });
  f.link("descendant-url");
  expect(await f.check()).toBeUndefined();
});

it("uses the newest finished descendant after cancellation even when a newer run is running", async () => {
  const f = await fixture();
  f.mode("running-descendant-red-finished-cancelled-own");
  expect(await f.check()).toMatchObject({ reason: "main_red", runUrl: f.runUrl.replace("280", "281") });
  f.link("descendant-url");
  expect(await f.check()).toBeUndefined();
});
