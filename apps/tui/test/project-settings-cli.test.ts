import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  FileCredentialStore,
  mintOperatorToken,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
} from "@clankie/credential-broker";
import { ProjectsSettingsSchema, PROJECT_UPDATE_SETTINGS_PATH } from "@clankie/protocol/projects";
import { runProjectSettingsCommand } from "../src/command/project-settings.ts";

it("CLI sends only reviewed fields with an explicit revision and never retries conflicts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "project-edit-cli-"));
  try {
    const store = new FileCredentialStore(join(directory, "credentials.json"));
    const token = mintOperatorToken();
    await store.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: token });
    const changes = join(directory, "changes.json");
    await writeFile(changes, JSON.stringify({ workerCap: 0, trackerRef: null }));
    const snapshot = {
      revision: "a".repeat(64),
      settings: ProjectsSettingsSchema.parse({ projects: [{ id: "garden", name: "Garden" }] }),
    };
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json(snapshot));
    const options = {
      env: { CLANKIE_OPERATOR_TOKEN: token },
      operatorCredentialStore: store,
      host: "http://127.0.0.1:1",
      fetchImpl,
    };
    expect(await runProjectSettingsCommand(["list"], options)).toEqual(snapshot);
    const args = ["update", "garden", "--changes", changes, "--revision", snapshot.revision];
    await runProjectSettingsCommand(args, options);
    expect(new URL(String(fetchImpl.mock.calls[1]![0])).pathname).toBe(PROJECT_UPDATE_SETTINGS_PATH);
    expect(JSON.parse(fetchImpl.mock.calls[1]![1]!.body as string)).toEqual({
      projectId: "garden",
      expectedRevision: snapshot.revision,
      changes: { workerCap: 0, trackerRef: null },
    });
    expect(new Headers(fetchImpl.mock.calls[1]![1]!.headers).get("authorization")).toBe(`Bearer ${token}`);
    fetchImpl.mockResolvedValueOnce(Response.json({}, { status: 409 }));
    await expect(runProjectSettingsCommand(args, options)).rejects.toThrow("Project settings changed");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await writeFile(changes, JSON.stringify({ grants: [] }));
    await expect(runProjectSettingsCommand(args, options)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("membership CLI uses only current operator read credentials and explicit seat correlation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "membership-cli-"));
  try {
    const store = new FileCredentialStore(join(directory, "credentials.json"));
    const token = mintOperatorToken();
    await store.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: token });
    const result = {
      schemaVersion: 1,
      projectsRevision: "a".repeat(64),
      observedAt: new Date().toISOString(),
      seats: [
        {
          seatId: "seat",
          occupantId: "session",
          membership: { outcome: "unknown", reason: "no_confirmed_hire" },
        },
      ],
    };
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json(result));
    const options = {
      env: { CLANKIE_OPERATOR_TOKEN: token },
      operatorCredentialStore: store,
      host: "http://127.0.0.1:1",
      fetchImpl,
    };
    expect(await runProjectSettingsCommand(["membership", "seat", "session"], options)).toEqual(result);
    expect(new URL(String(fetchImpl.mock.calls[0]![0])).pathname).toBe("/v1/operator/fleet-membership/read");
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)).toEqual({
      schemaVersion: 1,
      seats: [{ seatId: "seat", occupantId: "session" }],
    });
    expect(new Headers(fetchImpl.mock.calls[0]![1]!.headers).get("authorization")).toBe(`Bearer ${token}`);
    fetchImpl.mockResolvedValueOnce(Response.json({}, { status: 404 }));
    await expect(runProjectSettingsCommand(["membership", "seat", "session"], options)).rejects.toThrow(
      "does not support",
    );
    await expect(
      runProjectSettingsCommand(["membership", "seat", "session", "--project", "injected"], options),
    ).rejects.toThrow("Usage");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
