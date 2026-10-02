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
});
