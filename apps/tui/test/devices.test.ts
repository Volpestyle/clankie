import { describe, expect, it } from "vitest";
import type { CredentialStore, ProviderCredential, RedactedCredential } from "@clankie/credential-broker";
import { runHeadlessCaptainCommand } from "../bin/headless-captain.ts";
import type { DeviceListItem } from "../bin/devices.ts";

const OPERATOR_ENV: NodeJS.ProcessEnv = { CLANKIE_OPERATOR_TOKEN: "operator-secret" };

class MemoryCredentialStore implements CredentialStore {
  private readonly credentials = new Map<string, ProviderCredential>();
  public get(providerId: string): Promise<ProviderCredential | undefined> {
    return Promise.resolve(this.credentials.get(providerId));
  }
  public set(providerId: string, credential: ProviderCredential): Promise<void> {
    this.credentials.set(providerId, credential);
    return Promise.resolve();
  }
  public delete(providerId: string): Promise<boolean> {
    return Promise.resolve(this.credentials.delete(providerId));
  }
  public list(): Promise<Record<string, RedactedCredential>> {
    return Promise.resolve({});
  }
}

function outputBuffer(): { readonly stream: { write(chunk: string): void }; readonly text: () => string } {
  let output = "";
  return {
    stream: {
      write(chunk) {
        output += chunk;
      },
    },
    text: () => output,
  };
}

function device(overrides: Partial<DeviceListItem> = {}): DeviceListItem {
  return {
    deviceId: "device-abc123",
    name: "James iPhone",
    platform: "ios",
    status: "active",
    grants: { chat: true, steer: true, terminalObserve: true, terminalControl: false },
    createdAt: "2026-07-13T12:00:00.000Z",
    activatedAt: "2026-07-13T12:01:00.000Z",
    ...overrides,
  };
}

function jsonFetch(body: unknown, init?: ResponseInit, calls?: { count: number }): typeof fetch {
  return (async () => {
    if (calls !== undefined) calls.count += 1;
    return Response.json(body, init);
  }) as typeof fetch;
}

function throwingFetch(error: unknown, calls?: { count: number }): typeof fetch {
  return (async () => {
    if (calls !== undefined) calls.count += 1;
    throw error;
  }) as typeof fetch;
}

async function runDevices(
  args: readonly string[],
  overrides: {
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    operatorCredentialStore?: CredentialStore;
    stdout?: { write(chunk: string): void };
    stderr?: { write(chunk: string): void };
  } = {},
): Promise<number> {
  return runHeadlessCaptainCommand(["devices", ...args], {
    repoRoot: "/unused",
    env: overrides.env ?? OPERATOR_ENV,
    ...(overrides.operatorCredentialStore === undefined
      ? {}
      : { operatorCredentialStore: overrides.operatorCredentialStore }),
    ...(overrides.fetchImpl === undefined ? {} : { fetchImpl: overrides.fetchImpl }),
    ...(overrides.stdout === undefined ? {} : { stdout: overrides.stdout }),
    ...(overrides.stderr === undefined ? {} : { stderr: overrides.stderr }),
  });
}

describe("clankie devices — list", () => {
  it("renders a table of paired devices", async () => {
    const stdout = outputBuffer();
    const exit = await runDevices([], {
      fetchImpl: jsonFetch([
        device(),
        device({ deviceId: "device-def456", name: "iPad", status: "revoked" }),
      ]),
      stdout: stdout.stream,
    });
    expect(exit).toBe(0);
    expect(stdout.text()).toContain("device-abc123");
    expect(stdout.text()).toContain("chat+steer+observe");
    expect(stdout.text()).toContain("device-def456");
    expect(stdout.text()).toContain("revoked");
  });

  it("emits JSON with --json", async () => {
    const stdout = outputBuffer();
    const exit = await runDevices(["--json"], { fetchImpl: jsonFetch([device()]), stdout: stdout.stream });
    expect(exit).toBe(0);
    const parsed = JSON.parse(stdout.text());
    expect(parsed.ok).toBe(true);
    expect(parsed.devices[0].deviceId).toBe("device-abc123");
  });

  it("reports an empty list clearly", async () => {
    const stdout = outputBuffer();
    const exit = await runDevices([], { fetchImpl: jsonFetch([]), stdout: stdout.stream });
    expect(exit).toBe(0);
    expect(stdout.text()).toContain("No paired devices");
  });
});

describe("clankie devices revoke", () => {
  it("revokes a device by id", async () => {
    const stdout = outputBuffer();
    const exit = await runDevices(["revoke", "device-abc123"], {
      fetchImpl: jsonFetch(
        device({ status: "revoked", revokedBy: "operator-james", revokedAt: "2026-07-13T12:05:00.000Z" }),
      ),
      stdout: stdout.stream,
    });
    expect(exit).toBe(0);
    expect(stdout.text()).toContain("Revoked device-abc123");
  });

  it("requires a device id", async () => {
    const stderr = outputBuffer();
    const exit = await runDevices(["revoke"], {
      fetchImpl: throwingFetch(new Error("must not be called")),
      stderr: stderr.stream,
    });
    expect(exit).toBe(1);
    expect(stderr.text()).toContain("Usage: clankie devices");
  });

  it("maps a 404 to not_found", async () => {
    const stdout = outputBuffer();
    const exit = await runDevices(["revoke", "device-missing", "--json"], {
      fetchImpl: jsonFetch({ error: "device_not_found" }, { status: 404 }),
      stdout: stdout.stream,
    });
    expect(exit).toBe(1);
    const parsed = JSON.parse(stdout.text());
    expect(parsed.status).toBe("not_found");
  });
});

describe("clankie devices — fail closed", () => {
  it("fails without contacting the service when no operator token is set", async () => {
    const calls = { count: 0 };
    const stderr = outputBuffer();
    const exit = await runDevices([], {
      env: {},
      operatorCredentialStore: new MemoryCredentialStore(),
      fetchImpl: throwingFetch(new Error("must not be called"), calls),
      stderr: stderr.stream,
    });
    expect(exit).toBe(1);
    expect(calls.count).toBe(0);
    expect(stderr.text()).toContain("Operator credential unavailable");
  });

  it.each([
    ["transport failure", throwingFetch(new Error("connect ECONNREFUSED 127.0.0.1:4310")), "unavailable"],
    [
      "unauthorized (401)",
      jsonFetch({ error: "operator_authentication_required" }, { status: 401 }),
      "unauthorized",
    ],
    ["service unavailable (503)", jsonFetch({ error: "unavailable" }, { status: 503 }), "unavailable"],
    ["malformed body", jsonFetch([{ deviceId: "" }]), "malformed"],
  ])("fails closed on %s with status %s", async (_label, fetchImpl, status) => {
    const stdout = outputBuffer();
    const exit = await runDevices(["--json"], { fetchImpl, stdout: stdout.stream });
    expect(exit).toBe(1);
    const parsed = JSON.parse(stdout.text());
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe(status);
  });

  it("never echoes a secret from a transport error", async () => {
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    const exit = await runDevices(["--json"], {
      fetchImpl: throwingFetch(new Error("ECONNREFUSED token=leaked-secret-xyz")),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    expect(exit).toBe(1);
    expect(`${stdout.text()}${stderr.text()}`).not.toContain("leaked-secret-xyz");
  });
});
