/** Native Codex JSONL → transcript parser → actual shell/Pi tool components.
 * Shapes are from VUH-1661 and this worker's exec/message receipts; no renderer,
 * transcript parser, terminal component, or theme is mocked. The TTY is not started.
 */
import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { parseHerdrSeatTranscript } from "@clankie/agent-transcript";
import { describe, expect, it } from "vitest";
import { ClankieFaceShell } from "../src/shell/shell.ts";

function renderNative(output: unknown, name = "exec_command", args: unknown = { cmd: "pnpm typecheck" }) {
  const jsonl = [
    {
      type: "response_item",
      payload: { type: "function_call", call_id: "call_fixture", name, arguments: JSON.stringify(args) },
    },
    { type: "response_item", payload: { type: "function_call_output", call_id: "call_fixture", output } },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  return renderTranscript(jsonl);
}

function renderTranscript(jsonl: string) {
  const entries = parseHerdrSeatTranscript("codex", jsonl);
  expect(entries.length).toBeGreaterThanOrEqual(2);
  const shell = new ClankieFaceShell({
    commands: [],
    cwd: process.cwd(),
    env: {},
    bannerFields: { title: "Clankie" },
  });
  // Same inspection surface as shell-assembly; all rendering/input stays real.
  const view = shell as unknown as {
    chat: { render(width: number): string[] };
    routeInput(data: string): unknown;
  };
  for (const entry of entries) {
    if (entry.type !== "tool") throw new Error("Expected a native tool entry");
    if (entry.phase === "started") shell.beginToolCall(entry.toolCallId, entry.name, entry.detail);
    else
      shell.completeToolCall(entry.toolCallId, entry.name, {
        failed: entry.phase === "failed",
        detail: entry.detail,
      });
  }
  const text = (width = 120) => stripVTControlCharacters(view.chat.render(width).join("\n"));
  const expand = () => view.routeInput("\x0f");
  return {
    text,
    expand,
    /** Tool rows are one line until opened; decoded results show beneath an opened row. */
    opened: (width = 120) => {
      expand();
      return text(width);
    },
  };
}

describe("native seat tool results in the real shell", () => {
  it("shows the retained expanded native-seat evidence beneath opened rows", () => {
    const evidence = (name: string) =>
      readFileSync(new URL(`../../../docs/testing/vuh-1661-tool-results/${name}`, import.meta.url), "utf8");
    const view = renderTranscript(evidence("native-fixture.jsonl"));
    const lines = (text: string) =>
      text
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line !== "");
    // VUH-2022: closed, each call is one row.
    expect(lines(view.text(100))).toEqual([
      " ✓ exec_command · pnpm --filter @clankie/tui typecheck",
      " ✓ mcp__clankie__message_clankie · text=Progress",
      " ✓ exec_command · example of long output",
    ]);
    // Opened, every line of the retained VUH-1661 render appears in order.
    const opened = lines(view.opened(100));
    let at = 0;
    for (const line of lines(evidence("expanded.txt"))) {
      at = opened.indexOf(line, at);
      expect(at, line).toBeGreaterThanOrEqual(0);
      at += 1;
    }
  });

  it("unwraps input_text and repeated JSON encoding, then shows command, exit, time and actual newlines", () => {
    const output = "$ tsc --noEmit -p tsconfig.json\nC:\\work\\clankie\n#< CLIXML\n<Objs>_x000D_</Objs>\n";
    const exec = { chunk_id: "01e7a2", wall_time_seconds: 0.4, exit_code: 0, output };
    const view = renderNative(
      JSON.stringify([{ type: "input_text", text: JSON.stringify(JSON.stringify(exec)) }]),
    );
    const text = view.opened();
    expect(text).toContain("Command: pnpm typecheck");
    expect(text).toContain("exit 0 · 0.4s");
    for (const line of output.trimEnd().split("\n")) expect(text).toContain(line);
    expect(text).not.toContain("input_text");
    expect(text).not.toContain("chunk_id");
    expect(text).not.toContain('\\"');
  });

  it("keeps long output closed and reveals all of it through the existing Ctrl+O", () => {
    const output = Array.from({ length: 25 }, (_, index) => `output line ${index}`).join("\n");
    const view = renderNative([
      { type: "input_text", text: JSON.stringify({ exit_code: 1, wall_time_seconds: 2, output }) },
    ]);
    expect(view.text()).not.toContain("output line 0");
    const opened = view.opened();
    expect(opened).toContain("exit 1 · 2s");
    expect(opened).toContain("output line 24");
    expect(opened).not.toContain("more lines");
  });

  it("keeps a yielded command's running session and a finished empty output visible", () => {
    expect(
      renderNative([
        {
          type: "input_text",
          text: JSON.stringify({ session_id: 20810, wall_time_seconds: 1, output: "still working" }),
        },
      ]).opened(),
    ).toContain("running · session 20810 · 1s");
    expect(
      renderNative([
        { type: "input_text", text: JSON.stringify({ exit_code: 0, wall_time_seconds: 0.1, output: "" }) },
      ]).opened(),
    ).toContain("(no output)");
  });

  it("collapses a real message receipt shape to one report line", () => {
    const receipt = {
      schemaVersion: 1,
      received: true,
      deliveryStage: "stored",
      deliveryId: "fixture-delivery",
      binding: "fixture-binding",
      fingerprint: "fixture-fingerprint",
    };
    const view = renderNative(
      [
        {
          type: "input_text",
          text: JSON.stringify({ content: [{ type: "text", text: JSON.stringify(receipt) }] }),
        },
      ],
      "mcp__clankie__message_clankie",
      { text: "Progress" },
    );
    const opened = view.opened();
    expect(opened).toContain("report stored");
    expect(opened).not.toContain("fixture-delivery");
    expect(view.text()).toContain("report stored");
    expect(view.text()).not.toContain("deliveryStage");
  });

  it.each([
    "plain failure\npermission denied",
    '[{"type":"input_text","text":"truncated',
    '{"output":"partial',
  ])("retains unparseable payload %s", (output) => {
    for (const line of output.split("\n")) expect(renderNative(output).opened()).toContain(line);
  });

  it("keeps unknown blocks, arbitrary JSON and text parts in order", () => {
    const view = renderNative([
      { type: "output_text", text: "first" },
      { type: "resource", resource: { uri: "fixture:report" } },
      { type: "text", text: '{"content":"ordinary API text","count":0}' },
      { type: "text", text: "last" },
    ]);
    view.expand();
    const text = view.text();
    expect(text).toContain('"count": 0');
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("fixture:report"));
    expect(text.indexOf("fixture:report")).toBeLessThan(text.indexOf("ordinary API text"));
    expect(text.indexOf("ordinary API text")).toBeLessThan(text.lastIndexOf("last"));
  });
});
