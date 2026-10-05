import { z } from "zod";

// ---------------------------------------------------------------------------
// Clankie's browser (ADR 0082).
//
// The captain drives a service-owned Browser Use Pi session. The host stamps
// risk and whether an operator must approve the call onto each descriptor, so
// `requiresApproval` is a decided fact on the wire rather than something the
// captain or the model re-derives.
// ---------------------------------------------------------------------------

export const BrowserToolNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/u, "Browser tool names are alphanumerics with underscores or dashes");

export const BrowserToolDescriptorSchema = z.object({
  name: BrowserToolNameSchema,
  description: z.string().max(4_000),
  /** JSON Schema for the tool's arguments. */
  inputSchema: z.record(z.string(), z.unknown()),
  /** Native Node execution is offered only to machine-authorized turns. */
  requiresShell: z.boolean().optional(),
  riskClass: z.enum(["read", "reversible-write", "irreversible-write", "publish-external", "destructive"]),
  /** The host marked this call as needing an operator approval. */
  requiresApproval: z.boolean(),
});
export type BrowserToolDescriptor = z.infer<typeof BrowserToolDescriptorSchema>;

export const BrowserToolCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  /** `false` means the host could not be reached — never that no tools exist. */
  available: z.boolean(),
  reason: z.string().max(200).optional(),
  tools: z.array(BrowserToolDescriptorSchema).max(256),
});
export type BrowserToolCatalog = z.infer<typeof BrowserToolCatalogSchema>;

export const CallBrowserToolRequestSchema = z.object({
  schemaVersion: z.literal(1),
  tool: BrowserToolNameSchema,
  arguments: z.record(z.string(), z.unknown()).default({}),
});
export type CallBrowserToolRequest = z.infer<typeof CallBrowserToolRequestSchema>;

/**
 * A non-text result the browser produced, parked as service-private bytes.
 *
 * Screenshots come back as base64 image blocks, and base64 pixels are the one
 * thing that must never enter a captain turn: a single screenshot is tens of
 * kilobytes of tokens that say nothing a model can read. The bytes are written
 * where the Discord attachment resolver can already find them and only the
 * hash-bound reference travels, which is the same shape every other artifact
 * in this system uses.
 */
export const BrowserArtifactSchema = z.object({
  /** `sha256:<hex>:<path-relative-to-the-attachment-root>`, as the resolver expects. */
  artifactRef: z.string().regex(/^sha256:[0-9a-f]{64}:.+$/u),
  filename: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(100),
  byteLength: z.number().int().nonnegative(),
});
export type BrowserArtifact = z.infer<typeof BrowserArtifactSchema>;

export const CallBrowserToolResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("ok"),
    tool: BrowserToolNameSchema,
    /** Text blocks from the MCP result, already bounded by the host. */
    content: z.string().max(200_000),
    isError: z.boolean().default(false),
    /** Images and other bytes the call produced; empty for most tools. */
    artifacts: z.array(BrowserArtifactSchema).max(8).default([]),
  }),
  z.object({
    outcome: z.literal("refused"),
    tool: BrowserToolNameSchema,
    // `doctrine_denied` is a frozen unused code from the retired policy engine.
    reason: z.enum(["doctrine_denied", "approval_required", "unknown_tool", "browser_unavailable"]),
    detail: z.string().max(500).optional(),
  }),
]);
export type CallBrowserToolResult = z.infer<typeof CallBrowserToolResultSchema>;
