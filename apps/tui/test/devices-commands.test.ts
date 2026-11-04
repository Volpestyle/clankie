import { describe, expect, it } from "vitest";
import { buildDevicesCommands } from "../src/devices-commands.ts";
import type { ClankieFaceShell } from "../src/shell/shell.ts";

async function run(fetchImpl: typeof fetch, argument = "") {
  const results: Array<{ text: string; tone: string | undefined }> = [];
  const shell = {
    insertCommandResult: (_command: string, text: string, tone?: string) => results.push({ text, tone }),
  } as unknown as ClankieFaceShell;
  const [command] = buildDevicesCommands({
    env: { CLANKIE_OPERATOR_TOKEN: "operator-secret" },
    host: "http://127.0.0.1:4310",
    fetchImpl,
  });
  await command!.run(argument, shell);
  return results;
}

describe("/devices", () => {
  it("opens an empty list on the next step instead of a bare none", async () => {
    const results = await run((async () => Response.json([])) as typeof fetch);
    expect(results[0]?.text).toContain("No paired devices");
    expect(results[0]?.text).toContain("/pair");
    expect(results[0]?.tone).toBe("success");
  });

  it("reports a service failure as an error result", async () => {
    const results = await run((async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch);
    expect(results[0]?.tone).toBe("error");
  });

  it("shows a device named before names were checked cleanly, and still acts on its id", async () => {
    const device = {
      deviceId: "device-legacy",
      name: "Cla\u202Eu\u200Bde",
      platform: "unknown",
      status: "active",
      grants: { chat: true, steer: true, terminalObserve: true, terminalControl: false },
      createdAt: "2026-11-01T00:00:00.000Z",
    };
    const requests: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
      return Response.json(init?.method === "POST" ? { ...device, status: "revoked" } : [device]);
    }) as typeof fetch;
    const seen: unknown[] = [];
    const lines: string[] = [];
    const answers = ["device-legacy", "yes", undefined];
    const shell = {
      insertCommandResult: () => {},
      setupFlow: {
        begin: () => {},
        end: () => {},
        readSelect: async (select: unknown) => {
          seen.push(select);
          return answers.shift();
        },
        renderLine: (line: string) => void lines.push(line),
      },
    } as unknown as ClankieFaceShell;
    const [command] = buildDevicesCommands({
      env: { CLANKIE_OPERATOR_TOKEN: "operator-secret" },
      host: "http://127.0.0.1:4310",
      fetchImpl,
    });
    await command!.run("", shell);
    expect(seen[0]).toMatchObject({ options: [{ value: "device-legacy", label: "Claude" }] });
    expect(seen[1]).toMatchObject({ message: "Revoke Claude?" });
    expect(lines).toEqual(["Revoked Claude."]);
    expect(requests.join(" ")).toContain("device-legacy");
  });
});
