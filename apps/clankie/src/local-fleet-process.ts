import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { Socket } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);
const birth = z.tuple([z.string().regex(/^[1-9]\d{0,19}$/u), z.string().regex(/^\d{1,6}$/u)]);
const pid = z.number().int().min(2).max(2_147_483_647);
const SnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    owner: z
      .object({
        pid,
        uid: z.number().int().min(0),
        birth,
        socket: z.string().regex(/^\d+:\d+:\d+$/u),
      })
      .strict(),
    ancestors: z
      .array(z.object({ pid, ppid: z.number().int().min(0).max(2_147_483_647), birth }).strict())
      .min(1)
      .max(64),
  })
  .strict();

export interface NativeSocketOwner {
  readonly pid: number;
  readonly uid: number;
  readonly birth: readonly [string, string];
  readonly socket: string;
}
export interface NativeSocketProcess {
  readonly schemaVersion: 1;
  readonly owner: NativeSocketOwner;
  readonly ancestors: readonly {
    readonly pid: number;
    readonly ppid: number;
    readonly birth: readonly [string, string];
  }[];
}

/** The immutable release ships this helper; source startup prepares its local build. */
export function fleetProcessHelper(repoRoot = resolve(import.meta.dirname, "../../..")): string {
  const packaged = join(repoRoot, "libexec/local-fleet-proof");
  return existsSync(packaged) ? packaged : join(repoRoot, ".local/fleet-proof/native-process-proof");
}

/**
 * Fresh kernel socket ownership, process births and ancestry. An expected owner
 * is an additional refusal fence, never authority or a shortcut around a census.
 * Nothing is taken from the caller's request headers.
 */
export async function observeSocketProcess(
  socket: Socket,
  processHelper: string,
  expected?: NativeSocketOwner,
): Promise<NativeSocketProcess | undefined> {
  if (
    process.platform !== "darwin" ||
    !isAbsolute(processHelper) ||
    socket.destroyed ||
    !socket.readable ||
    !socket.writable ||
    socket.remoteAddress !== "127.0.0.1" ||
    socket.localAddress !== "127.0.0.1" ||
    !socket.remotePort ||
    !socket.localPort
  )
    return undefined;
  try {
    const { stdout } = await exec(
      processHelper,
      [
        String(socket.remotePort),
        String(socket.localPort),
        ...(expected === undefined ? [] : [String(expected.pid), ...expected.birth, expected.socket]),
      ],
      { timeout: 1_000, maxBuffer: 65_536, encoding: "utf8" },
    );
    const result = SnapshotSchema.safeParse(JSON.parse(stdout));
    if (!result.success) return undefined;
    const snapshot = result.data;
    const first = snapshot.ancestors[0]!;
    if (
      snapshot.owner.uid !== process.getuid?.() ||
      first.pid !== snapshot.owner.pid ||
      JSON.stringify(first.birth) !== JSON.stringify(snapshot.owner.birth) ||
      new Set(snapshot.ancestors.map((ancestor) => ancestor.pid)).size !== snapshot.ancestors.length ||
      snapshot.ancestors.some((ancestor, index) =>
        index + 1 < snapshot.ancestors.length
          ? ancestor.ppid !== snapshot.ancestors[index + 1]!.pid
          : ancestor.ppid > 1,
      ) ||
      (expected !== undefined &&
        (snapshot.owner.pid !== expected.pid ||
          snapshot.owner.uid !== expected.uid ||
          snapshot.owner.birth[0] !== expected.birth[0] ||
          snapshot.owner.birth[1] !== expected.birth[1] ||
          snapshot.owner.socket !== expected.socket))
    )
      return undefined;
    return snapshot;
  } catch {
    // Missing helper, unsupported ABI, ambiguous owner, exit, reuse or timeout:
    // none establishes process membership; no legacy scan silently substitutes.
    return undefined;
  }
}
