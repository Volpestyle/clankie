import { beforeAll, expect, it } from "vitest";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { ClankieExternalActivityComponent } from "../src/shell/external-activity.ts";

beforeAll(() => initTheme("dark"));

const text = (block: ClankieExternalActivityComponent) =>
  block.render(160).map(stripTerminalSequences).join("\n").replace(/\s+/gu, " ").trim();

it("preserves the quoted Linear payload when expanded", () => {
  const event = {
    headline: "Linear Comment create · Fix the dock · James",
    identifier: "VUH-42",
    title: "Fix",
  };
  const block = new ClankieExternalActivityComponent(
    ["Untrusted Linear event context:", `> ${JSON.stringify(event)}`].join("\n"),
  );
  block.setExpanded(true);
  expect(text(block)).toContain('"identifier":"VUH-42"');
});
