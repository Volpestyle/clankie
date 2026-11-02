import { afterEach, expect, it } from "vitest";
import { checkpointFixture } from "../../../packages/work-items/test/fixtures/main-checkpoint.ts";
import { createWorkItemsService } from "../src/work-items.ts";
const fixtures: Awaited<ReturnType<typeof checkpointFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
it("the service uses its existing GitHub transport for checkout and issue landing references", async () => {
  const f = await checkpointFixture();
  fixtures.push(f);
  await f.git("remote", "set-url", "origin", "git@github.com:fixture/repo.git");
  const service = createWorkItemsService({
    stateDirectory: f.root,
    githubToken: async () => "fixture-only",
    githubApiBase: f.baseUrl,
  });
  expect(await service.mainCheckpoint(f.root)).toMatchObject({ reason: "main_red", commit: f.merge });
  const issue = { links: [{ url: `https://github.com/fixture/repo/commit/${f.head}` }] };
  await expect(service.checkIssueCheckpoint(issue)).rejects.toThrow("main_red");
  await expect(service.checkIssueCheckpoint({ links: [] })).rejects.toThrow("main_unknown");
  f.link("url");
  expect(await service.mainCheckpoint(f.root)).toBeUndefined();
  await expect(service.checkIssueCheckpoint(issue)).resolves.toBeUndefined();
  await expect(
    service.checkIssueCheckpoint({ links: [{ url: "https://github.com/fixture/repo/pull/279" }] }),
  ).resolves.toBeUndefined();
});
