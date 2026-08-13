import { defineTool } from "eve/tools";
import { z } from "zod";
import { controlPlaneClient } from "../../lib/client.ts";
import { runShell } from "../../lib/shell.ts";

/**
 * His shell ([ADR 0086](../../../../docs/adr/0086-clankie-holds-a-shell.md)).
 *
 * This file used to be `disableTool()`, and the name is kept because the model
 * already knows what `bash` means. What changed is where it runs: the command
 * goes to the runner, which executes it under the same macOS Seatbelt profile
 * that confines a mission worker. He never holds the process.
 *
 * The description tells him the boundary in the terms he will hit it in —
 * "writes land in your scratchpad", not "the sandbox denies file-write outside
 * the workspace subpath" — because a model that understands the shape of its
 * own limits asks for the right thing instead of retrying into a wall.
 */
export default defineTool({
  description:
    "Run one bash command on the machine you live on. You can read anything the machine can read — " +
    "browse directories, grep code, inspect logs, check what is running. Writes are different: they " +
    "only land in your own scratchpad directory, which is where you start and where HOME points. " +
    "Writing anywhere else is stopped, and you will see it in `denials` rather than getting a silent " +
    "success. There is no network from here, so fetching something is your browser's job, not this one. " +
    "Use the scratchpad freely — notes, scripts, intermediate files, anything you want to keep across " +
    "a conversation. The result gives you exitCode, stdout and stderr; a 'refused' outcome names a " +
    "reason you can say out loud rather than something to retry.",
  inputSchema: z.object({
    command: z.string().trim().min(1).max(4_000).describe("The bash command to run."),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(600_000)
      .optional()
      .describe("How long to let it run before giving up. Defaults to two minutes."),
  }),
  async execute({ command, timeoutMs }) {
    return runShell(controlPlaneClient(), command, timeoutMs);
  },
});
