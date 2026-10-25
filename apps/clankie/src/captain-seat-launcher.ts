import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { HerdrBinding } from "@clankie/protocol";
import { RESOURCE_HOLDER_RESET_ENV } from "@clankie/fleet-resources";
import { CaptainSeatLaunchRefused } from "./captain-seat.ts";
import { nativeRequest } from "./herdr-native-request.ts";

/** Native initial argv only. Neither an existing pane nor a terminal-input verb is accepted. */
export function createCaptainSeatLauncher(options: {
  repoRoot: string;
  controlPlaneUrl: string;
  binding(): Promise<HerdrBinding | undefined>;
  env?: NodeJS.ProcessEnv;
}) {
  const env = options.env ?? process.env;
  const compiled = join(options.repoRoot, "apps/tui/bin/clankie.js");
  const command = existsSync(compiled)
    ? [process.execPath, compiled]
    : [
        process.execPath,
        "--import",
        join(options.repoRoot, "apps/tui/node_modules/tsx/dist/loader.mjs"),
        join(options.repoRoot, "apps/tui/bin/clankie.ts"),
      ];
  return async (
    input: { cwd: string; seat: "claude" | "codex"; conversationId: string },
    guard: () => Promise<boolean>,
  ) => {
    const binding = await options.binding();
    if (!binding) throw new CaptainSeatLaunchRefused("unavailable");
    const launchEnv: Record<string, string> = {
      ...RESOURCE_HOLDER_RESET_ENV,
      CLANKIE_CONVERSATION_ID: "",
      CLANKIE_CODEX_SEAT_BINDING: "",
      CLANKIE_CONTROL_PLANE_URL: options.controlPlaneUrl,
    };
    // Anchor the launcher to this installation's non-secret configuration,
    // rather than whatever environment the Herdr daemon started with.
    for (const key of [
      "HOME",
      "PATH",
      "XDG_CONFIG_HOME",
      "XDG_STATE_HOME",
      "CLANKIE_STATE_HOME",
      "CLANKIE_SETTINGS_FILE",
      "CLANKIE_CREDENTIALS_FILE",
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
    ])
      if (env[key] !== undefined) launchEnv[key] = env[key];
    if (!(await guard())) throw new CaptainSeatLaunchRefused("authority_revoked");
    const result = await nativeRequest(binding, "layout.apply", {
      tab_label: `Clankie · ${input.seat === "claude" ? "Claude Code" : "Codex"}`,
      focus: true,
      root: {
        type: "pane",
        cwd: input.cwd,
        command: [...command, input.seat, "--conversation", input.conversationId],
        env: launchEnv,
      },
    });
    const parsed = z
      .object({
        result: z.object({
          layout: z.object({
            root: z.object({
              type: z.literal("pane"),
              pane_id: z.string().regex(/^w[\w]+:p[\w]+$/u),
            }),
          }),
        }),
      })
      .parse(result);
    if (JSON.stringify(await options.binding()) !== JSON.stringify(binding)) throw Error("Herdr changed");
    return parsed.result.layout.root.pane_id;
  };
}
