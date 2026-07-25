/**
 * Drive the server the way a coding harness does: over stdio, through the real
 * MCP client. A unit test proves the schema; only this proves the tools are
 * usable by something that was not written alongside them.
 *
 * `pnpm --filter @clankie/gba-mcp probe`
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "pnpm",
  args: ["--filter", "@clankie/gba-mcp", "start"],
  env: { ...process.env } as Record<string, string>,
  stderr: "ignore",
});
const client = new Client({ name: "clankie-gba-probe", version: "0.1.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log(`tools: ${tools.tools.map((tool) => tool.name).join(", ")}`);

const look = await client.callTool({ name: "gba_emulator_observe", arguments: {} });
const content = look.content as { type: string; text?: string }[];
console.log(`observe returned: ${content.map((part) => part.type).join(" + ")}`);
const state = content.find((part) => part.type === "text")?.text ?? "";
console.log(`state: ${state.replace(/\s+/gu, " ").slice(0, 140)}`);

const step = await client.callTool({
  name: "gba_emulator_start_action",
  arguments: { actionKind: "button_press", button: "left", holdFrames: 16 },
});
console.log(`act: ${step.isError === true ? `ERROR ${describe(step)}` : "accepted"}`);

// A recorded refusal matters as much as a success: fail-closed is the part most
// likely to be quietly broken.
const refused = await client.callTool({
  name: "gba_emulator_start_action",
  arguments: { actionKind: "button_press", button: "turbo", holdFrames: 16 },
});
console.log(
  `refusal: ${refused.isError === true ? describe(refused).slice(0, 90) : "NOT REFUSED — fail-closed is broken"}`,
);

// A second refusal, past protocol validation: `frames` has no bound in the tool
// schema but the emulator catalogue caps it, so this exercises the adapter's
// fail-closed path rather than the SDK's argument check.
const refusedByEmulator = await client.callTool({
  name: "gba_emulator_start_action",
  arguments: { actionKind: "frame_advance", frames: 999_999 },
});
console.log(
  `emulator refusal: ${
    refusedByEmulator.isError === true
      ? describe(refusedByEmulator).slice(0, 90)
      : "NOT REFUSED — the catalogue bound is not enforced"
  }`,
);

await client.close();

function describe(result: unknown): string {
  const parts = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return parts.find((part) => part.type === "text")?.text ?? "";
}
