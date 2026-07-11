import { execFile } from "node:child_process";

export type ClankieClipboardEnv = {
  readonly TMUX?: string;
  readonly STY?: string;
  readonly WAYLAND_DISPLAY?: string;
};

// OSC 52 lets a terminal copy to the system clipboard even over SSH where no
// local clipboard binary is reachable. tmux/screen need the sequence wrapped in
// their passthrough so it reaches the outer terminal.
export function clankieOsc52Sequence(text: string, env: ClankieClipboardEnv = process.env): string {
  const payload = Buffer.from(text, "utf8").toString("base64");
  const sequence = `\x1b]52;c;${payload}\x07`;
  if (env.TMUX !== undefined && env.TMUX !== "") return `\x1bPtmux;\x1b${sequence}\x1b\\`;
  if (env.STY !== undefined && env.STY !== "") return `\x1bP${sequence}\x1b\\`;
  return sequence;
}

// Native clipboard binary for the platform, used alongside OSC 52 so local
// terminals that ignore OSC 52 (Terminal.app) still copy.
export function clankieNativeClipboardArgv(
  platform: NodeJS.Platform,
  env: ClankieClipboardEnv = process.env,
): string[] | undefined {
  if (platform === "darwin") return ["pbcopy"];
  if (platform === "win32") return ["clip"];
  if (platform === "linux") {
    if (env.WAYLAND_DISPLAY !== undefined && env.WAYLAND_DISPLAY !== "") return ["wl-copy"];
    return ["xclip", "-selection", "clipboard"];
  }
  return undefined;
}

function runNativeClipboard(argv: string[], text: string): Promise<void> {
  return new Promise((resolve) => {
    const [command, ...args] = argv;
    if (command === undefined) {
      resolve();
      return;
    }
    const child = execFile(command, args, () => resolve());
    child.on("error", () => resolve());
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(text);
  });
}

export async function writeClankieClipboard(
  text: string,
  writeTerminal: (data: string) => void,
  env: ClankieClipboardEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  writeTerminal(clankieOsc52Sequence(text, env));
  const argv = clankieNativeClipboardArgv(platform, env);
  if (argv !== undefined) await runNativeClipboard(argv, text);
}
