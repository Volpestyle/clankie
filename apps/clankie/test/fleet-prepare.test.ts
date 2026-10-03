import { describe, expect, it, vi } from "vitest";
import { approveWorkerChannel, workerMarketplace } from "../src/fleet-prepare.ts";
import {
  parseConsentOutput,
  remoteClaudeConsent,
  remoteClaudeTrackerDeny,
} from "../src/captain/remote-claude-worker.ts";
import type { HerdrFleet } from "../src/herdr-fleet.ts";

const pc: HerdrFleet = { id: "pc", session: "default", ssh: { host: "volpe@pc", shell: "powershell" } };
const worker = { marketplace: "clankie", plugin: "clankie-worker" };

describe("preparing a machine for Claude workers (VUH-1527)", () => {
  it("approves the worker channel and keeps every other policy entry", () => {
    const existing = JSON.stringify({
      model: "x",
      allowedChannelPlugins: [{ marketplace: "m", plugin: "p" }],
    });
    const approved = approveWorkerChannel(existing);
    expect(approved.changed).toBe(true);
    expect(JSON.parse(approved.content)).toEqual({
      model: "x",
      channelsEnabled: true,
      allowedChannelPlugins: [{ marketplace: "m", plugin: "p" }, worker],
    });
    expect(approveWorkerChannel(approved.content)).toEqual({ content: approved.content, changed: false });
    expect(JSON.parse(approveWorkerChannel("").content)).toEqual({
      channelsEnabled: true,
      allowedChannelPlugins: [worker],
    });
    expect(() => approveWorkerChannel("[1]")).toThrow(/untouched/u);
  });

  it("ships a marketplace with only the worker plugin", () => {
    expect(JSON.parse(workerMarketplace())).toMatchObject({
      name: "clankie",
      plugins: [{ name: "clankie-worker", source: "./worker" }],
    });
  });

  it("reads consent from the machine's plugins and policy, and names the one fix", async () => {
    const output = (plugins: string, policies: string[]) =>
      [
        "noise",
        "---CLANKIE-PLUGINS---",
        plugins,
        ...policies.flatMap((p) => ["---CLANKIE-POLICY---", p]),
      ].join("\r\n");
    expect(parseConsentOutput(output("[]", ["{}", '{"a":1}']))).toEqual({
      plugins: "[]",
      policies: ["{}", '{"a":1}'],
    });
    const installed = '[{"id":"clankie-worker@clankie"}]';
    const policy = JSON.stringify({ channelsEnabled: true, allowedChannelPlugins: [worker] });
    expect(await remoteClaudeConsent(pc, async () => output(installed, [policy]))()).toEqual({
      approved: true,
    });
    expect(await remoteClaudeConsent(pc, async () => output(installed, []))()).toMatchObject({
      approved: false,
      fix: expect.stringContaining("clankie herdr prepare pc"),
    });
    expect(await remoteClaudeConsent(pc, async () => output("[]", [policy]))()).toMatchObject({
      approved: false,
      detail: expect.stringContaining("not installed on pc"),
    });
  });

  it("denies tracker connectors from the machine's own Claude configuration, by Windows path rules", async () => {
    const state = {
      mcpServers: { linear: { url: "https://mcp.linear.app/mcp" } },
      projects: {
        "C:\\Users\\volpe\\repos": {
          mcpServers: { "work-linear": { command: "npx", args: ["linear-mcp"] } },
        },
        "C:\\Users\\volpe\\other": { mcpServers: { "other-linear": { url: "https://mcp.linear.app/x" } } },
      },
    };
    const shell = vi.fn(async (_command: string) => JSON.stringify(state));
    expect(await remoteClaudeTrackerDeny(pc, shell)("c:\\users\\volpe\\repos\\kh2")).toEqual([
      "mcp__claude_ai_Linear",
      "mcp__linear",
      "mcp__work-linear",
    ]);
    await expect(remoteClaudeTrackerDeny(pc, async () => "{not json")("C:\\x")).rejects.toThrow(
      /configuration/u,
    );
  });
});

it.each([true, false])(
  "preparation uses native per-profile installers and checks deployed versions (current=%s)",
  async (current) => {
    const { prepareFleet } = await import("../src/fleet-prepare.ts");
    const commands: string[] = [];
    const copied: string[] = [];
    const shell = async (command: string) => {
      const encoded = command.match(/-EncodedCommand\s+['"]?([A-Za-z0-9+/=]+)/u)?.[1];
      const text = encoded ? Buffer.from(encoded, "base64").toString("utf16le") : command;
      commands.push(text);
      if (text.includes("harness-install.mjs"))
        return JSON.stringify([{ harness: "codex", status: "source-manager-required" }]);
      if (text.includes("harness-status.mjs"))
        return JSON.stringify({
          claude: [{ executable: true, enabled: true, versionMatches: current }],
          codex: { registered: false, pluginInstalled: false, versionMatches: false },
        });
      if (text.includes("CLANKIE-POLICY-PATH"))
        return `---CLANKIE-POLICY-PATH---C:\\policy.json\n${JSON.stringify({ channelsEnabled: true, allowedChannelPlugins: [worker] })}`;
      return "";
    };
    const result = prepareFleet(pc, {
      shell,
      workerPluginDir: new URL("../../../integrations/claude-plugin/worker", import.meta.url).pathname,
      copy: async (_source, destination) => {
        copied.push(destination);
      },
    });
    if (current)
      expect(await result).toMatchObject({
        codex: { registered: false, changed: false },
        installations: [{ status: "source-manager-required" }],
      });
    else await expect(result).rejects.toThrow("stale");
    expect(copied).toContain(".clankie/claude-plugin.new/.agents");
    expect(commands.join("\n")).not.toMatch(/AppendAllText|mcp_servers\.clankie|plugin disable/u);
  },
);
