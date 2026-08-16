import { describe, expect, it } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLinearPort, LINEAR_PROVIDER_ID, type LinearGraphql } from "../src/linear.ts";

async function harness(graphql: LinearGraphql) {
  const directory = await mkdtemp(join(tmpdir(), "clankie-linear-"));
  const credentials = new FileCredentialStore(join(directory, "creds.json"));
  const settings = new SettingsStore(join(directory, "settings.json"));
  return { credentials, settings, linear: createLinearPort({ credentials, settings, graphql }) };
}

describe("linear port", () => {
  it("refuses when no API key is stored", async () => {
    const { linear } = await harness(async () => ({ data: {} }));
    await expect(linear.search("auth")).resolves.toMatchObject({
      outcome: "refused",
      reason: "credential_unavailable",
    });
  });

  it("searches and maps issue nodes", async () => {
    const { credentials, linear } = await harness(async (_key, query) => {
      expect(query).toContain("searchIssues");
      return {
        data: {
          searchIssues: {
            nodes: [
              {
                id: "issue-1",
                identifier: "ENG-1",
                title: "Fix auth",
                url: "https://linear.app/acme/issue/ENG-1",
                state: { name: "In Progress" },
                team: { key: "ENG", name: "Engineering" },
              },
            ],
          },
        },
      };
    });
    await credentials.set(LINEAR_PROVIDER_ID, { type: "api", key: "lin_api_test" });
    await expect(linear.search("auth")).resolves.toEqual({
      outcome: "ok",
      issues: [
        {
          id: "issue-1",
          identifier: "ENG-1",
          title: "Fix auth",
          url: "https://linear.app/acme/issue/ENG-1",
          state: "In Progress",
          team: "ENG",
        },
      ],
    });
  });

  it("surfaces GraphQL errors as a sayable refusal", async () => {
    const { credentials, linear } = await harness(async () => ({
      errors: [{ message: "invalid key" }],
    }));
    await credentials.set(LINEAR_PROVIDER_ID, { type: "api", key: "lin_api_test" });
    await expect(linear.viewer()).resolves.toEqual({
      outcome: "refused",
      reason: "provider_error",
      detail: "invalid key",
    });
  });

  it("uses a stored Linear OAuth access token as the GraphQL bearer", async () => {
    let authorized: string | undefined;
    const { credentials, linear } = await harness(async (key) => {
      authorized = key;
      return { data: { viewer: { name: "Ada" }, organization: { name: "Acme" } } };
    });
    await credentials.set(LINEAR_PROVIDER_ID, {
      type: "oauth",
      access: "lin_oauth_access",
      refresh: "lin_oauth_refresh",
      expires: Date.now() + 3_600_000,
      clientId: "dyn-client",
    });
    await expect(linear.viewer()).resolves.toEqual({
      outcome: "ok",
      viewer: { name: "Ada", organization: "Acme" },
    });
    expect(authorized).toBe("lin_oauth_access");
  });

  it("will not create an issue without a team", async () => {
    const { credentials, linear } = await harness(async () => ({ data: {} }));
    await credentials.set(LINEAR_PROVIDER_ID, { type: "api", key: "lin_api_test" });
    await expect(linear.create({ title: "No team" })).resolves.toMatchObject({
      outcome: "refused",
      reason: "provider_error",
      detail: expect.stringMatching(/no team id/u),
    });
  });
});
