/**
 * `/pair` in the console is `clankie pair`: one implementation, so the console
 * carries the same relay guarantee and the same fail-closed mapping the CLI has
 * (VUH-1037). `/gateway` has been telling operators to run it since the doorway
 * landed; before this it was a command that did not exist.
 *
 * The QR, the code, and the deep link are secret-bearing display data. They go
 * into the terminal transcript and nowhere else — no history file, no model
 * context — so the command writes its output into a buffer rather than the
 * shared stdout an alt-screen console cannot use anyway.
 */
import { runPairCommand, type PairCommandOptions } from "./command/pair.ts";
import type { ClankieFaceShell, FaceShellCommand } from "./shell/shell.ts";

/** The CLI's own options, minus the streams this command owns. */
export type PairCommandServices = Omit<PairCommandOptions, "stdout" | "stderr">;

function buffer(): { write(chunk: string): void; text(): string } {
  let text = "";
  return {
    write(chunk: string): void {
      text += chunk;
    },
    text: () => text,
  };
}

export function buildPairCommands(services: PairCommandServices): FaceShellCommand[] {
  return [
    {
      name: "pair",
      aliases: [],
      description: "Pair a phone or tablet with this machine",
      argumentHint: "[--review --days N]",
      takesArgument: true,
      async run(argument: string, shell: ClankieFaceShell): Promise<void> {
        const stdout = buffer();
        const stderr = buffer();
        const exit = await runPairCommand(
          argument
            .trim()
            .split(/\s+/u)
            .filter((word) => word.length > 0),
          { ...services, stdout, stderr },
        );
        // Startup progress ("Starting App relay…") precedes the offer it made
        // possible, and on failure it is the whole story.
        const body = `${stderr.text()}\n${stdout.text()}`.trim();
        shell.insertCommandResult("/pair", body, exit === 0 ? "success" : "error");
      },
    },
  ];
}
