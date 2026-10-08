import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { checkoutGit, verifyHireCheckout } from "@clankie/settings";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { ProjectHires } from "../src/captain/project-hires.ts";

const exec = promisify(execFile);
it("releases a policy-admitted hire after a real stale-checkout refusal, but retains an attempted native launch", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "project-hire-refusal-")));
  try {
    const origin = join(root, "origin.git"),
      writer = join(root, "writer"),
      checkout = join(root, "checkout");
    await exec("git", ["init", "--bare", "--initial-branch=main", origin]);
    await exec("git", ["clone", origin, writer]);
    await checkoutGit(writer, ["config", "user.name", "Fixture"]);
    await checkoutGit(writer, ["config", "user.email", "fixture@example.invalid"]);
    const commit = async (contents: string) => {
      await writeFile(join(writer, "base.txt"), contents);
      await checkoutGit(writer, ["add", "base.txt"]);
      await checkoutGit(writer, [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        contents.trim(),
      ]);
      await checkoutGit(writer, ["push", "origin", "main"]);
    };
    await commit("base\n");
    await exec("git", ["clone", origin, checkout]);
    await checkoutGit(checkout, ["config", "user.name", "Fixture"]);
    await checkoutGit(checkout, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(checkout, "local.txt"), "local work\n");
    await checkoutGit(checkout, ["add", "local.txt"]);
    await checkoutGit(checkout, [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "local work",
    ]);
    await commit("advance\n");
    const path = join(root, "project-hires.json"),
      ledger = new ProjectHires(path);
    const settings = ProjectsSettingsSchema.parse({
      projects: [{ id: "clankie", name: "Clankie", workerCap: 1 }],
    });
    const input = {
      schemaVersion: 1 as const,
      harness: "codex" as const,
      title: "Nell",
      workingDirectory: checkout,
      projectId: "clankie",
      deliverable: "VUH-1702",
    };
    const first = ledger.reserve(settings, "clankie", input);
    ledger.launch(first.id, settings, false);
    const freshness = await verifyHireCheckout(checkout);
    expect(freshness).toMatchObject({
      outcome: "refused",
      reason: expect.stringContaining("Start checkout does not contain fetched origin/main"),
    });
    ledger.failed(first.id);
    const retry = new ProjectHires(path).reserve(settings, "clankie", input);
    expect(retry.id).not.toBe(first.id);
    expect(retry.reused).toBe(false);
    const history = JSON.parse(await readFile(path, "utf8"));
    expect(history.allocations[0]).toMatchObject({ id: first.id, started: false, gone: true });
    ledger.launch(retry.id, settings);
    ledger.failed(retry.id);
    expect(new ProjectHires(path).reserve(settings, "clankie", input)).toMatchObject({
      id: retry.id,
      reused: true,
      started: true,
      gone: false,
    });
    const candidate = ledger.recoveryCandidate(retry.id)!;
    ledger.pane(retry.id, "original-pane");
    expect(() => ledger.release(candidate, [])).toThrow("changed");
    const observed = ledger.recoveryCandidate(retry.id)!;
    ledger.release(observed, []);
    const released = new ProjectHires(path).recoveryCandidate(retry.id)!;
    expect(released).toMatchObject({
      started: true,
      pane: "original-pane",
      gone: true,
      operatorRelease: { censusSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.env.NATIVE_HIRE_ALLOCATION_FIXTURES !== "1")(
  "operator CLI/API releases only absent allocations using a real owned Herdr inventory",
  async () => {
    const { isolatedHerdr } = await import("./fixtures/local-fleet-proof/herdr-fixture.ts");
    const { createHerdrWatchRunner } = await import("../src/captain/herdr-watch.ts");
    const { createCaptain } = await import("../src/captain/captain.ts");
    const { createClankieApp } = await import("../src/app.ts");
    const { SettingsStore } = await import("@clankie/settings");
    const { runHireReceiptCommand } = await import("../../tui/src/command/hire-receipt.ts");
    const root = await realpath(await mkdtemp(join(tmpdir(), "hire-allocation-api-")));
    const herdr = await isolatedHerdr(join(root, "logs"));
    let captain: ReturnType<typeof createCaptain> | undefined;
    let service: Awaited<ReturnType<typeof createClankieApp>> | undefined;
    let inventoryAvailable = true;
    const binding = { runtime: "external" as const, socketPath: herdr.socketPath, session: "default" };
    try {
      const stateDir = join(root, "state"),
        settings = new SettingsStore(join(root, "settings.json"));
      const { DeliveryFence } = await import("../src/captain/delivery-fence.ts");
      const fence = new DeliveryFence(join(stateDir, "herdr-watches.json.hire-receipts.json"));
      const uncertainDirectory = join(root, "uncertain-worktree");
      fence.begin(JSON.stringify(["local", "codex", uncertainDirectory, "new"]), {
        fingerprint: "a".repeat(64),
      });
      captain = createCaptain(
        { herdrAvailable: () => true } as import("../src/captain/deps.ts").CaptainDeps,
        {
          repoRoot: root,
          stateDir,
          settings,
          nativeHerdrRunner: createHerdrWatchRunner(undefined, undefined, undefined, {
            localReadBinding: async () =>
              inventoryAvailable ? binding : { ...binding, socketPath: join(root, "missing.sock") },
          }),
        },
      );
      service = await createClankieApp({
        captain,
        authenticateOperator: async (req) =>
          req.headers.get("authorization") === "Bearer fixture-owner"
            ? { operatorId: "fixture-owner" }
            : undefined,
      });
      const ledgerPath = join(stateDir, "herdr-watches.json.project-hires.json"),
        ledger = new ProjectHires(ledgerPath);
      const policy = ProjectsSettingsSchema.parse({ projects: [{ id: "clankie", name: "Clankie" }] });
      const cli = async (id: string, token = "fixture-owner") => {
        let output = "";
        const exit = await runHireReceiptCommand(["settle", id, "release-allocation"], {
          host: "http://fixture.invalid",
          env: { CLANKIE_CAPTAIN_TOKEN: token },
          fetchImpl: async (input, init) => service!.app.fetch(new Request(String(input), init)),
          stdout: {
            write: (text: string) => {
              output += text;
            },
          },
        });
        return { exit, result: JSON.parse(output) };
      };
      const allocate = (title: string, workingDirectory: string) => {
        const a = ledger.reserve(policy, "clankie", {
          schemaVersion: 1,
          harness: "codex",
          title,
          workingDirectory,
        });
        ledger.launch(a.id, policy);
        return a;
      };
      const absent = allocate("Nell", join(root, "absent-worktree"));
      const uncertain = allocate("Ada", uncertainDirectory);
      expect(await cli(uncertain.id)).toMatchObject({
        exit: 1,
        result: { state: "refused", detail: expect.stringContaining("original native hire receipt") },
      });
      expect(ledger.recoveryCandidate(uncertain.id)?.gone).toBe(false);
      await expect(cli(absent.id, "wrong-owner")).rejects.toThrow();
      inventoryAvailable = false;
      expect(await cli(absent.id)).toMatchObject({ exit: 1, result: { state: "refused" } });
      expect(ledger.recoveryCandidate(absent.id)?.gone).toBe(false);
      inventoryAvailable = true;
      expect(await cli(absent.id)).toMatchObject({
        exit: 0,
        result: { state: "allocation-released", receiptId: absent.id },
      });
      const history = await readFile(ledgerPath, "utf8");
      expect(await cli(absent.id)).toMatchObject({ exit: 0, result: { state: "allocation-released" } });
      expect(await readFile(ledgerPath, "utf8")).toBe(history);
      const present = allocate("Pell", join(root, "pane-worktree"));
      ledger.pane(present.id, herdr.pane);
      expect(await cli(present.id)).toMatchObject({
        exit: 1,
        result: { state: "refused", detail: expect.stringContaining("still present") },
      });
      const confirmed = allocate("Confirmed", join(root, "confirmed-worktree"));
      ledger.confirmed(confirmed.id);
      expect(await cli(confirmed.id)).toMatchObject({ exit: 1, result: { state: "refused" } });
      expect(
        (await herdr.cli("pane", "list")).result.panes.some(
          (pane: { pane_id: string }) => pane.pane_id === herdr.pane,
        ),
      ).toBe(true);
    } finally {
      service?.close();
      await captain?.close();
      await herdr.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
