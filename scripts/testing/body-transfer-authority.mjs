/**
 * Manual no-model service proof for #201. Runs only private loopback bodies;
 * use clankie heavy --server -- node scripts/testing/body-transfer-authority.mjs .local/PROOF.
 */
import assert from "node:assert/strict";
import { spawn, execFile, execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv, promisify } from "node:util";
const execFileAsync = promisify(execFile);
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
const repo = resolve(import.meta.dirname, "../.."),
  root = resolve(process.argv[2] ?? join(repo, ".local", "body-transfer-authority-" + Date.now()));
assert(root.startsWith(join(repo, ".local") + "/"), "proof root must be inside this checkout .local");
await mkdir(root, { recursive: true });
const all = [];
async function until(read, label) {
  const end = Date.now() + 120000;
  while (Date.now() < end) {
    try {
      const x = await read();
      if (x) return x;
    } catch {}
    await delay(100);
  }
  throw Error("timeout " + label);
}
async function make(caseName, name) {
  const dir = join(root, caseName, name);
  execFileSync(process.execPath, ["scripts/scratch-stack.mjs", dir], { cwd: repo, stdio: "ignore" });
  const env = parseEnv(await readFile(join(dir, "stack.env"), "utf8"));
  env.NODE_ENV = "test";
  env.CLANKIE_TEST_FLEET_RESOURCES_DIRECTORY = join(dir, "resources");
  const b = { name, dir, env, url: env.CLANKIE_CAPTAIN_URL, supervise: true, child: undefined, pids: [] };
  all.push(b);
  if (name === "S") {
    b.legacyId = randomUUID();
    await mkdir(env.CLANKIE_STATE, { recursive: true });
    await writeFile(
      join(env.CLANKIE_STATE, "self.json"),
      JSON.stringify({ schemaVersion: 1, selfId: b.legacyId, epoch: 3, state: "active", transfers: {} }),
    );
  }
  start(b);
  await until(async () => {
    const h = await fetch(b.url + "/health", { redirect: "error", signal: AbortSignal.timeout(1000) });
    return h.ok;
  }, name + " boot");
  return b;
}
function start(b) {
  if (!b.supervise) return;
  const child = spawn(
    process.execPath,
    ["--import", join(repo, "scripts/dependency-types.mjs"), join(repo, "apps/clankie/src/index.ts")],
    {
      cwd: repo,
      env: { PATH: process.env.PATH, LANG: process.env.LANG, ...b.env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  b.child = child;
  b.pids.push(child.pid);
  for (const p of [child.stdout, child.stderr])
    p.on("data", (x) => appendFileSync(join(b.dir, "service.log"), x));
  child.on("exit", () => {
    if (b.supervise) b.timer = setTimeout(() => start(b), 100);
  });
}
async function stop(b) {
  b.supervise = false;
  clearTimeout(b.timer);
  const c = b.child;
  if (c && c.exitCode === null && c.signalCode === null) {
    const done = new Promise((r) => c.once("exit", r));
    c.kill("SIGTERM");
    await Promise.race([done, delay(10000)]);
    if (c.exitCode === null && c.signalCode === null) {
      c.kill("SIGKILL");
      await done;
    }
  }
}
async function call(b, op, payload) {
  const r = await fetch(b.url + "/v1/body-transfer/" + op, {
    method: payload === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + b.env.CLANKIE_OPERATOR_TOKEN, "content-type": "application/json" },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  const data = await r.json();
  return { status: r.status, data };
}
async function state(b, predicate = () => true) {
  return until(async () => {
    const r = await call(b, "status");
    return r.status === 200 && predicate(r.data) ? r.data : undefined;
  }, b.name + " state");
}
async function freeze(s, a, t) {
  const ticket = await call(a, "prepare", { transferId: t });
  assert.equal(ticket.status, 200, JSON.stringify(ticket));
  const r = await call(s, "freeze", {
    transferId: t,
    destination: a.url,
    destinationPeer: { url: a.url, ticket: ticket.data },
  });
  assert.equal(r.status, 200, JSON.stringify(r));
  const frozen = await state(s, (x) => x.state === "frozen" && x.dormant);
  assert.equal(frozen.selfId, s.legacyId, "first v2 freeze preserves legacy UUID");
  return frozen;
}
async function move(s, d, t, apply = true) {
  let stage;
  for (let offset = 0; ;) {
    const r = await call(s, "bundle", { transferId: t, offset });
    assert.equal(r.status, 200, JSON.stringify(r));
    const c = r.data;
    const size = Buffer.from(c.bytesBase64, "base64").length;
    if (size) {
      const sent = await call(d, "stage-chunk", { transferId: t, offset, bytesBase64: c.bytesBase64 });
      assert.equal(sent.status, 200, JSON.stringify(sent));
    }
    offset += size;
    if (offset >= c.size) {
      const ticket = await call(s, "prepare", { transferId: t });
      assert.equal(ticket.status, 200, JSON.stringify(ticket));
      stage = await call(d, "stage", {
        transferId: t,
        size: c.size,
        sha256: c.sha256,
        sourcePeer: { url: s.url, ticket: ticket.data },
      });
      break;
    }
  }
  if (stage.status === 200 && apply) {
    const r = await call(d, "apply", { transferId: t });
    assert.equal(r.status, 200, JSON.stringify(r));
    await state(d, (x) => x.state === "active" && x.transferId === t && !x.dormant);
  }
  return stage;
}
const sourceFiles = [
  "apps/clankie/src/body-transfer.ts",
  "apps/clankie/src/body-transfer-identity.ts",
  "apps/clankie/src/body-transfer-peer.ts",
  "packages/protocol/src/body-transfer.ts",
  "scripts/testing/body-transfer-authority.mjs",
];
const report = {
  revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
  sources: Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (p) => [
        p,
        createHash("sha256")
          .update(await readFile(join(repo, p)))
          .digest("hex"),
      ]),
    ),
  ),
  cases: [],
};
try {
  for (const kind of ["burn-relabelled", "resume-at-b", "stage-b-abort-a"]) {
    const s = await make(kind, "S"),
      a = await make(kind, "A"),
      b = await make(kind, "B");
    try {
      const t = randomUUID(),
        frozen = await freeze(s, a, t);
      let refusal;
      if (kind === "burn-relabelled") {
        await move(s, a, t);
        const burn = await call(b, "discard", { transferId: t });
        assert.equal(burn.status, 200);
        const r = await call(s, "abort", { transferId: t, destination: a.url, discarded: burn.data });
        refusal = r.status === 200 ? undefined : r.data.error;
        if (r.status === 200) await state(s, (x) => x.state === "active" && !x.dormant);
      }
      if (kind === "resume-at-b") {
        await move(s, a, t);
        const r = await move(s, b, t);
        refusal = r.status === 200 ? undefined : r.data.error;
        const activation = await state(a);
        const release = await call(s, "release", { transferId: t, destination: a.url, activation });
        assert.equal(release.status, 200, JSON.stringify(release));
        await state(s, (x) => x.state === "released" && x.dormant);
      }
      if (kind === "stage-b-abort-a") {
        const stage = await move(s, b, t, false);
        const burn = await call(a, "discard", { transferId: t });
        assert.equal(burn.status, 200);
        const r = await call(s, "abort", { transferId: t, destination: a.url, discarded: burn.data });
        assert.equal(r.status, 200, JSON.stringify(r));
        await state(s, (x) => x.state === "active" && !x.dormant);
        const applied = await call(b, "apply", { transferId: t });
        if (applied.status === 200)
          await state(b, (x) => x.state === "active" && !x.dormant && x.transferId === t);
        refusal =
          stage.status === 200 ? (applied.status === 200 ? undefined : applied.data.error) : stage.data.error;
      }
      const readings = await Promise.all([state(s), state(a), state(b)]);
      const active = readings.filter((x) => x.state === "active" && x.selfId === frozen.selfId).length;
      const row = {
        kind,
        legacyIdPreserved: frozen.selfId === s.legacyId,
        active,
        refusal,
        states: readings.map((x, i) => ({
          body: ["S", "A", "B"][i],
          selfId: x.selfId,
          state: x.state,
          dormant: x.dormant,
        })),
      };
      report.cases.push(row);
      await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
      console.log(JSON.stringify(row));
    } finally {
      await Promise.all([s, a, b].map(stop));
    }
  }
  const s = await make("cli-roundtrip", "S"),
    a = await make("cli-roundtrip", "A");
  try {
    const sourceToken = join(s.dir, "operator-token"),
      destinationToken = join(a.dir, "operator-token");
    await writeFile(sourceToken, s.env.CLANKIE_OPERATOR_TOKEN, { mode: 0o600 });
    await writeFile(destinationToken, a.env.CLANKIE_OPERATOR_TOKEN, { mode: 0o600 });
    const cli = async (from, to, fromToken, toToken) => {
      const result = await execFileAsync(
        process.execPath,
        [
          join(repo, "apps/tui/bin/clankie.ts"),
          "transfer",
          "--from",
          from.url,
          "--to",
          to.url,
          "--from-token-file",
          fromToken,
          "--to-token-file",
          toToken,
          "--transfer-id",
          randomUUID(),
        ],
        { cwd: repo, env: { PATH: process.env.PATH, LANG: process.env.LANG, ...from.env }, timeout: 180_000 },
      );
      return JSON.parse(result.stdout.trim().split("\n").at(-1));
    };
    const out = await cli(s, a, sourceToken, destinationToken);
    assert.equal(out.destination.selfId, s.legacyId);
    assert.equal(out.source.state, "released");
    const back = await cli(a, s, destinationToken, sourceToken);
    assert.equal(back.destination.selfId, s.legacyId);
    assert.equal(back.destination.epoch, 5);
    assert.equal(back.source.state, "released");
    const row = { kind: "cli-roundtrip", legacyIdPreserved: true, active: 1, epoch: back.destination.epoch };
    report.cases.push(row);
    console.log(JSON.stringify(row));
  } finally {
    await Promise.all([s, a].map(stop));
  }
  assert(
    report.cases.every((x) => x.active === 1),
    "one self became active in two bodies",
  );
} finally {
  await Promise.all(all.map(stop));
  report.processes = all.map((b) => ({
    body: b.name,
    pids: b.pids,
    stopped: !b.child || b.child.exitCode !== null || b.child.signalCode !== null,
  }));
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
