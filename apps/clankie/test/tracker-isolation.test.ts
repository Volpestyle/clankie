import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeTrackerDenyRules,
  codexTrackerOverrides,
  isTrackerServer,
} from "../src/captain/tracker-isolation.ts";

const scratch = () => mkdtemp(join(tmpdir(), "clankie-tracker-"));

describe("inherited tracker connectors", () => {
  it("recognizes Linear by its host, its name or its package, and nothing else", () => {
    expect(isTrackerServer("work", { url: "https://mcp.linear.app/mcp" })).toBe(true);
    expect(isTrackerServer("linear-server", { command: "npx" })).toBe(true);
    expect(isTrackerServer("tracker", { command: "npx", args: ["-y", "@linear/mcp"] })).toBe(true);
    expect(isTrackerServer("github", { url: "https://api.githubcopilot.com/mcp" })).toBe(false);
    expect(isTrackerServer("docs", { url: "not a url" })).toBe(false);
  });

  it("denies every Claude connector a session in this directory would inherit", async () => {
    const root = await scratch();
    const project = join(root, "repo");
    const cwd = join(project, "pkg");
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(root, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "linear-server": { type: "http", url: "https://mcp.linear.app/mcp" },
          github: { command: "github-mcp-server" },
        },
        projects: {
          [project]: { mcpServers: { "work tracker": { url: "https://mcp.linear.app/sse" } } },
          [join(root, "elsewhere")]: {
            mcpServers: { "other-linear": { url: "https://mcp.linear.app/mcp" } },
          },
        },
      }),
    );
    await writeFile(
      join(project, ".mcp.json"),
      JSON.stringify({ mcpServers: { issues: { command: "npx", args: ["@linear/mcp"] } } }),
    );
    expect(claudeTrackerDenyRules(cwd, { CLAUDE_CONFIG_DIR: root, HOME: root })).toEqual([
      "mcp__claude_ai_Linear",
      "mcp__issues",
      "mcp__linear-server",
      "mcp__work_tracker",
    ]);
  });

  it("also reads the default config, since a worker's pane may not share CLAUDE_CONFIG_DIR", async () => {
    const root = await scratch();
    await mkdir(join(root, "alt"));
    await writeFile(join(root, "alt", ".claude.json"), JSON.stringify({ mcpServers: {} }));
    await writeFile(
      join(root, ".claude.json"),
      JSON.stringify({ mcpServers: { "linear-server": { url: "https://mcp.linear.app/mcp" } } }),
    );
    expect(claudeTrackerDenyRules(root, { CLAUDE_CONFIG_DIR: join(root, "alt"), HOME: root })).toEqual([
      "mcp__claude_ai_Linear",
      "mcp__linear-server",
    ]);
  });

  it("still denies the claude.ai connector when there is no Claude config", async () => {
    const root = await scratch();
    expect(claudeTrackerDenyRules(root, { CLAUDE_CONFIG_DIR: root, HOME: root })).toEqual([
      "mcp__claude_ai_Linear",
    ]);
  });

  it("disables enabled Codex tracker servers from Codex's own effective listing", async () => {
    const bin = await scratch();
    const listing = [
      {
        name: "linear",
        enabled: true,
        transport: { type: "streamable_http", url: "https://mcp.linear.app/mcp" },
      },
      {
        name: "team.linear",
        enabled: true,
        transport: { type: "stdio", command: "npx", args: ["@linear/mcp"] },
      },
      { name: "old-linear", enabled: false, transport: { url: "https://mcp.linear.app/mcp" } },
      { name: "github", enabled: true, transport: { type: "stdio", command: "github-mcp-server" } },
    ];
    await writeFile(
      join(bin, "codex"),
      `#!/bin/sh\n[ "$1 $2 $3" = "mcp list --json" ] || exit 2\ncat <<'JSON'\n${JSON.stringify(listing)}\nJSON\n`,
    );
    await chmod(join(bin, "codex"), 0o755);
    expect(await codexTrackerOverrides(bin, { PATH: `${bin}:/usr/bin:/bin` })).toEqual([
      'mcp_servers."team.linear".enabled=false',
      "mcp_servers.linear.enabled=false",
    ]);
  });

  it("fails closed when Codex cannot list its servers", async () => {
    const bin = await scratch();
    await writeFile(join(bin, "codex"), "#!/bin/sh\necho broken >&2\nexit 1\n");
    await chmod(join(bin, "codex"), 0o755);
    await expect(codexTrackerOverrides(bin, { PATH: `${bin}:/usr/bin:/bin` })).rejects.toThrow(
      /switch off inherited Linear connectors/u,
    );
  });
});
