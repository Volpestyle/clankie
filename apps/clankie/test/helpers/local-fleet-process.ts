import type { Socket } from "node:net";
import type { NativeSocketProcess } from "../../src/local-fleet-process.ts";
import { ancestors, clientPid } from "../../src/local-fleet-proof.ts";
import { nativeProcessStart } from "../../src/local-fleet-process.ts";

function processFixtureBirth(start = "Sat Oct  3 10:00:00 2026"): [string, string] {
  if (/^\d+\.\d{6}$/u.test(start)) return start.split(".") as [string, string];
  const delta = (Date.parse(start) - Date.parse("Sat Oct  3 10:00:00 2026")) / 1000;
  return [String(1791190000 + delta), "123456"];
}

export function processFixtureStart(start?: string): string {
  return nativeProcessStart(processFixtureBirth(start));
}

/** Existing observer fixtures now provide the native batch schema, never OS text parsing. */
export function projectProcessFixture(
  shell: number,
  agent: number,
  options: { start?: string; shellStart?: string; executable?: string; argv?: string[] } = {},
): string {
  return JSON.stringify({
    schemaVersion: 1,
    processes: [
      {
        pid: shell,
        ppid: 1,
        uid: process.getuid?.() ?? 0,
        birth: processFixtureBirth(options.shellStart ?? options.start),
        executable: "/bin/zsh",
        argv: [],
      },
      {
        pid: agent,
        ppid: shell,
        uid: process.getuid?.() ?? 0,
        birth: processFixtureBirth(options.start),
        executable: options.executable ?? "/trusted/codex",
        argv: options.argv ?? [],
      },
    ],
  });
}

/** Adapt the existing fake lsof/ps cases to the native observation seam. */
export function socketProcessFixture(
  socket: Socket,
  owner: string,
  tree: string,
  start?: string,
): NativeSocketProcess | undefined {
  const pid = clientPid(owner, socket.remotePort!, socket.localPort!);
  if (pid === undefined) return undefined;
  const chain = ancestors(tree, pid);
  if (chain.length === 0) return undefined;
  const birth = processFixtureBirth(start);
  return {
    schemaVersion: 1,
    owner: { pid, uid: process.getuid?.() ?? 0, birth, socket: "1:2:3" },
    ancestors: chain.map((pid, index) => ({ pid, ppid: chain[index + 1] ?? 1, birth })),
  };
}
