import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { runConversationsCommand } from "../src/command/conversations.ts";
const target = {
  conversationId: "workspace",
  incarnationId: randomUUID(),
  requestId: randomUUID(),
  expectedRevision: 3,
  proposalId: randomUUID(),
  artifactSha256: "a".repeat(64),
  expectedProjectsRevision: "b".repeat(64),
};
const args = [
  "confirm-project",
  target.conversationId,
  "--request",
  target.requestId,
  "--incarnation",
  target.incarnationId,
  "--revision",
  "3",
  "--proposal",
  target.proposalId,
  "--artifact",
  target.artifactSha256,
  "--projects-revision",
  target.expectedProjectsRevision,
];
it("CLI forwards exactly reviewed target; uncertain result is nonzero and never retried", async () => {
  const seen: unknown[] = [];
  const output: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    seen.push(JSON.parse(String(init?.body)));
    return Response.json({
      op: "project_proposal_confirm",
      schemaVersion: 1,
      result: { status: "uncertain" },
    });
  };
  expect(
    await runConversationsCommand(args, {
      env: { CLANKIE_OPERATOR_TOKEN: "fixture" },
      host: "http://fixture",
      fetchImpl,
      stdout: {
        write: (s) => {
          output.push(String(s));
          return true;
        },
      },
    }),
  ).toBe(1);
  expect(seen).toEqual([{ op: "project_proposal_confirm", schemaVersion: 1, ...target }]);
  expect(output.join("")).toContain("uncertain");
});
it("CLI refuses missing/ambiguous/replacement fields before any dispatch", async () => {
  const fetchImpl = vi.fn();
  for (const input of [args.slice(0, -2), [...args, "--text", "yes"], [...args, "--workspace", "/fake"]])
    await expect(
      runConversationsCommand(input, { env: { CLANKIE_OPERATOR_TOKEN: "fixture" }, fetchImpl }),
    ).rejects.toThrow();
  expect(fetchImpl).not.toHaveBeenCalled();
});
it("proposal review reads an exact locator and never confirms implicitly", async () => {
  const seen: unknown[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    seen.push(JSON.parse(String(init?.body)));
    return Response.json({
      op: "project_proposal_get",
      schemaVersion: 1,
      result: { status: "refused", reason: "stale_proposal" },
    });
  };
  const result = await runConversationsCommand(
    [
      "project-proposal",
      target.conversationId,
      "--request",
      target.requestId,
      "--incarnation",
      target.incarnationId,
    ],
    {
      env: { CLANKIE_OPERATOR_TOKEN: "fixture" },
      host: "http://fixture",
      fetchImpl,
      stdout: { write: () => true },
    },
  );
  expect(result).toBe(1);
  expect(seen).toEqual([
    {
      op: "project_proposal_get",
      schemaVersion: 1,
      conversationId: target.conversationId,
      incarnationId: target.incarnationId,
      requestId: target.requestId,
    },
  ]);
});
