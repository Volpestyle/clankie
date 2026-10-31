import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PARTICIPANT_SESSION_ENV } from "../../../clankie/src/captain/participant-room-profile.ts";

/** A fresh plugin with public persona and the bound channel, without owner memory or fleet skills. */
export function projectParticipantPlugin(source: string, stateDir: string): string {
  const parent = join(stateDir, "participant-plugins");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const path = mkdtempSync(join(parent, "launch-"));
  const manifest = JSON.parse(readFileSync(join(source, ".claude-plugin", "plugin.json"), "utf8")) as {
    version: string;
  };
  mkdirSync(join(path, ".claude-plugin"));
  writeFileSync(
    join(path, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: "clankie",
      version: manifest.version,
      description: "Clankie's isolated room channel",
    }),
    { mode: 0o600 },
  );
  const config = JSON.parse(readFileSync(join(source, ".mcp.json"), "utf8")) as {
    mcpServers: { lead?: { command: string; args?: string[]; env?: Record<string, string> } };
  };
  const lead = config.mcpServers.lead;
  if (!lead) throw new Error("The Clankie participant channel is unavailable");
  writeFileSync(
    join(path, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        lead: {
          ...lead,
          env: { ...lead.env, [PARTICIPANT_SESSION_ENV]: "1" },
        },
      },
    }),
    { mode: 0o600 },
  );
  mkdirSync(join(path, "hooks"));
  writeFileSync(
    join(path, "hooks", "hooks.json"),
    JSON.stringify({
      hooks: Object.fromEntries(
        [
          "SessionStart",
          "UserPromptSubmit",
          "PostToolUse",
          "Stop",
          "StopFailure",
          "SessionEnd",
          "PreCompact",
        ].map((event) => [
          event,
          [
            {
              hooks: [
                ...(event === "SessionStart"
                  ? [
                      {
                        type: "command",
                        command: "clankie",
                        args: [
                          "prompt",
                          "--lane",
                          "operator",
                          "--sections",
                          "persona",
                          "--harness",
                          "claude",
                        ],
                        timeout: 60,
                      },
                    ]
                  : []),
                { type: "command", command: "clankie", args: ["seat-sync"], timeout: 60 },
              ],
            },
          ],
        ]),
      ),
    }),
    { mode: 0o600 },
  );
  return path;
}
