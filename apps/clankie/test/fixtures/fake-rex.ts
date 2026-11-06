import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/** One block in the fake Rex's state, in the shapes `fake-rex.mjs` replays. */
interface FakeRexBlock {
  block_id: string;
  label?: string;
  creator_name?: string;
  records?: { id?: string; state: string; kind?: string; app?: string; msg?: string }[];
  foreground?: { pid: number; name: string; cwd?: string } | null;
  capture?: string;
  screen?: string;
  /** Starts working (and reports it on the event stream) when Enter follows a paste. */
  takes?: boolean;
  pasted?: string[];
  keys?: string[];
}

export interface FakeRexState {
  down?: boolean;
  failPaste?: boolean;
  /** Holds the next paste or key press open after it took effect, until `release()`. */
  hold?: "paste" | "send-key";
  version: Record<string, unknown>;
  sessions: { session_id: string; label?: string; blocks: FakeRexBlock[] }[];
  events?: unknown[];
}

/** A `rex` executable on a PATH of its own, backed by `fake-rex.mjs`, for one test. */
export async function fakeRex(state: FakeRexState) {
  const dir = await mkdtemp(join(tmpdir(), "clankie-fake-rex-"));
  const statePath = join(dir, "state.json");
  const logPath = join(dir, "calls.jsonl");
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(logPath, "");
  const bin = join(dir, "bin");
  await mkdir(bin);
  const script = join(import.meta.dirname, "fake-rex.mjs");
  await writeFile(
    join(bin, "rex"),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`,
  );
  await chmod(join(bin, "rex"), 0o755);
  return {
    env: {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      FAKE_REX_STATE: statePath,
      FAKE_REX_LOG: logPath,
    } as NodeJS.ProcessEnv,
    async calls(): Promise<{ argv: string[]; stdin: string }[]> {
      return (await readFile(logPath, "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { argv: string[]; stdin: string });
    },
    async state(): Promise<FakeRexState> {
      return JSON.parse(await readFile(statePath, "utf8")) as FakeRexState;
    },
    async update(change: (state: FakeRexState) => void): Promise<void> {
      const next = JSON.parse(await readFile(statePath, "utf8")) as FakeRexState;
      change(next);
      await writeFile(statePath, JSON.stringify(next));
    },
    /** Resolves once a held call has taken effect and is waiting. */
    async held(): Promise<void> {
      for (;;) {
        try {
          await access(`${statePath}.held`);
          return await rm(`${statePath}.held`, { force: true });
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
    },
    release: () => writeFile(`${statePath}.release`, ""),
    close: () => rm(dir, { recursive: true, force: true }),
  };
}
