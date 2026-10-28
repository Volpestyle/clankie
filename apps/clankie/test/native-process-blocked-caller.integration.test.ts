import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  closeNativeProcessObservers,
  nativeProcessRequest,
  type NativeTransportReason,
} from "../src/native-process-transport.ts";

const roots: string[] = [];
afterEach(async () => {
  await closeNativeProcessObservers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** The production transport against the real child fixture the transport suite uses. */
async function helper() {
  const root = await mkdtemp(join(tmpdir(), "clankie-native-blocked-"));
  roots.push(root);
  const path = join(root, "helper.mjs");
  const source = await readFile(
    new URL("./helpers/native-process-transport/fixture.mjs", import.meta.url),
    "utf8",
  );
  await writeFile(path, `#!${process.execPath}\n${source}`);
  await chmod(path, 0o700);
  return path;
}

/** Another case in the same worker running synchronous work. */
function block(ms: number) {
  const until = performance.now() + ms;
  while (performance.now() < until);
}

// Under gate load, the darwin cwd census failed its 1 s bound although the
// helper answered in milliseconds: a blocked caller fired the timer before it
// read the reply already in the pipe (VUH-2937).
it.skipIf(process.platform === "win32")(
  "a caller that blocks its event loop past the bound still gets the helper's reply, and a stalled helper still fails closed",
  async () => {
    const path = await helper();
    const reasons: NativeTransportReason[] = [];
    const report = (reason: NativeTransportReason) => reasons.push(reason);
    // Warm: later requests run under the 1 s proof bound, not the startup bound.
    expect(JSON.parse((await nativeProcessRequest(path, ["warm"], undefined, report))!.stdout)).toMatchObject(
      {
        mode: "warm",
      },
    );

    const blocked = nativeProcessRequest(path, ["blocked"], undefined, report);
    block(1_500);
    expect(JSON.parse((await blocked)!.stdout)).toMatchObject({ mode: "blocked" });
    expect(reasons).toEqual([]);

    expect(await nativeProcessRequest(path, ["timeout"], undefined, report)).toBeUndefined();
    expect(reasons).toEqual(["timeout"]);
  },
);
