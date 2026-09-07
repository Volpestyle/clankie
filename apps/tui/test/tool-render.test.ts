import { describe, expect, it } from "vitest";
import {
  genericToolRenderer,
  previewLines,
  summarizeToolArgs,
  unwrapMcpResult,
} from "../src/shell/tool-render.ts";

/** The envelope shape `mcp-host.ts` returns, as captured from a real `linear_list_comments` turn. */
const linearEnvelope = JSON.stringify(
  {
    outcome: "ok",
    content: JSON.stringify({
      comments: [
        { id: "b245a846-7ad6-477b-9ccd-da5a4971e33e", body: "VUH-1136 b22835a transport PASS 8/8" },
        { id: "50634afb-12c1-4973-bb2e-38e3bd7dd70c", body: "VUH-1183 b22835a PASS 8/8" },
      ],
    }),
  },
  null,
  2,
);

describe("unwrapMcpResult", () => {
  it("turns the single re-encoded content line into real lines", () => {
    expect(linearEnvelope.split("\n")).toHaveLength(4);
    const unwrapped = unwrapMcpResult(linearEnvelope);
    expect(unwrapped.split("\n").length).toBeGreaterThan(4);
    expect(unwrapped).not.toContain('\\"');
    expect(unwrapped).toContain("VUH-1136 b22835a transport PASS 8/8");
  });

  it("pretty-prints a refusal, which carries no content string", () => {
    const refused = JSON.stringify({ outcome: "refused", reason: "lane", detail: "operator only" });
    expect(unwrapMcpResult(refused).split("\n")).toHaveLength(5);
  });

  it("leaves a non-envelope payload alone", () => {
    const notice = "[Output truncated to 20 of 53820 bytes; request a narrower result.]";
    expect(unwrapMcpResult(notice)).toBe(notice);
    expect(unwrapMcpResult("[1,2,3]")).toBe("[1,2,3]");
  });

  it("keeps a content string that is not itself JSON", () => {
    expect(unwrapMcpResult(JSON.stringify({ outcome: "ok", content: "plain text" }))).toBe("plain text");
  });
});

describe("previewLines", () => {
  it("caps a collapsed row at ten lines and reports the remainder", () => {
    const output = Array.from({ length: 25 }, (_, index) => `line ${index}`).join("\n");
    expect(previewLines(output, false)).toEqual({
      lines: Array.from({ length: 10 }, (_, index) => `line ${index}`),
      hidden: 15,
    });
    expect(previewLines(output, true).hidden).toBe(0);
  });

  it("actually caps an unwrapped linear result, which the raw envelope never did", () => {
    expect(previewLines(linearEnvelope, false).hidden).toBe(0);
    expect(previewLines(unwrapMcpResult(linearEnvelope), false).hidden).toBeGreaterThan(0);
  });
});

describe("summarizeToolArgs", () => {
  it("flattens arguments onto one line", () => {
    expect(summarizeToolArgs({ issueId: "VUH-1136", limit: 30 })).toBe("issueId=VUH-1136 limit=30");
  });

  it("drops undefined values and truncates long ones", () => {
    const summary = summarizeToolArgs({ query: "x".repeat(200), limit: undefined });
    expect(summary).not.toContain("limit");
    expect(summary.length).toBeLessThanOrEqual(96);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("has nothing to say about a non-object", () => {
    expect(summarizeToolArgs(undefined)).toBe("");
    expect(summarizeToolArgs([1, 2])).toBe("");
  });
});

describe("genericToolRenderer", () => {
  it("leaves pi's own tools to pi", () => {
    for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
      expect(genericToolRenderer(name), name).toBeUndefined();
    }
  });

  it("claims an MCP tool and renders both halves", () => {
    const definition = genericToolRenderer("linear_list_comments");
    expect(definition?.renderCall).toBeTypeOf("function");
    expect(definition?.renderResult).toBeTypeOf("function");
  });
});
