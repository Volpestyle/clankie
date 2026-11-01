// Replays the model's abort path against the real BodyTransfer:
// freeze S -> stage and apply at A -> [A boots] -> discard at <A|B> -> abort at S -> A boots.
// Usage: replay-abort.ts A|B [booted] [claim=A|B]
//   A|B: the body that burns the id; booted: A finished its apply first;
//   claim: the `destination` label the abort request carries (default: the body that burned it).
// Prints the source's refusal code, if any, then ONE ACTIVE (exit 0) or TWO ACTIVE (exit 1).
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BodyTransfer } from "../../../apps/clankie/src/body-transfer.ts";

const settings = (dir: string) => {
  let value: Record<string, unknown> = { projects: { projects: [] } };
  return {
    path: join(dir, "settings.json"),
    load: async () => value,
    update: async (f: (v: typeof value) => typeof value) => (value = f(value)),
  } as never;
};
const body = (dir: string, label: string) =>
  new BodyTransfer({ roots: { state: join(dir, "state"), memory: join(dir, "memory"), attachments: join(dir, "att") }, settings: settings(dir), label });
const root = mkdtempSync(join(tmpdir(), "replay-body-transfer-"));
const [dS, dA, dB] = ["S", "A", "B"].map((n) => join(root, n));
const { mkdirSync } = await import("node:fs");
for (const d of [dS, dA, dB]) mkdirSync(join(d, "state"), { recursive: true });
const ready = async (commit: () => Promise<void>) => (await commit(), "ready" as const);
const t = randomUUID();

const S = body(dS, "S");
await S.freeze({ transferId: t, destination: "A" }, ready);
const S2 = body(dS, "S"); // the source restarts dormant
await S2.boot();
const A = body(dA, "A");
for (let offset = 0; ; ) {
  const chunk = await S2.bundleChunk({ transferId: t, offset });
  if (chunk.bytesBase64.length > 0) await A.stageChunk({ transferId: t, offset, bytesBase64: chunk.bytesBase64 });
  offset += Buffer.from(chunk.bytesBase64, "base64").length;
  if (offset >= chunk.size) {
    await A.stage({ transferId: t, size: chunk.size, sha256: chunk.sha256 });
    break;
  }
}
await A.apply({ transferId: t }, ready); // A commits to the apply; its reply may be lost to the restart
const flags = process.argv.slice(3);
if (flags.includes("booted")) await body(dA, "A").boot();
const claim = flags.find((f) => f.startsWith("claim="))?.slice(6) ?? process.argv[2];
const named = process.argv[2] === "A" ? body(dA, "A") : body(dB, "B");
let abortRefused: string | undefined;
try {
  const discarded = await named.discard({ transferId: t }); // `transfer abort --to` asks this body to burn the id
  await S2.abort({ transferId: t, destination: claim, discarded });
} catch (error) {
  abortRefused = (error as { code?: string }).code ?? (error as Error).message;
}
const A2 = body(dA, "A"); // A restarts and finishes its apply
await A2.boot();
const s = S2.authority(), a = A2.authority();
console.log(`refused: ${abortRefused ?? "no"}`);
console.log(JSON.stringify({ abortRefused, source: { state: s.state, selfId: s.selfId, epoch: s.epoch }, A: { state: a.state, selfId: a.selfId, epoch: a.epoch } }));
if (s.state === "active" && a.state === "active" && s.selfId === a.selfId) {
  console.log("TWO ACTIVE: the same self is active at the source and at A");
  process.exitCode = 1;
} else console.log("ONE ACTIVE");
