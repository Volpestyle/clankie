import { beforeAll, expect, it } from "vitest";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { ClankieExternalActivityComponent } from "../src/shell/external-activity.ts";

beforeAll(() => initTheme("dark"));

const text = (block: ClankieExternalActivityComponent) =>
  block.render(160).map(stripTerminalSequences).join("\n").replace(/\s+/gu, " ").trim();

it("names a Linear event from its quoted payload instead of the generic preamble", () => {
  const event = {
    headline: "Linear Comment create · Fix the dock · James",
    identifier: "VUH-42",
    title: "Fix",
  };
  const block = new ClankieExternalActivityComponent(
    ["Untrusted Linear event context:", `> ${JSON.stringify(event)}`].join("\n"),
  );
  expect(text(block)).toBe("Linear VUH-42 · Comment create · Fix the dock · James");
  block.setExpanded(true);
  expect(text(block)).toContain('"identifier":"VUH-42"');
});

it("keeps its own first line when the payload is not a readable event", () => {
  expect(text(new ClankieExternalActivityComponent("Untrusted Linear event context:\n> {not json"))).toBe(
    "External activity Untrusted Linear event context:",
  );
  expect(text(new ClankieExternalActivityComponent("Deploy finished\nall green"))).toBe(
    "External activity Deploy finished",
  );
});
