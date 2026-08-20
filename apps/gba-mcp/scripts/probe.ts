import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GBA_MCP_TOOL_NAMES } from "../src/server.ts";

const env = getDefaultEnvironment();
for (const name of [
  "GBA_MCP_ROM_PATH",
  "GBA_MCP_SAVESTATE_PATH",
  "GBA_MCP_SCENARIO_PATH",
  "GBA_MCP_CHECKPOINT_DIR",
  "GBA_MCP_HARNESS_ID",
]) {
  const value = process.env[name];
  if (value !== undefined) env[name] = value;
}
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "src/index.ts"],
  env,
  stderr: "ignore",
});
const client = new Client({ name: "gba-emulator-harness-probe", version: "0.1.0" });
await client.connect(transport);

const tools = (await client.listTools()).tools;
const names = tools.map((tool) => tool.name);
if (JSON.stringify(names) !== JSON.stringify(GBA_MCP_TOOL_NAMES)) {
  throw new Error(`unexpected tool catalog: ${names.join(", ")}`);
}
console.log(`tools: ${names.join(", ")}`);

const look = await client.callTool({ name: "gba_emulator_observe", arguments: {} });
const lookContent = look.content as { type: string }[];
console.log(`observe returned: ${lookContent.map((part) => part.type).join(" + ")}`);

const step = await client.callTool({
  name: "gba_emulator_start_action",
  arguments: { action: { kind: "button_press", button: "left", holdFrames: 16 } },
});
console.log(
  `act: ${String((step.structuredContent as Record<string, unknown> | undefined)?.["status"] ?? "missing result")}`,
);

const refused = await client.callTool({
  name: "gba_emulator_start_action",
  arguments: { action: { kind: "button_press", button: "turbo", holdFrames: 16 } },
});
console.log(`schema refusal: ${refused.isError === true ? "refused" : "NOT REFUSED"}`);

const bounded = await client.callTool({
  name: "gba_emulator_start_action",
  arguments: { action: { kind: "frame_advance", frames: 2_000 } },
});
console.log(
  `runtime refusal: ${String(
    (bounded.structuredContent as Record<string, unknown> | undefined)?.["status"] ?? "missing result",
  )}`,
);

await client.close();
