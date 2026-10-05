import { runSupportCommand } from "./command/support.ts";
import { splitQuotedArguments } from "./command/agents.ts";
import type { FaceShellCommand } from "./shell/shell.ts";

/** Console and CLI share owner authority and the body grant API. */
export function buildSupportCommands(services: Parameters<typeof runSupportCommand>[1]): FaceShellCommand[] {
  return [
    {
      name: "support",
      aliases: [],
      description: "View, grant or revoke time-limited support access",
      argumentHint: "[list | create read-state|shell --hours 24 --ref REFERENCE | revoke ID | offer ID]",
      takesArgument: true,
      async run(argument, shell) {
        let output = "";
        try {
          await runSupportCommand(splitQuotedArguments(argument), {
            ...services,
            stdout: {
              write: (chunk) => {
                output += chunk;
              },
            },
          });
          shell.insertCommandResult("/support", output.trim(), "success");
        } catch (error) {
          shell.insertCommandResult(
            "/support",
            error instanceof Error ? error.message : String(error),
            "error",
          );
        }
      },
    },
  ];
}
