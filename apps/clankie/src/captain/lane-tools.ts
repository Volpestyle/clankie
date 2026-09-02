/**
 * A lane's tool bank, assembled once for every harness that runs it (VUH-1085).
 *
 * The pi session and a seat reached over MCP must never disagree about what a
 * lane may do, so both start here: `laneAuthoredTools` is what `buildSession`
 * hands pi as `customTools`, and `buildLaneToolBank` is the same list plus the
 * browser and connected-service catalogs — the two pi otherwise registers from
 * extensions — flattened into callables. There is one registry; this file
 * projects it, and never restates a schema.
 */
import type { CaptainSessionLaneV2, CaptainTurnMedia } from "@clankie/protocol";
import type { GameplaySettings } from "@clankie/settings";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import type { AutonomyStore } from "./autonomy.ts";
import { connectionTools } from "./connect-tools.ts";
import type { CaptainDeps } from "./deps.ts";
import type { HerdrWatchPort } from "./herdr-watch.ts";
import type { LaneLog } from "./lane-log.ts";
import type { LaneTool, LaneToolBank, LaneToolResult } from "./port.ts";
import { captainTools, toolJson, type TurnContext } from "./tools.ts";

type McpToolDescriptor = Awaited<ReturnType<CaptainDeps["mcp"]["catalog"]>>[number];
type BrowserToolDescriptor = Awaited<ReturnType<CaptainDeps["browser"]["catalog"]>>["tools"][number];

/**
 * The authored bank for a lane. Mail is listed only where it works: it refuses
 * outside the operator lane at call time, and a tool list that advertises a
 * refusal is not an authority plan.
 */
export function laneAuthoredTools(
  deps: CaptainDeps,
  turn: TurnContext,
  laneLog: LaneLog,
  lane: CaptainSessionLaneV2,
  gameplay?: GameplaySettings,
  autonomy?: AutonomyStore,
  herdrWatches?: HerdrWatchPort,
): ToolDefinition[] {
  return [
    ...captainTools(deps, turn, laneLog, lane, gameplay, autonomy, herdrWatches),
    ...(lane === "operator" ? connectionTools(deps, lane) : []),
  ];
}

/**
 * Everything that lane reaches, as one flat list. The browser and MCP tools are
 * the same registrations `browserExtension` and `mcpExtension` make, minus their
 * `*_tool_search` helpers: a harness with its own search over a full tool list
 * does not need pi's narrowing, which exists to keep a prompt small.
 */
export async function buildLaneToolBank(
  deps: CaptainDeps,
  turn: TurnContext,
  laneLog: LaneLog,
  lane: CaptainSessionLaneV2,
  gameplay?: GameplaySettings,
  autonomy?: AutonomyStore,
  herdrWatches?: HerdrWatchPort,
): Promise<LaneToolBank> {
  const tools: LaneTool[] = laneAuthoredTools(
    deps,
    turn,
    laneLog,
    lane,
    gameplay,
    autonomy,
    herdrWatches,
  ).map((tool) => authoredLaneTool(tool, turn));
  const browser = await deps.browser.catalog();
  for (const tool of browser.available ? browser.tools : []) {
    tools.push(browserLaneTool(deps, turn, tool));
  }
  for (const tool of await deps.mcp.catalog(lane)) tools.push(mcpLaneTool(deps, lane, tool));
  return { lane, tools };
}

/**
 * A pi tool as a callable. Arguments are validated against the same TypeBox
 * schema pi validates against, because a harness that sends the wrong shape
 * should be told so rather than have the tool throw from inside.
 */
function authoredLaneTool(tool: ToolDefinition, turn: TurnContext): LaneTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as Record<string, unknown>,
    async call(args) {
      const invalid = schemaViolation(tool.parameters, args);
      if (invalid !== undefined) return { content: [{ type: "text", text: invalid }], isError: true };
      const before = turn.media;
      try {
        // Custom tools take (id, params); the signal, update callback, and
        // extension context pi passes belong to a pi run, and none of the
        // captain's authored tools read them.
        const result = await (
          tool.execute as unknown as (
            id: string,
            params: unknown,
          ) => Promise<{
            content: readonly unknown[];
          }>
        )(`lane-${tool.name}`, args);
        return withMedia(toolContent(result.content), turn.media === before ? undefined : turn.media);
      } catch (error) {
        return { content: [{ type: "text", text: errorText(error) }], isError: true };
      }
    },
  };
}

/** Browser tools carry artifacts the same way `browserExtension` does. */
function browserLaneTool(deps: CaptainDeps, turn: TurnContext, tool: BrowserToolDescriptor): LaneTool {
  return {
    name: `browser_${tool.name}`,
    description: tool.description,
    inputSchema: tool.inputSchema,
    async call(args) {
      const result = await deps.browser.call({ schemaVersion: 1, tool: tool.name, arguments: args });
      if (result.outcome === "ok" && result.isError) {
        return { content: [{ type: "text", text: result.content }], isError: true };
      }
      let media: CaptainTurnMedia | undefined;
      if (result.outcome === "ok" && result.artifacts.length > 0) {
        const artifact = result.artifacts.at(-1);
        if (artifact !== undefined) {
          media = { artifactRef: artifact.artifactRef, filename: artifact.filename };
          turn.media = media;
        }
      }
      return withMedia(toolJson(result).content, media);
    },
  };
}

/** A connected service's tool, named as the captain registers it: `<server>_<tool>`. */
function mcpLaneTool(deps: CaptainDeps, lane: CaptainSessionLaneV2, tool: McpToolDescriptor): LaneTool {
  return {
    name: tool.qualifiedName,
    description: tool.description,
    inputSchema: tool.inputSchema,
    async call(args) {
      const result = await deps.mcp.call({ lane, server: tool.server, tool: tool.name, arguments: args });
      if (result.outcome === "ok" && result.isError) {
        return {
          content: [{ type: "text", text: result.content || `${tool.qualifiedName} failed` }],
          isError: true,
        };
      }
      return { content: toolJson(result).content };
    },
  };
}

/**
 * The note a harness needs to know a picture is riding the reply. Nothing about
 * media reaches a model as bytes — the reference is what travels, and the room
 * decides whether it can show it at all (ADR 0085).
 */
function withMedia(content: LaneToolResult["content"], media: CaptainTurnMedia | undefined): LaneToolResult {
  if (media === undefined) return { content };
  return {
    content: [
      ...content,
      {
        type: "text",
        text: `Attached media: ${media.filename} (artifactRef ${media.artifactRef}) — it rides the reply in rooms that show pictures.`,
      },
    ],
    media,
  };
}

function toolContent(content: readonly unknown[]): LaneToolResult["content"] {
  const blocks: LaneToolResult["content"][number][] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const typed = block as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") {
      blocks.push({ type: "text", text: typed.text });
    } else if (
      typed.type === "image" &&
      typeof typed.data === "string" &&
      typeof typed.mimeType === "string"
    ) {
      blocks.push({ type: "image", data: typed.data, mimeType: typed.mimeType });
    }
  }
  return blocks;
}

/** The first schema violation in caller-readable words, or undefined if the arguments fit. */
function schemaViolation(schema: TSchema, args: Record<string, unknown>): string | undefined {
  if (Value.Check(schema, args)) return undefined;
  const first = Value.Errors(schema, args)[0];
  if (first === undefined) return "The arguments do not match this tool's schema.";
  const at = first.instancePath.length === 0 ? "arguments" : first.instancePath;
  return `Invalid arguments: ${at} ${first.message}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
