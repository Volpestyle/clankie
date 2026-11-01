import { expect, it } from "vitest";
import { publicGatewayTargetFor } from "../src/public-gateway.ts";
import { hostedOperatorAllows } from "../src/hosted-operator.ts";

it("limits hosted device authority to explicit routes and validated conversation operations", () => {
  for (const path of ["/v1/operator/persona", "/v1/model-keys/set", "/v1/accounts/github/start"])
    expect(hostedOperatorAllows("POST", path, "{}")).toBe(true);
  expect(
    hostedOperatorAllows(
      "POST",
      "/operator/v1/dispatch",
      JSON.stringify({
        op: "work_project",
        schemaVersion: 1,
        repoId: "workspace",
      }),
    ),
  ).toBe(true);
  expect(
    hostedOperatorAllows(
      "POST",
      "/operator/v1/dispatch",
      JSON.stringify({
        op: "work_project",
        schemaVersion: 1,
        repoId: "/tmp/arbitrary-path",
      }),
    ),
  ).toBe(false);
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
  expect(hostedOperatorAllows("GET", "/v1/operator/fleet-settings")).toBe(true);
  expect(hostedOperatorAllows("POST", "/v1/operator/fleet-settings", "{}")).toBe(true);
  expect(hostedOperatorAllows("GET", "/v1/operator/projects?includeAutonomy=true")).toBe(true);
  expect(hostedOperatorAllows("POST", "/v1/operator/projects/update?includeAutonomy=true", "{}")).toBe(true);
  for (const path of [
    "/v1/operator/fleet-settings/context",
    "/v1/operator/projects/create",
    "/v1/operator/projects/worktree-roots/add",
    "/v1/operator/projects?includeAutonomy=false",
    "/v1/operator/projects?includeAutonomy=true&unknown=true",
    "/v1/operator/projects?includeAutonomy=true&includeAutonomy=true",
    "/v1/operator/projects?include%41utonomy=true",
    "/v1/operator/fleet-settings?includeAutonomy=true",
  ]) {
    expect(publicGatewayTargetFor("GET", path)).toBeUndefined();
    expect(publicGatewayTargetFor("POST", path)).toBeUndefined();
    expect(hostedOperatorAllows("GET", path)).toBe(false);
    expect(hostedOperatorAllows("POST", path, "{}")).toBe(false);
  }
});

it("allows explicit Settings projections without broadening query authority", () => {
  const hire = "/v1/operator/fleet-settings/hire?includeModels=true";
  expect(hostedOperatorAllows("GET", hire)).toBe(true);
  expect(publicGatewayTargetFor("GET", hire)).toBe("relay");
  expect(publicGatewayTargetFor("POST", hire)).toBeUndefined();
  expect(hostedOperatorAllows("POST", hire, "{}")).toBe(false);
  for (const query of [
    "includeWorkPolicy=true",
    "includeMaximumTrust=true",
    "includeWorkPolicy=true&includeMaximumTrust=true",
    "includeMaximumTrust=true&includeWorkPolicy=true",
  ]) {
    for (const method of ["GET", "POST"] as const) {
      expect(hostedOperatorAllows(method, `/v1/operator/fleet-settings?${query}`, "{}")).toBe(true);
      expect(publicGatewayTargetFor(method, `/v1/operator/fleet-settings?${query}`)).toBe("relay");
    }
  }
  for (const path of [
    hire + "&unknown=true",
    hire + "&includeModels=true",
    "/v1/operator/fleet-settings/hire?includeModels=false",
    "/v1/operator/fleet-settings/hire?include%4Dodels=true",
    "/v1/operator/fleet-settings?includeMaximumTrust=true&unknown=true",
    "/v1/operator/fleet-settings?includeMaximumTrust=true&includeMaximumTrust=true",
    "/v1/operator/fleet-settings?includeMaximumTrust=false",
  ]) {
    expect(publicGatewayTargetFor("GET", path)).toBeUndefined();
    expect(publicGatewayTargetFor("POST", path)).toBeUndefined();
    expect(hostedOperatorAllows("GET", path)).toBe(false);
    expect(hostedOperatorAllows("POST", path, "{}")).toBe(false);
  }
});

it("lets an owner device reach the extension switches through the gateway and a hosted body (ADR 0328)", () => {
  for (const method of ["GET", "POST"] as const) {
    expect(publicGatewayTargetFor(method, "/v1/extensions")).toBe("control");
    expect(hostedOperatorAllows(method, "/v1/extensions", "{}")).toBe(true);
  }
  expect(hostedOperatorAllows("DELETE", "/v1/extensions")).toBe(false);
});
