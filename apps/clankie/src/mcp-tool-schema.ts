import { ListToolsResultSchema, ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/**
 * Claude Code 2.1.289 embeds this SDK ToolSchema/ListToolsResultSchema contract.
 * Codex 0.160.0 uses rmcp 3.2.0: its wire Tool fields are a subset of that
 * contract, including object-valued input/output schemas and typed metadata.
 * https://github.com/modelcontextprotocol/rust-sdk/blob/rmcp-v3.2.0/crates/rmcp/src/model/tool.rs
 *
 * Codex also deserializes input schemas into its own recursive schema type.
 * Check that shape after its documented compatibility normalization, without
 * changing the tool we serve. This catches, for example, tuple-valued items
 * that the SDK's shallow properties check accepts but Codex cannot deserialize.
 * https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/tools/src/json_schema.rs
 * https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/tools/src/json_schema/types.rs
 * Output schemas are kept as raw JSON by Codex, so use the SDK contract there.
 * https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/tools/src/mcp_tool.rs
 */
const primitiveTypes = z.enum(["string", "number", "boolean", "integer", "object", "array", "null"]);
const codexInputSchema: z.ZodType = z.lazy(() =>
  z.object({
    $ref: z.string().nullish(),
    type: z.union([primitiveTypes, z.array(primitiveTypes)]).nullish(),
    description: z.string().nullish(),
    encrypted: z.boolean().nullish(),
    enum: z.array(z.unknown()).nullish(),
    items: codexInputSchema.nullish(),
    minItems: z.number().int().nonnegative().nullish(),
    properties: z.record(z.string(), codexInputSchema).nullish(),
    required: z.array(z.string()).nullish(),
    additionalProperties: z.union([z.boolean(), codexInputSchema]).nullish(),
    anyOf: z.array(codexInputSchema).nullish(),
    oneOf: z.array(codexInputSchema).nullish(),
    allOf: z.array(codexInputSchema).nullish(),
    $defs: z.record(z.string(), codexInputSchema).nullish(),
    definitions: z.record(z.string(), codexInputSchema).nullish(),
  }),
);

const compositions = ["anyOf", "oneOf", "allOf"];
const definitionTables = ["$defs", "definitions"];
const schemaChildren = ["items", "prefixItems", ...compositions];
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function normalizeCodexSchema(value: unknown): unknown {
  if (typeof value === "boolean") return { type: "string" };
  if (Array.isArray(value)) return value.map(normalizeCodexSchema);
  if (!isObject(value)) return value;
  const result = { ...value };
  if (isObject(result.properties)) {
    result.properties = Object.fromEntries(
      Object.entries(result.properties).map(([key, child]) => [key, normalizeCodexSchema(child)]),
    );
  }
  for (const key of schemaChildren) {
    if (key in result) result[key] = normalizeCodexSchema(result[key]);
  }
  if ("additionalProperties" in result && typeof result.additionalProperties !== "boolean") {
    result.additionalProperties = normalizeCodexSchema(result.additionalProperties);
  }
  for (const key of definitionTables) {
    if (isObject(result[key])) {
      result[key] = Object.fromEntries(
        Object.entries(result[key]).map(([name, child]) => [name, normalizeCodexSchema(child)]),
      );
    } else delete result[key];
  }
  if ("const" in result) {
    result.enum = [result.const];
    delete result.const;
  }
  let types = (Array.isArray(result.type) ? result.type : [result.type]).filter(
    (type): type is string => primitiveTypes.safeParse(type).success,
  );
  if (types.length === 0) {
    if ("$ref" in result || compositions.some((key) => key in result)) return result;
    if (["properties", "required", "additionalProperties"].some((key) => key in result)) types = ["object"];
    else if (["items", "prefixItems"].some((key) => key in result)) types = ["array"];
    else if (["enum", "format"].some((key) => key in result)) types = ["string"];
    else if (
      ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"].some(
        (key) => key in result,
      )
    )
      types = ["number"];
    else return {};
  }
  result.type = types.length === 1 ? types[0] : types;
  if (types.includes("object") && !("properties" in result)) result.properties = {};
  if (types.includes("array") && !("items" in result)) result.items = { type: "string" };
  return result;
}

// Codex prunes unreachable root definitions before deserializing. An invalid
// unused definition therefore must not hide an otherwise usable connected tool.
function pruneCodexDefinitions(root: Record<string, unknown>): void {
  const reachable = new Set<string>();
  const scan = (value: unknown, includeDefinitions = false): void => {
    if (Array.isArray(value)) {
      for (const child of value) scan(child, includeDefinitions);
      return;
    }
    if (!isObject(value)) return;
    if (typeof value.$ref === "string") {
      let fragment = "";
      try {
        if (value.$ref.startsWith("#")) fragment = decodeURIComponent(value.$ref.slice(1));
      } catch {
        // Invalid URI fragments cannot keep a local definition reachable.
      }
      const match = /~(?:[^01]|$)/u.test(fragment)
        ? null
        : /^\/(\$defs|definitions)\/([^/]*)/u.exec(fragment);
      if (match) {
        const table = match[1]!;
        const name = match[2]!.replaceAll("~1", "/").replaceAll("~0", "~");
        const pointer = JSON.stringify([table, name]);
        if (!reachable.has(pointer)) {
          reachable.add(pointer);
          const definitions = root[table];
          if (isObject(definitions)) scan(definitions[name], true);
        }
      }
    }
    if (isObject(value.properties)) {
      for (const child of Object.values(value.properties)) scan(child, includeDefinitions);
    }
    for (const key of ["items", ...compositions, "additionalProperties"])
      scan(value[key], includeDefinitions);
    if (includeDefinitions) {
      for (const table of definitionTables) {
        if (isObject(value[table])) {
          for (const child of Object.values(value[table])) scan(child, true);
        }
      }
    }
  };
  scan(root);
  for (const table of definitionTables) {
    const definitions = root[table];
    if (!isObject(definitions)) continue;
    const kept = Object.fromEntries(
      Object.entries(definitions).filter(([name]) => reachable.has(JSON.stringify([table, name]))),
    );
    if (Object.keys(kept).length) root[table] = kept;
    else delete root[table];
  }
}

function issues(error: z.ZodError, prefix = ""): string {
  return error.issues
    .map(
      (issue) =>
        `${[prefix, ...issue.path.map(String)].filter(Boolean).join(".") || "tool"}: ${issue.message}`,
    )
    .join("; ");
}

/** Undefined means the original tool can be served unchanged. */
export function mcpToolSchemaError(tool: unknown): string | undefined {
  const name = isObject(tool) && typeof tool.name === "string" ? tool.name : "<unnamed>";
  const parsed = ToolSchema.safeParse(tool);
  if (!parsed.success) return `MCP tool ${JSON.stringify(name)} rejected: ${issues(parsed.error)}`;
  const normalized = normalizeCodexSchema(parsed.data.inputSchema);
  if (isObject(normalized)) pruneCodexDefinitions(normalized);
  const codex = codexInputSchema.safeParse(normalized);
  if (!codex.success) {
    return `MCP tool ${JSON.stringify(name)} rejected by Codex input schema: ${issues(codex.error, "inputSchema")}`;
  }
  return undefined;
}

/** Validate the complete wire result and name each offending tool in failures. */
export function assertMcpToolsList(result: unknown, source: string): void {
  const errors =
    isObject(result) && Array.isArray(result.tools)
      ? result.tools.flatMap((tool) => {
          const error = mcpToolSchemaError(tool);
          return error ? [error] : [];
        })
      : [];
  const parsed = ListToolsResultSchema.safeParse(result);
  if (!parsed.success && errors.length === 0) errors.push(issues(parsed.error));
  if (errors.length)
    throw new Error(`${source} tools/list failed strict client contract:\n${errors.join("\n")}`);
}
