import { describe, expect, it } from "vitest";

import {
  defaultOperatorAgentAppearance,
  OPERATOR_CONVERSATION_TITLE_MAX,
  OperatorFleetSnapshotSchema,
  type OperatorAgentPersona,
} from "@clankie/protocol";
import type { SwarmTaskView } from "@clankie/swarm";
import { fleetTasks } from "../src/captain/fleet-tasks.ts";

const coordinator = "a".repeat(64);
function contact(
  personaId: string,
  name: string,
  actor: string,
  conversationId?: string,
): OperatorAgentPersona {
  return {
    schemaVersion: 1,
    personaId,
    name,
    appearance: defaultOperatorAgentAppearance("swarm", personaId),
    harness: "swarm",
    swarm: {
      conversationId: "global-default",
      connectionId: "embedded",
      coordinator,
      scope: "scope-1",
      actor,
      generation: 1,
      available: true,
    },
    ...(conversationId === undefined ? {} : { conversationId }),
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
  };
}

const view: SwarmTaskView = {
  taskId: "task-1",
  scope: "scope-1",
  title: "Build the menu page",
  status: "running",
  lead: { actor: "lead", name: "Clankie", clankie: true },
  owner: { actor: "moss", name: "codex worker" },
  objective: "Build it",
  worktree: "/Users/james/dev/bakery",
  updatedAt: "2026-09-30T12:00:00.000Z",
};

describe("fleetTasks", () => {
  it("names a messageable owner by its contact, preferring the one with a DM", () => {
    const [task] = fleetTasks(
      [view],
      [contact("swarm-first", "Moss", "moss"), contact("swarm-dm", "Moss", "moss", "conv-moss")],
    );
    expect(task).toEqual({
      taskId: "task-1",
      title: "Build the menu page",
      status: "running",
      lead: { name: "Clankie", clankie: true },
      owner: { name: "Moss", personaId: "swarm-dm" },
      objective: "Build it",
      worktree: "/Users/james/dev/bakery",
      updatedAt: "2026-09-30T12:00:00.000Z",
    });
  });

  it("never links an actor from another scope or an internal runtime contact", () => {
    const other = {
      ...contact("swarm-other", "Moss", "moss"),
      swarm: { ...contact("x", "x", "moss").swarm!, scope: "scope-2" },
    };
    const internal = contact("swarm-runtime", "runtime:codex transport:herdr", "moss");
    const [task] = fleetTasks([view], [other, internal]);
    expect(task?.owner).toEqual({ name: "codex worker" });
  });

  it("keeps the snapshot parseable whatever the coordinator stored", () => {
    const { owner: _owner, ...unclaimed } = view;
    const [task] = fleetTasks(
      [
        {
          ...view,
          title: "  ",
          objective: `${"x".repeat(OPERATOR_CONVERSATION_TITLE_MAX + 10)}\nmore`,
          reason: " ",
        },
      ],
      [],
    );
    expect(task?.title.length).toBeLessThanOrEqual(OPERATOR_CONVERSATION_TITLE_MAX);
    expect(task).not.toHaveProperty("reason");
    expect(
      OperatorFleetSnapshotSchema.safeParse({
        schemaVersion: 1,
        cursor: "0",
        seats: [],
        personas: [],
        channels: [],
        tasks: fleetTasks([view, { ...unclaimed, taskId: "task-2", status: "open" }], []),
      }).success,
    ).toBe(true);
  });
});
