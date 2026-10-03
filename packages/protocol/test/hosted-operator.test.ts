import { expect, it } from "vitest";
import { hostedOperatorAllows } from "../src/hosted-operator.ts";

it("limits hosted device authority to explicit routes and validated conversation operations", () => {
  for (const path of ["/v1/operator/persona", "/v1/model-keys/set", "/v1/accounts/github/start"])
    expect(hostedOperatorAllows("POST", path, "{}")).toBe(true);
  for (const op of ["list", "fleet", "terminal_catalog", "roles"])
    expect(
      hostedOperatorAllows("POST", "/operator/v1/dispatch", JSON.stringify({ op, schemaVersion: 1 })),
    ).toBe(true);
  expect(
    hostedOperatorAllows(
      "POST",
      "/operator/v1/dispatch",
      JSON.stringify({ op: "set_persona_role", schemaVersion: 1, personaId: "agent-1", role: "designer" }),
    ),
  ).toBe(true);
  expect(
    hostedOperatorAllows(
      "POST",
      "/operator/v1/dispatch",
      JSON.stringify({ op: "set_persona_role", schemaVersion: 1, personaId: "agent-1", role: "wiz/ard" }),
    ),
  ).toBe(false);
  expect(
    hostedOperatorAllows(
      "POST",
      "/operator/v1/dispatch",
      JSON.stringify({
        op: "reset",
        schemaVersion: 1,
        conversationId: "global-default",
        expectedRevision: 0,
      }),
    ),
  ).toBe(false);
  for (const path of [
    "/v1/restart",
    "/v1/reset",
    "/v1/deprovision",
    "/v1/pairing/offer",
    "/v1/model-keys/future-route",
  ])
    expect(hostedOperatorAllows("POST", path, "{}")).toBe(false);
  expect(hostedOperatorAllows("POST", "/operator/v1/dispatch", '{"op":"send"}')).toBe(false);
  expect(hostedOperatorAllows("PUT", "/v1/swarm/config", '{"enabled":false}')).toBe(false);
  expect(hostedOperatorAllows("PUT", "/v1/swarm/connections", "{}")).toBe(false);
  expect(hostedOperatorAllows("PUT", "/v1/swarm/future-route", "{}")).toBe(false);
});
