import type { Socket } from "node:net";
import type { NativeSocketProcess } from "../../src/local-fleet-process.ts";
import { ancestors, clientPid } from "../../src/local-fleet-proof.ts";

/** Adapt the existing fake lsof/ps cases to the native observation seam. */
export function socketProcessFixture(
  socket: Socket,
  owner: string,
  tree: string,
): NativeSocketProcess | undefined {
  const pid = clientPid(owner, socket.remotePort!, socket.localPort!);
  if (pid === undefined) return undefined;
  const chain = ancestors(tree, pid);
  if (chain.length === 0) return undefined;
  const birth = ["1791190000", "123456"] as const;
  return {
    schemaVersion: 1,
    owner: { pid, uid: process.getuid?.() ?? 0, birth, socket: "1:2:3" },
    ancestors: chain.map((pid, index) => ({ pid, ppid: chain[index + 1] ?? 1, birth })),
  };
}
