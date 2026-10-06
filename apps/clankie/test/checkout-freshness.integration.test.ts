import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { checkoutGit, syncOwnerCheckout } from "@clankie/settings";
import { remoteCheckoutProgram } from "../src/captain/checkout-freshness.ts";
const exec = promisify(execFile);
it("remote observer enforces fetched main and cleanliness in a real child process", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-remote-freshness-")));
  try {
    const origin = join(root, "origin.git"),
      owner = join(root, "owner"),
      writer = join(root, "writer");
    await exec("git", ["init", "--bare", "--initial-branch=main", origin]);
    await exec("git", ["clone", origin, owner]);
    await checkoutGit(owner, ["config", "user.name", "Fixture"]);
    await checkoutGit(owner, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(owner, "base.txt"), "base\n");
    await checkoutGit(owner, ["add", "base.txt"]);
    await checkoutGit(owner, [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "base",
    ]);
    await checkoutGit(owner, ["push", "origin", "main"]);
    const observe = async () =>
      JSON.parse((await exec(process.execPath, ["-e", remoteCheckoutProgram(owner)])).stdout);
    expect(await observe()).toMatchObject({ outcome: "fresh" });
    await exec("git", ["clone", origin, writer]);
    await checkoutGit(writer, ["config", "user.name", "Fixture"]);
    await checkoutGit(writer, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(writer, "base.txt"), "remote\n");
    await checkoutGit(writer, ["add", "base.txt"]);
    await checkoutGit(writer, [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "advance",
    ]);
    await checkoutGit(writer, ["push", "origin", "main"]);
    expect(await observe()).toMatchObject({
      outcome: "refused",
      reason: expect.stringContaining("origin/main"),
    });
    expect((await syncOwnerCheckout(owner)).outcome).toBe("updated");
    await writeFile(join(owner, "draft.txt"), "dirty\n");
    expect(await observe()).toMatchObject({ outcome: "refused", reason: expect.stringContaining("dirty") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("the real captain refuses a dirty hire before launch and serves checkout maintenance through the authenticated CLI/API", async () => {
  const { createCaptain } = await import("../src/captain/captain.ts");
  const { createClankieApp } = await import("../src/app.ts");
  const { SettingsStore } = await import("@clankie/settings");
  const { createHerdrWatchRunner } = await import("../src/captain/herdr-watch.ts");
  const { ProjectSchema } = await import("@clankie/protocol/projects");
  const { CheckoutReportSchema } = await import("@clankie/protocol");
  const { runCheckoutsCommand } = await import("../../tui/src/command/checkouts.ts");
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-checkouts-api-")));
  const origin = join(root, "origin.git"),
    owner = join(root, "owner");
  let captain: ReturnType<typeof createCaptain> | undefined;
  let service: Awaited<ReturnType<typeof createClankieApp>> | undefined;
  try {
    await exec("git", ["init", "--bare", "--initial-branch=main", origin]);
    await exec("git", ["clone", origin, owner]);
    await checkoutGit(owner, ["config", "user.name", "Fixture"]);
    await checkoutGit(owner, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(owner, "base.txt"), "base\n");
    await checkoutGit(owner, ["add", "base.txt"]);
    await checkoutGit(owner, [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "base",
    ]);
    await checkoutGit(owner, ["push", "origin", "main"]);
    const settings = new SettingsStore(join(root, "settings.json"));
    await settings.update((current) => ({
      ...current,
      projects: {
        ...current.projects,
        projects: [
          ...current.projects.projects,
          ProjectSchema.parse({
            id: "checkout-fixture",
            name: "Checkout fixture",
            workspaces: [
              {
                id: "owner",
                machineId: "local",
                platform: process.platform === "win32" ? "windows" : "posix",
                path: owner,
              },
            ],
          }),
        ],
      },
    }));
    captain = createCaptain({ herdrAvailable: () => true } as import("../src/captain/deps.ts").CaptainDeps, {
      repoRoot: owner,
      stateDir: join(root, "state"),
      settings,
      nativeHerdrRunner: createHerdrWatchRunner(() => false),
    });
    await writeFile(join(owner, "draft.txt"), "keep owner draft\n");
    expect(
      await captain.serveOperatorConversation({
        schemaVersion: 1,
        op: "spawn_seat",
        conversationId: "global-default",
        seat: { schemaVersion: 1, harness: "codex", title: "Fixture", workingDirectory: owner },
        brief: "implement",
      }),
    ).toMatchObject({
      op: "spawn_seat",
      result: { outcome: "failed", reason: "not_ready", detail: expect.stringContaining("dirty") },
    });
    service = await createClankieApp({
      captain,
      authenticateOperator: async (request) =>
        request.headers.get("authorization") === "Bearer fixture-owner"
          ? { operatorId: "fixture-owner" }
          : undefined,
    });
    const app = service.app;
    const cli = {
      host: "http://fixture.invalid",
      env: { CLANKIE_OPERATOR_TOKEN: "fixture-owner" },
      fetchImpl: async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        app.fetch(new Request(input, init)),
    };
    const report = CheckoutReportSchema.parse(await runCheckoutsCommand(["status"], cli));
    expect(report.checkouts).toContainEqual(expect.objectContaining({ path: owner, dirty: true, behind: 0 }));
    expect(await runCheckoutsCommand(["sync", "--repository", owner], cli)).toMatchObject([
      { path: owner, outcome: "current" },
    ]);
    await expect(runCheckoutsCommand(["sync", "--repository", root], cli)).rejects.toThrow("409");
    await expect(
      runCheckoutsCommand(["status"], { ...cli, env: { CLANKIE_OPERATOR_TOKEN: "wrong-owner" } }),
    ).rejects.toThrow("401");
    expect(await readFile(join(owner, "draft.txt"), "utf8")).toBe("keep owner draft\n");
  } finally {
    service?.close();
    await captain?.close();
    await rm(root, { recursive: true, force: true });
  }
});
