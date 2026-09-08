import { expect, it } from "vitest";
import { runResetCommand } from "../src/command/reset.ts";

it("resets the explicit conversation at its current revision and reports refusals", async () => {
  const conversation = {
    schemaVersion: 1,
    conversationId: "global-default",
    scope: { kind: "global" },
    title: "Clankie",
    isDefault: true,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    sessionState: "unbound",
    revision: 7,
  };
  const requests: unknown[] = [];
  const output: string[] = [];
  let refuse = false;
  const options = {
    env: { CLANKIE_CAPTAIN_TOKEN: "test-captain" },
    stdout: { write: (chunk: string) => output.push(chunk) },
    fetchImpl: (async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      requests.push(request);
      if (request.op === "get") return Response.json({ op: "get", schemaVersion: 1, conversation });
      if (refuse)
        return Response.json(
          { error: "reset_refused", message: "Wait for the current turn" },
          { status: 409 },
        );
      return Response.json({
        op: "reset",
        schemaVersion: 1,
        conversation: { ...conversation, revision: 8 },
        archiveId: "reset-test",
      });
    }) as typeof fetch,
  };
  await expect(runResetCommand([], options)).rejects.toThrow("Usage:");
  expect(requests).toHaveLength(0);
  expect(await runResetCommand(["--conversation", "global-default"], options)).toBe(0);
  expect(requests[1]).toEqual({
    op: "reset",
    schemaVersion: 1,
    conversationId: "global-default",
    expectedRevision: 7,
  });
  expect(JSON.parse(output.join(""))).toMatchObject({
    ok: true,
    archiveId: "reset-test",
    conversation: { revision: 8 },
  });
  refuse = true;
  await expect(runResetCommand(["--conversation", "global-default"], options)).rejects.toThrow(
    "Wait for the current turn",
  );
});
