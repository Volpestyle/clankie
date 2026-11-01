// Replays the model's resumed-transfer path (#101) over the real HTTP routes:
// freeze S for A -> stage and apply at A (reply lost) -> the owner resumes or aborts
// naming B -> every body restarts.
// Usage: replay-resume.ts cli|cli-abort|api|api-staged
//   cli:       `clankie transfer --transfer-id t --to B` through the real runTransferCommand
//   cli-abort: `clankie transfer abort --transfer-id t --to B` through the real runTransferCommand
//   api:       an owner-authorized caller drives S's and B's routes directly, as the CLI would
//              without its destination check: pull S's bundle, stage and apply it at B
//   api-staged: the model's shortest path instead: A never applies; B stages S's bundle over the
//              routes, the owner then aborts correctly (`clankie transfer abort --to A`), and B applies
// Prints the refusal, if any, then ONE ACTIVE (exit 0) or TWO ACTIVE (exit 1).
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BODY_TRANSFER_APPLY_PATH,
  BODY_TRANSFER_BUNDLE_PATH,
  BODY_TRANSFER_STAGE_CHUNK_PATH,
  BODY_TRANSFER_STAGE_PATH,
} from "../../../packages/protocol/src/body-transfer.ts";
import { BodyTransfer, createBodyTransferRoutes } from "../../../apps/clankie/src/body-transfer.ts";
import { runTransferCommand } from "../../../apps/tui/src/command/transfer.ts";

const mode = process.argv[2];
if (!["cli", "cli-abort", "api", "api-staged"].includes(mode ?? ""))
  throw new Error("usage: replay-resume.ts cli|cli-abort|api|api-staged");
const settings = (dir: string) => {
  let value: Record<string, unknown> = { projects: { projects: [] } };
  return {
    path: join(dir, "settings.json"),
    load: async () => value,
    update: async (f: (v: typeof value) => typeof value) => (value = f(value)),
  } as never;
};
const root = mkdtempSync(join(tmpdir(), "replay-body-resume-"));
const url = { S: "http://s.test", A: "http://a.test", B: "http://b.test" } as const;
type Name = keyof typeof url;
const dir = (n: Name) => join(root, n);
for (const n of ["S", "A", "B"] as const) mkdirSync(join(dir(n), "state"), { recursive: true });
const body = (n: Name) =>
  new BodyTransfer({
    roots: { state: join(dir(n), "state"), memory: join(dir(n), "memory"), attachments: join(dir(n), "att") },
    settings: settings(dir(n)),
    label: url[n],
  });
const ready = async (commit: () => Promise<void>) => (await commit(), "ready" as const);

// Each body is its real routes over its BodyTransfer; a restart is a new instance plus boot().
const live = {} as Record<Name, BodyTransfer>;
const routes = {} as Record<Name, ReturnType<typeof createBodyTransferRoutes>>;
const mount = async (n: Name) => {
  const transfer = body(n);
  await transfer.boot();
  live[n] = transfer;
  routes[n] = createBodyTransferRoutes({
    transfer,
    authorize: async () => true,
    ...(transfer.dormant() ? {} : { cutover: ready }),
    restart: () => {},
  });
};
const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
  const target = new URL(String(input));
  const n = (Object.keys(url) as Name[]).find((k) => url[k] === target.origin);
  if (n === undefined) throw new Error(`no body at ${target.origin}`);
  return routes[n].fetch(new Request(target, init));
}) as typeof fetch;
const post = async (n: Name, path: string, payload: unknown) => {
  const response = await fetchImpl(new URL(path, url[n]), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw Object.assign(new Error(String(json.error)), { code: json.error });
  return json;
};
const t = randomUUID();

// S freezes for A and restarts dormant.
await mount("S");
await live.S.freeze({ transferId: t, destination: url.A }, ready);
await mount("S");
// A stages and applies over its routes; its reply is lost to the restart, so it stays frozen/applying.
await mount("A");
const move = async (to: Name, apply = true) => {
  for (let offset = 0; ; ) {
    const chunk = await post("S", BODY_TRANSFER_BUNDLE_PATH, { transferId: t, offset });
    const bytes = Buffer.from(String(chunk.bytesBase64), "base64");
    if (bytes.length > 0) await post(to, BODY_TRANSFER_STAGE_CHUNK_PATH, { transferId: t, offset, bytesBase64: chunk.bytesBase64 });
    offset += bytes.length;
    if (offset >= Number(chunk.size)) {
      await post(to, BODY_TRANSFER_STAGE_PATH, { transferId: t, size: chunk.size, sha256: chunk.sha256 });
      break;
    }
  }
  if (apply) await post(to, BODY_TRANSFER_APPLY_PATH, { transferId: t });
};
if (mode !== "api-staged") await move("A");
await mount("B");

const token = join(root, "token");
writeFileSync(token, "replay-token\n");
const sink = { write: () => true } as never;
const cli = (args: string[], to: Name) =>
  runTransferCommand([...args, "--from", url.S, "--from-token-file", token, "--to", url[to], "--to-token-file", token, "--transfer-id", t], sink, {
    fetchImpl,
    stderr: sink,
    pollSeconds: 0.01,
  });
let refused: string | undefined;
try {
  if (mode === "api") await move("B");
  else if (mode === "api-staged") {
    await move("B", false);
    await cli(["abort"], "A"); // the right body burns the id; S returns to active
    await mount("S");
    await post("B", BODY_TRANSFER_APPLY_PATH, { transferId: t });
  } else await cli(mode === "cli-abort" ? ["abort"] : [], "B");
} catch (error) {
  refused = (error as { code?: string }).code ?? (error as Error).message;
}

// Every body restarts; A and B finish any apply they committed.
for (const n of ["S", "A", "B"] as const) await mount(n);
const states = Object.fromEntries(
  (["S", "A", "B"] as const).map((n) => {
    const a = live[n].authority();
    return [n, { state: a.state, selfId: a.selfId, epoch: a.epoch }];
  }),
);
console.log(`refused: ${refused ?? "no"}`);
console.log(JSON.stringify(states));
const active = Object.values(states).filter((s) => s.state === "active" && s.selfId !== undefined);
if (active.length > 1 && new Set(active.map((s) => s.selfId)).size < active.length) {
  console.log(`TWO ACTIVE: the same self is active at ${Object.keys(states).filter((n) => states[n].state === "active" && states[n].selfId !== undefined).join(" and ")}`);
  process.exitCode = 1;
} else console.log("ONE ACTIVE");
