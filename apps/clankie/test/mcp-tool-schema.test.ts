import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { questionTools } from "../src/captain/question-tools.ts";
import { assertMcpToolsList, mcpToolSchemaError } from "../src/mcp-tool-schema.ts";

const tool = { name: "connected_example", inputSchema: { type: "object", properties: {} } };

describe("strict client contract", () => {
  it("accepts the real question tool schemas without changing them", () => {
    const result = {
      tools: questionTools({}).map((definition) => ({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.parameters,
      })),
    };
    const before = JSON.stringify(result);
    assertMcpToolsList(result, "operator");
    expect(JSON.stringify(result)).toBe(before);
  });

  // The first golden is the operator server incident in VUH-1651. The rest
  // exercise the actual SDK's typed fields rather than a root-only substitute.
  it.each([
    ["union root", { inputSchema: { anyOf: [{ type: "object" }, { type: "string" }] } }, "inputSchema.type"],
    ["array root", { inputSchema: { type: "array", items: { type: "string" } } }, "inputSchema.type"],
    ["nullable root", { inputSchema: { type: ["object", "null"] } }, "inputSchema.type"],
    ["boolean schema", { inputSchema: true }, "inputSchema"],
    [
      "property schema",
      { inputSchema: { type: "object", properties: { arg: true } } },
      "inputSchema.properties.arg",
    ],
    ["required names", { inputSchema: { type: "object", required: [1] } }, "inputSchema.required.0"],
    ["output root", { outputSchema: { type: "string" } }, "outputSchema.type"],
    ["description", { description: 5 }, "description"],
    ["annotation", { annotations: { readOnlyHint: "yes" } }, "annotations.readOnlyHint"],
    ["icon", { icons: [{ src: "data:image/png;base64,", sizes: [32] }] }, "icons.0.sizes.0"],
    ["execution", { execution: { taskSupport: "always" } }, "execution.taskSupport"],
    ["metadata", { _meta: [] }, "_meta"],
  ])("names the rejected tool and field for %s", (_label, fields, path) => {
    const rejected = { ...tool, ...fields };
    expect(ToolSchema.safeParse(rejected).success).toBe(false);
    expect(mcpToolSchemaError(rejected)).toContain(`MCP tool "connected_example" rejected: ${path}`);
    expect(() => assertMcpToolsList({ tools: [tool, rejected] }, "operator")).toThrow(
      /operator tools\/list failed strict client contract.*\nMCP tool "connected_example" rejected:/u,
    );
  });

  // Codex 0.160.0's serde JsonSchema accepts objects/boolean schemas for
  // children but rejects these shapes even though the MCP SDK accepts them.
  it.each([
    ["tuple items", { type: "array", items: [{ type: "string" }] }, "items"],
    ["nested property table", { type: "object", properties: [] }, "properties"],
    ["nested required", { type: "object", required: [false] }, "required.0"],
    ["composition", { anyOf: { type: "string" } }, "anyOf"],
    ["nested description", { type: "string", description: 1 }, "description"],
    ["enum", { type: "string", enum: "value" }, "enum"],
    ["item count", { type: "array", minItems: -1 }, "minItems"],
    ["reference", { $ref: 1 }, "$ref"],
  ])("catches Codex's additional schema rejection for %s", (_label, child, path) => {
    const rejected = { ...tool, inputSchema: { type: "object", properties: { arg: child } } };
    expect(ToolSchema.safeParse(rejected).success).toBe(true);
    expect(mcpToolSchemaError(rejected)).toContain(
      `rejected by Codex input schema: inputSchema.properties.arg.${path}`,
    );
  });

  it("accepts Codex compatibility forms and ignores unreachable definitions", () => {
    const compatible = {
      ...tool,
      inputSchema: {
        type: "object",
        properties: {
          nullable: { type: ["string", "null"] },
          composition: { anyOf: [true, { type: "string" }, { type: "null" }] },
          array: { type: "array" },
          object: { type: "object" },
          constant: { const: { properties: 7, items: [] } },
          reference: { $ref: "#/$defs/with~1slash" },
        },
        $defs: {
          "with/slash": { type: "object", properties: { value: { $ref: "#/definitions/text" } } },
          unused: { type: "array", items: [] },
        },
        definitions: { text: { type: "string" } },
      },
    };
    expect(mcpToolSchemaError(compatible)).toBeUndefined();
    expect(compatible.inputSchema.$defs.unused).toEqual({ type: "array", items: [] });
  });

  it("checks a reachable definition and names the tool", () => {
    const rejected = {
      ...tool,
      inputSchema: {
        type: "object",
        properties: { arg: { $ref: "#/$defs/tuple" } },
        $defs: { tuple: { type: "array", items: [] } },
      },
    };
    expect(mcpToolSchemaError(rejected)).toContain(
      'MCP tool "connected_example" rejected by Codex input schema: inputSchema.$defs.tuple.items',
    );
  });

  it("keeps URI-encoded and transitive definition references visible to Codex", () => {
    const rejected = {
      ...tool,
      inputSchema: {
        type: "object",
        properties: { arg: { $ref: "#/%24defs/with%20space" } },
        $defs: {
          "with space": { type: "object", $defs: { nested: { $ref: "#/definitions/" } } },
        },
        definitions: { "": { type: "array", items: [] } },
      },
    };
    expect(mcpToolSchemaError(rejected)).toContain(
      'MCP tool "connected_example" rejected by Codex input schema: inputSchema.definitions.items',
    );
  });

  it("checks the complete paginated tools/list result", () => {
    expect(() => assertMcpToolsList({ tools: [tool], nextCursor: 4 }, "fleet")).toThrow(
      "fleet tools/list failed strict client contract:\nnextCursor:",
    );
    expect(() => assertMcpToolsList({ tools: [{ inputSchema: { type: "object" } }] }, "fleet")).toThrow(
      'MCP tool "<unnamed>" rejected: name:',
    );
    expect(() => assertMcpToolsList({ tools: [tool], nextCursor: "next" }, "fleet")).not.toThrow();
  });
});
