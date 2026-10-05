import { workerReportTools, type WorkerReportActions } from "./worker-report-tools.ts";
import { questionTools } from "./question-tools.ts";
/**
 * A lane's tool bank, assembled once for every harness that runs it (VUH-1085).
 *
 * The pi session and a seat reached over MCP must never disagree about what a
 * lane may do, so both start here: `laneAuthoredTools` is what `buildSession`
 * hands pi as `customTools`, and `buildLaneToolBank` is the same list plus the
 * browser and connected-service catalogs pi registers
 * from extensions — flattened into callables. There is one registry; this file
 * projects it, and never restates a schema.
 */
import { runtimeUpdateTools } from "./update-tools.ts";
import type { CaptainSessionLaneV2, CaptainTurnMedia } from "@clankie/protocol";
import type { GameplaySettings } from "@clankie/settings";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { Type } from "typebox";
import type { AutonomyStore } from "./autonomy.ts";
import { connectionTools } from "./connect-tools.ts";
import type { CaptainDeps } from "./deps.ts";
import type { HerdrWatchPort } from "./herdr-watch.ts";
import type { LaneLog } from "./lane-log.ts";
import type { HireSeat, LaneTool, LaneToolBank, LaneToolResult, MessageSeat } from "./port.ts";
import { captainTools, callConversationBrowser, toolJson, type TurnContext } from "./tools.ts";

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
  hireSeat?: HireSeat,
  messageSeat?: MessageSeat,
  reports?: WorkerReportActions,
): ToolDefinition[] {
  return [
    ...(lane === "operator" && deps.safety
      ? [
          {
            name: "safety_status",
            label: "Owner safety settings",
            description:
              "Read the current owner safety settings. This cannot change rules or approve actions.",
            parameters: Type.Object({}),
            execute: async () => toolJson({ safety: await deps.safety!.status() }),
          } satisfies ToolDefinition,
        ]
      : []),
    ...((lane === "operator" || turn.shell === true) && reports ? workerReportTools(reports, turn) : []),
    ...runtimeUpdateTools(deps.runtimeUpdater, turn),
    ...(lane === "operator" ? questionTools(turn) : []),
    ...captainTools(deps, turn, laneLog, lane, gameplay, autonomy, herdrWatches, hireSeat, messageSeat),
    ...(lane === "operator" ? connectionTools(deps, lane) : []),
  ];
}

/**
 * Everything that lane reaches. Authored and browser tools are listed flat. A
 * connected service lists only its `initialTools`, the same narrowing
 * `mcpExtension` gives pi; the rest stay reachable through `mcp_tool_search` and
 * `mcp_tool_call`. A tracker's server alone advertises dozens of large schemas,
 * and a harness that lists them pays for every one on each request.
 */
export async function buildLaneToolBank(
  deps: CaptainDeps,
  turn: TurnContext,
  laneLog: LaneLog,
  lane: CaptainSessionLaneV2,
  gameplay?: GameplaySettings,
  autonomy?: AutonomyStore,
  herdrWatches?: HerdrWatchPort,
  hireSeat?: HireSeat,
  messageSeat?: MessageSeat,
  reports?: WorkerReportActions,
): Promise<LaneToolBank> {
  const tools: LaneTool[] = laneAuthoredTools(
    deps,
    turn,
    laneLog,
    lane,
    gameplay,
    autonomy,
    herdrWatches,
    hireSeat,
    messageSeat,
    reports,
  ).map((tool) => authoredLaneTool(tool, turn));
  const browser = await deps.browser.catalog();
  for (const tool of browser.available ? browser.tools : []) {
    if (tool.requiresShell && lane !== "operator" && turn.shell !== true) continue;
    tools.push(browserLaneTool(deps, turn, tool, lane === "operator" || turn.shell === true));
  }
  const services = (await deps.mcp.catalog(lane)).filter((tool) => tool.server !== "minecraft");
  for (const tool of services) if (tool.initial) tools.push(mcpLaneTool(deps, lane, tool, turn));
  if (services.some((tool) => !tool.initial))
    tools.push(...serviceDirectoryTools(deps, lane, services, turn));
  return { lane, tools };
}

/**
 * Named authored tools from a lane's own bank, callable outside a pi run: the
 * realtime voice reaches `recall_episodes`, `get_self_state` and
 * `remember_episode` through this, so they are the same tool code, schema
 * validation and lane visibility the captain uses, never a voice-only copy.
 */
export function laneAuthoredToolsNamed(
  deps: CaptainDeps,
  turn: TurnContext,
  laneLog: LaneLog,
  lane: CaptainSessionLaneV2,
  names: readonly string[],
): LaneTool[] {
  return laneAuthoredTools(deps, turn, laneLog, lane)
    .filter((tool) => names.includes(tool.name))
    .map((tool) => authoredLaneTool(tool, turn));
}

const MAX_SEARCH_RESULTS = 20;
const MAX_SCHEMA_NAMES = 10;

/**
 * The deferred half of a connected service: one tool to find a name and its
 * schema, one to call it. Search covers the whole catalog, listed ones included,
 * so a miss means the service really lacks it.
 */
function serviceDirectoryTools(
  deps: CaptainDeps,
  lane: CaptainSessionLaneV2,
  catalog: readonly McpToolDescriptor[],
  turn: TurnContext,
): LaneTool[] {
  const byName = new Map(catalog.map((tool) => [tool.qualifiedName, tool]));
  const servers = [...new Set(catalog.map((tool) => tool.server))].join(", ");
  return [
    {
      name: "mcp_tool_search",
      description:
        `Find tools on his connected services (${servers}) beyond the ones listed. ` +
        "Search with query for names and one-line summaries, then pass names for full input schemas. " +
        "Use this before saying a service cannot do something.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            maxLength: 200,
            description: "Words describing the task, e.g. 'project labels'.",
          },
          names: {
            type: "array",
            items: { type: "string", maxLength: 256 },
            maxItems: MAX_SCHEMA_NAMES,
            description: "Qualified tool names whose input schemas to return.",
          },
        },
        additionalProperties: false,
      },
      async call(args) {
        const names = Array.isArray(args.names) ? args.names.filter((name) => typeof name === "string") : [];
        if (names.length > 0) {
          const found = names.slice(0, MAX_SCHEMA_NAMES).flatMap((name) => {
            const tool = byName.get(name);
            return tool === undefined
              ? []
              : [
                  {
                    name,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                  },
                ];
          });
          const missing = names.filter((name) => !byName.has(name));
          return {
            content: toolJson({
              tools: found,
              ...(missing.length > 0 ? { missing } : {}),
            }).content,
          };
        }
        const query = typeof args.query === "string" ? args.query : "";
        return {
          content: toolJson({ tools: searchCatalog(catalog, query) }).content,
        };
      },
    },
    {
      name: "mcp_tool_call",
      description:
        "Call a connected-service tool by the qualified name mcp_tool_search returned, with arguments matching its input schema.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 256 },
          arguments: { type: "object" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      async call(args) {
        const tool = typeof args.name === "string" ? byName.get(args.name) : undefined;
        if (tool === undefined) {
          return {
            content: [
              {
                type: "text",
                text: `No connected tool named ${String(args.name)}. Search with mcp_tool_search.`,
              },
            ],
            isError: true,
          };
        }
        const input = args.arguments;
        const callArgs =
          input !== null && typeof input === "object" && !Array.isArray(input)
            ? (input as Record<string, unknown>)
            : {};
        return await mcpLaneTool(deps, lane, tool, turn).call(callArgs);
      },
    },
  ];
}

/** Ranked by how many query words a tool's name and description contain; an empty query lists them all. */
function searchCatalog(catalog: readonly McpToolDescriptor[], query: string) {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  return catalog
    .map((tool) => {
      const haystack = `${tool.qualifiedName} ${tool.description}`.toLowerCase();
      const name = tool.qualifiedName.toLowerCase();
      const score = terms.reduce(
        (total, term) => total + (name.includes(term) ? 2 : haystack.includes(term) ? 1 : 0),
        0,
      );
      return { tool, score };
    })
    .filter(({ score }) => terms.length === 0 || score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SEARCH_RESULTS)
    .map(({ tool }) => ({
      name: tool.qualifiedName,
      summary: summaryOf(tool.description),
    }));
}

function summaryOf(description: string): string {
  const line = description.trim().split("\n")[0] ?? "";
  const sentence = /^.*?[.!?](?:\s|$)/u.exec(line)?.[0]?.trim() ?? line;
  return sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence;
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
function browserLaneTool(
  deps: CaptainDeps,
  turn: TurnContext,
  tool: BrowserToolDescriptor,
  shell: boolean,
): LaneTool {
  return {
    name: `browser_${tool.name}`,
    description: tool.description,
    inputSchema: tool.inputSchema,
    async call(args) {
      const result = await callConversationBrowser(
        deps,
        { ...turn, shell },
        { schemaVersion: 1, tool: tool.name, arguments: args },
      );
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
function mcpLaneTool(
  deps: CaptainDeps,
  lane: CaptainSessionLaneV2,
  tool: McpToolDescriptor,
  turn: TurnContext,
): LaneTool {
  return {
    name: tool.qualifiedName,
    description: tool.description,
    inputSchema: tool.inputSchema,
    async call(args) {
      const result = await deps.mcp.call({
        lane,
        server: tool.server,
        tool: tool.name,
        arguments: args,
        ...(turn.conversationAuthority ? { conversationAuthority: turn.conversationAuthority } : {}),
      });
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
