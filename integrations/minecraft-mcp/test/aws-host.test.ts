import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "@clankie/credential-broker";
import { AwsEc2Host } from "../src/aws-host.ts";
import { encryptGuestResponse } from "../src/aws-guest.ts";

const accountId = "111111111111";
const instanceId = "i-0123456789abcdef0";
const credentials: CredentialStore = {
  get: vi.fn().mockResolvedValue(undefined),
  set: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(true),
  list: vi.fn().mockResolvedValue({}),
};
const cleanup: AwsEc2Host[] = [];
afterEach(async () => {
  for (const host of cleanup.splice(0)) await host.stop().catch(() => {});
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
function fixture(
  options: {
    owner?: string;
    guestFailure?: boolean;
    tamper?: boolean;
    closeFailure?: boolean;
    launchTime?: string;
    stopUnconfirmed?: boolean;
  } = {},
) {
  let state = "stopped";
  let output = "";
  const forwardExits: (() => void)[] = [];
  const close = vi.fn(async () => {
    if (options.closeFailure) throw new Error("close failed");
  });
  const call = vi.fn(async (service: string, operation: string, input: Record<string, unknown>) => {
    if (service === "ec2") {
      if (operation === "start-instances") {
        state = "running";
        return {};
      }
      if (operation === "stop-instances") {
        state = options.stopUnconfirmed ? "stopping" : "stopped";
        return {};
      }
      if (operation === "describe-instances")
        return {
          Reservations: [
            {
              OwnerId: options.owner ?? accountId,
              Instances: [
                {
                  InstanceId: instanceId,
                  State: { Name: state },
                  LaunchTime: options.launchTime ?? new Date().toISOString(),
                  PublicIpAddress: "203.0.113.10",
                },
              ],
            },
          ],
        };
    }
    if (operation === "send-command") {
      const parameters = input.Parameters as { Request: string[] };
      const request = JSON.parse(Buffer.from(parameters.Request[0]!, "base64").toString());
      if (options.guestFailure && request.action === "stop") throw new Error("backup failed");
      const value =
        request.action === "start"
          ? { phase: "running", authReady: true }
          : request.action === "botLogin"
            ? "private-login-secret"
            : {};
      const envelope = JSON.parse(encryptGuestResponse(request.publicKey, { result: value }));
      if (options.tamper) {
        const data = Buffer.from(envelope.data, "base64");
        data[0] = data[0]! ^ 1;
        envelope.data = data.toString("base64");
      }
      output = JSON.stringify(envelope);
      return { Command: { CommandId: "command-1" } };
    }
    if (operation === "get-command-invocation") return { Status: "Success", StandardOutputContent: output };
    throw new Error(`Unexpected ${service} ${operation}`);
  });
  const host = new AwsEc2Host({
    instanceId,
    accountId,
    region: "us-east-1",
    credentials,
    call,
    forward: async (onUnavailable) => {
      forwardExits.push(onUnavailable);
      return close;
    },
    pollMs: 1,
    timeoutMs: 50,
  });
  cleanup.push(host);
  return { host, call, close, forwardExits, state: () => state };
}
describe("AWS host guardrails", () => {
  it("status refresh never starts a stopped instance", async () => {
    const { host, call } = fixture();
    expect((await host.refresh()).phase).toBe("stopped");
    expect(call.mock.calls.every(([, operation]) => operation === "describe-instances")).toBe(true);
  });
  it("refuses every lifecycle mutation when instance ownership differs", async () => {
    const { host, call } = fixture({ owner: "222222222222" });
    await expect(host.start()).rejects.toThrow();
    await expect(host.stop()).rejects.toThrow();
    expect(call.mock.calls.filter(([, op]) => op === "start-instances" || op === "stop-instances")).toEqual(
      [],
    );
  });
  it("stops EC2 even when guest backup fails", async () => {
    const { host, state } = fixture({ guestFailure: true });
    await host.start();
    expect((await host.stop()).phase).toBe("stopped");
    expect(state()).toBe("stopped");
    expect(host.status().failure).toBe("guest_backup_unconfirmed");
  });
  it("stops EC2 even when forwarding cleanup fails", async () => {
    const { host, state } = fixture({ closeFailure: true });
    await host.start();
    await host.stop().catch(() => {});
    expect(state()).toBe("stopped");
  });
  it("rejects modified encrypted replies and stops the instance", async () => {
    const { host, state } = fixture({ tamper: true });
    await expect(host.start()).rejects.toThrow();
    expect(state()).toBe("stopped");
    expect(host.status().authReady).toBe(false);
  });
  it("keeps broker login on the exact forwarded endpoint and outside status/SSM inputs", async () => {
    const { host, call } = fixture();
    const status = await host.start();
    expect(status.publicAddress).toBe("203.0.113.10:25565");
    expect(await host.botLogin({ ...status.gameEndpoint, host: "203.0.113.10" })).toBeNull();
    expect(await host.botLogin(status.gameEndpoint)).toBe("private-login-secret");
    expect(JSON.stringify(host.status())).not.toContain("private-login-secret");
    expect(JSON.stringify(call.mock.calls)).not.toContain("private-login-secret");
  });
  it("decrypts the guest helper response once and caches login only while ready", async () => {
    const { host, call } = fixture();
    const status = await host.start();
    const startupCalls = call.mock.calls.length;
    expect(await host.botLogin(status.gameEndpoint)).toBe("private-login-secret");
    expect(await host.botLogin(status.gameEndpoint)).toBe("private-login-secret");
    expect(call.mock.calls.length).toBe(startupCalls);
    await host.stop();
    const stoppedCalls = call.mock.calls.length;
    expect(await host.botLogin(status.gameEndpoint)).toBeNull();
    expect(call.mock.calls.length).toBe(stoppedCalls);
  });
  it("reopens lost forwarding and fences late exits from the previous generation", async () => {
    const { host, forwardExits } = fixture();
    const initial = await host.start();
    await host.start();
    expect(forwardExits).toHaveLength(1);
    const firstExit = forwardExits[0]!;
    firstExit();
    expect(host.status().authReady).toBe(false);
    expect(await host.botLogin(initial.gameEndpoint)).toBeNull();

    const reopened = await host.start();
    expect(forwardExits).toHaveLength(2);
    expect(reopened.authReady).toBe(true);
    expect(await host.botLogin(reopened.gameEndpoint)).toBe("private-login-secret");
    firstExit();
    expect(host.status().authReady).toBe(true);
    expect(await host.botLogin(reopened.gameEndpoint)).toBe("private-login-secret");
    forwardExits[1]!();
    expect(host.status().authReady).toBe(false);
    expect(await host.botLogin(reopened.gameEndpoint)).toBeNull();
  });
  it("refuses an expired instance run before admitting the guest", async () => {
    const { host, call, state } = fixture({ launchTime: new Date(0).toISOString() });
    await expect(host.start()).rejects.toThrow();
    expect(state()).toBe("stopped");
    const starts = call.mock.calls.filter(
      ([, op, input]) =>
        op === "send-command" &&
        JSON.parse(Buffer.from((input.Parameters as { Request: string[] }).Request[0]!, "base64").toString())
          .action === "start",
    );
    expect(starts).toEqual([]);
  });
  it("does not claim stopped when EC2 never confirms the stop", async () => {
    const { host } = fixture({ stopUnconfirmed: true });
    await host.start();
    await expect(host.stop()).rejects.toThrow("deadline");
    expect(host.status().phase).not.toBe("stopped");
    expect(host.status().authReady).toBe(false);
  });
  it("refuses missing broker credentials despite an operator profile in the environment", async () => {
    vi.stubEnv("AWS_PROFILE", "operator-admin");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIA" + "A".repeat(16));
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "operator-secret-must-not-be-used");
    const host = new AwsEc2Host({ instanceId, accountId, region: "us-east-1", credentials });
    await expect(host.refresh()).rejects.toThrow("broker credential missing");
    expect(credentials.get).toHaveBeenCalledWith("clankie_minecraft_aws");
    expect(host.status().phase).toBe("stopped");
  });
  it("rejects arbitrary console commands before remote dispatch", async () => {
    const { host, call } = fixture();
    await expect(host.admin({ operation: "op", username: "Friend" })).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });
});
