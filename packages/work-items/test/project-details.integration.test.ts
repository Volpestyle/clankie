import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WorkConventionSchema, WorkProjectDetailsSchema } from "@clankie/protocol/work-items";
import { createLocalTracker, readProjectDetails, TRACKER_OWNER } from "../src/index.ts";

it("reads persisted update threads through the existing comment tools, independently of project comments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "update-replies-"));
  try {
    let tick = 0;
    const tracker = createLocalTracker({
      directory,
      clock: () => new Date(1_790_000_000_000 + tick++ * 1000),
    });
    const project = (await tracker.call("save_project", { name: "Threaded", addTeams: ["LOCAL"] })) as {
      id: string;
    };
    const update = (await tracker.call("save_status_update", {
      type: "project",
      project: project.id,
      body: "Ready for review",
    })) as { id: string };
    await tracker.call(
      "save_comment",
      { projectId: project.id, body: "Project only" },
      { actor: TRACKER_OWNER },
    );
    const first = (await tracker.call(
      "save_comment",
      { statusUpdateId: update.id, body: "First reply" },
      { actor: TRACKER_OWNER },
    )) as { id: string };
    const nested = (await tracker.call(
      "save_comment",
      { parentId: first.id, body: "Reply to reply" },
      { actor: TRACKER_OWNER },
    )) as { id: string };
    const convention = WorkConventionSchema.parse({
      schemaVersion: 1,
      backend: "builtin",
      decidedBy: "owner",
      decidedAt: new Date().toISOString(),
    });
    const reopened = createLocalTracker({ directory });
    const read = () =>
      readProjectDetails(directory, convention, {
        builtIn: { projectId: project.id, teamId: "LOCAL", open: () => reopened },
      });
    const details = await read();
    expect(details.updates[0]).toMatchObject({
      replyCount: 2,
      replies: [
        { id: first.id, body: "First reply", kind: "comment" },
        { id: nested.id, body: "Reply to reply", replyTo: first.id },
      ],
    });
    expect(details.updates[0]!.replies!.every((reply) => Boolean(reply.actor && reply.at))).toBe(true);
    const legacy = structuredClone(details);
    delete legacy.updates[0]!.replies;
    delete legacy.updates[0]!.replyCount;
    expect(WorkProjectDetailsSchema.parse(legacy).updates[0]).not.toHaveProperty("replies");
    // Cross two pagination boundaries and retain only the latest activity window.
    for (let index = 0; index < 201; index++)
      await tracker.call(
        "save_comment",
        { statusUpdateId: update.id, body: `Reply ${index}` },
        { actor: TRACKER_OWNER },
      );
    const bounded = (await read()).updates[0]!;
    expect(bounded.replyCount).toBe(203);
    expect(bounded.replies).toHaveLength(200);
    expect(bounded.replies![0]!.body).toBe("Reply 1");
    expect(bounded.replies!.at(-1)!.body).toBe("Reply 200");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
