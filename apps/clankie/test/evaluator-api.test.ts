import { expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";

it("requires operator authority and validates evaluator commands before dispatch", async () => {
  const commands: unknown[] = [];
  const captain = createStubCaptain();
  const { app } = await createClankieApp({
    captain: createStubCaptain({
      evaluatorCommand: async (command) => {
        commands.push(command);
        return captain.evaluatorStatus();
      },
    }),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
  });
  const path = "/v1/captain/evaluator";
  expect((await app.request(path)).status).toBe(401);
  expect(
    (await app.request(path, { method: "POST", body: JSON.stringify({ action: "enable" }) })).status,
  ).toBe(401);
  const headers = { authorization: "Bearer owner", "content-type": "application/json" };
  expect(
    (
      await app.request(path, {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "enable", harness: "shell" }),
      })
    ).status,
  ).toBe(400);
  expect(commands).toEqual([]);
  expect(
    (
      await app.request(path, {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "enable", harness: "claude" }),
      })
    ).status,
  ).toBe(200);
  expect(commands).toEqual([{ action: "enable", harness: "claude" }]);
});
