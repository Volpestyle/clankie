import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import {
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OperatorConversationServiceResultSchema,
} from "@clankie/protocol";
import {
  createLocalTracker,
  TRACKER_LEAD,
  TRACKER_OWNER,
  type LinearImportSnapshot,
} from "@clankie/work-items";
import { expect, it } from "vitest";
import { runEvidenceCommand } from "../../tui/src/command/evidence.ts";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { EvidenceStore, createEvidenceRoutes } from "../src/evidence-store.ts";
import { createWorkItemsService } from "../src/work-items.ts";

const exec = promisify(execFile);
const actor = { kind: "operator" as const, id: "integration", onBehalfOf: [] };

/**
 * VUH-1991: a built-in issue's evidence is found by the identifier the device
 * reads. An item from a scratch import of Clankie Work keeps `VUH-n`; an item
 * created natively in a built-in store for the VUH team is `LOCAL-VUH-n`.
 */
it("finds a built-in issue's pushed evidence by its own key, imported or native, through the device reads", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "evidence-builtin-")));
  const stateDirectory = join(root, "state");
  const service = createWorkItemsService({
    stateDirectory,
    workspace: () => root,
    run: async () => {
      throw new Error("no git here");
    },
  });
  const checkout = async (name: string) => {
    const repo = join(root, name);
    await mkdir(join(repo, "docs/testing/proof"), { recursive: true });
    await exec("git", ["-C", repo, "init", "-b", "main"]);
    await exec("git", [
      "-C",
      repo,
      "-c",
      "user.name=Integration",
      "-c",
      "user.email=integration@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ]);
    // Built-in store for the VUH team: no Linear connection reaches this service.
    await service.handle(
      { action: "init", repo, backend: "linear", linearTeam: "VUH", linearProject: "Clankie Work" },
      true,
    );
    const { repos } = (await service.handle({ action: "repos" }, true)) as {
      repos: { id: string; root?: string }[];
    };
    return { repo, repoId: repos.find((entry) => entry.root === repo)!.id };
  };
  const mirror = await checkout("clankie-work-import");
  const native = await checkout("clankie-work-native");

  // The scratch import of the captured Clankie Work project into one repo's built-in store.
  const snapshot = JSON.parse(
    await readFile(
      new URL("../../../packages/work-items/test/fixtures/linear-import/clankie-work.json", import.meta.url),
      "utf8",
    ),
  ) as LinearImportSnapshot;
  const actors = Object.fromEntries(
    snapshot.actors.map((entry) => [
      entry.id,
      entry.id === "634ad2c8-4992-48b5-b14d-af650cd30030"
        ? { ...TRACKER_OWNER, onBehalfOf: [] }
        : { ...TRACKER_LEAD, onBehalfOf: [TRACKER_OWNER] },
    ]),
  );
  await createLocalTracker({
    directory: join(stateDirectory, "repo-trackers", mirror.repoId),
  }).importLinear(snapshot, actors);
  const importedIssue = snapshot.issues[1]!;
  const importedKey = importedIssue.identifier as string;
  const linkedComment = snapshot.comments.find(
    (comment) => comment.issueId === importedIssue.id && String(comment.body).includes("clankie://evidence/"),
  )!;
  const created = await service.handle({ action: "create", repo: native.repo, title: "Built in" }, true);
  if (!("item" in created)) throw new Error("Expected a native built-in issue");
  const nativeKey = created.item.id;
  expect(nativeKey).toMatch(/^LOCAL-VUH-\d+$/u);

  const store = EvidenceStore.local(join(root, "evidence"));
  const routes = createEvidenceRoutes(store, async (request) =>
    request.headers.get("authorization") === "Bearer integration" ? actor : undefined,
  );
  const server = serve({ fetch: routes.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { app } = await createClankieApp({
    captain: createStubCaptain(),
    workItems: service,
    evidenceStore: store,
    authenticateOperator: async () => ({ operatorId: "owner" }),
    authenticateCaptain: async () => ({ captainId: "operator", steerSourceLane: "api" }),
  });
  const dispatch = async (body: unknown) => {
    const response = await app.request(OPERATOR_CONVERSATION_DISPATCH_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return OperatorConversationServiceResultSchema.parse(await response.json());
  };
  const host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const cases = [
      { ...mirror, key: importedKey },
      { ...native, key: nativeKey },
    ];
    for (const entry of cases) {
      // The device lists each built-in issue by the id it later reads evidence for.
      const listed = await dispatch({ op: "work_items", schemaVersion: 1, repoId: entry.repoId });
      if (listed.op !== "work_items" || listed.result.outcome !== "ready")
        throw new Error(`Expected items: ${JSON.stringify(listed)}`);
      expect(listed.result.items.map((item) => item.id)).toContain(entry.key);

      // A worker on the issue's branch pushes proof; inference takes the key from the branch.
      await exec("git", ["-C", entry.repo, "checkout", "-b", `clankie2/${entry.key.toLowerCase()}-proof`]);
      await writeFile(join(entry.repo, "docs/testing/proof/run.txt"), `${entry.key} passed\n`.repeat(4000));
      const pushed = await runEvidenceCommand(["push", "docs/testing/proof"], {
        cwd: entry.repo,
        host,
        env: { CLANKIE_OPERATOR_TOKEN: "integration" },
        stderr: { write() {} },
      });
      expect(pushed.ok, JSON.stringify(pushed.body)).toBe(true);
      expect(pushed.body).toMatchObject({ issueKey: entry.key, issueSource: "branch", uploaded: 1 });

      // "Proven recently" and the issue sheet's tiles read the store by the item's id.
      expect(await dispatch({ op: "evidence_records", schemaVersion: 1, issueKey: entry.key })).toMatchObject(
        {
          result: {
            outcome: "ready",
            records: [
              expect.objectContaining({ issueKey: entry.key, fileName: "docs/testing/proof/run.txt" }),
            ],
          },
        },
      );
    }

    // The sheet's tiles also take evidence links from the item's activity.
    expect(
      await dispatch({
        op: "work_item_activity",
        schemaVersion: 1,
        repoId: mirror.repoId,
        itemId: importedKey,
      }),
    ).toMatchObject({
      result: {
        outcome: "ready",
        entries: expect.arrayContaining([
          expect.objectContaining({ id: linkedComment.id, body: linkedComment.body }),
        ]),
      },
    });
    const [nativeRecord] = await store.list({ issueKey: nativeKey });
    const report = `Proof: clankie://evidence/sha256/${nativeRecord!.sha256}`;
    await service.callTracker(
      "save_comment",
      { issueId: nativeKey, body: report },
      { repo: native.repo, local: true },
    );
    expect(
      await dispatch({
        op: "work_item_activity",
        schemaVersion: 1,
        repoId: native.repoId,
        itemId: nativeKey,
      }),
    ).toMatchObject({
      result: { outcome: "ready", entries: [expect.objectContaining({ body: report })] },
    });

    // A native key's tail is another tracker's item, never the same one.
    expect(
      await dispatch({
        op: "evidence_records",
        schemaVersion: 1,
        issueKey: nativeKey.replace(/^LOCAL-/u, ""),
      }),
    ).toMatchObject({ result: { outcome: "ready", records: [] } });
  } finally {
    server.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
