import assert from "node:assert/strict";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, cp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { IntegrationQueue } from "../../../../apps/clankie/src/integrate.ts";
const run = promisify(execFile),
  repo = process.cwd();
const git = async (cwd, ...args) =>
  (
    await run("git", ["-c", "commit.gpgsign=false", "-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024 })
  ).stdout.trim();
const root = await realpath(await mkdtemp(join(tmpdir(), "vuh-2163-real-batch-")));
await writeFile(".local/vuh-2163/root.txt", root);
const receipts = [];
for (const mode of ["flaky", "persistent"]) {
  const directory = join(root, mode),
    source = join(directory, "source"),
    origin = join(directory, "origin.git");
  await mkdir(source, { recursive: true });
  await git(directory, "init", "--bare", origin);
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.name", "VUH2163 proof");
  await git(source, "config", "user.email", "fixture@example.invalid");
  await git(source, "remote", "add", "origin", origin);
  for (const p of [
    "apps/proof/src",
    "apps/proof/test",
    "packages",
    "integrations",
    "scripts/testing",
    "docs/adr",
  ])
    await mkdir(join(source, p), { recursive: true });
  for (const p of [
    "scripts/check-doc-links.mjs",
    "scripts/check-retired-claims.mjs",
    "scripts/testing/evidence-landing-guard.mjs",
    "scripts/testing/landing-graph-reporter.mjs",
    "scripts/testing/release-test-reporter.mjs",
    "docs/adr/retired-claims.json",
  ])
    await cp(join(repo, p), join(source, p));
  for (const p of [
    ".claude/skills",
    ".codex/skills",
    ".agents/skills",
    "integrations/claude-plugin/skills",
  ]) {
    await mkdir(join(source, p), { recursive: true });
    await mkdir(join(source, p, "proof"), { recursive: true });
    await writeFile(join(source, p, "proof/SKILL.md"), "# Proof skill\n");
  }
  await mkdir(join(source, "packages/proof"), { recursive: true });
  await writeFile(join(source, "packages/proof/README.md"), "# Proof\n");
  await writeFile(join(source, ".gitignore"), "node_modules/\n.local/\n.data/\n");
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      name: "gate-proof",
      private: true,
      type: "module",
      packageManager: "pnpm@11.11.0",
      devDependencies: { vitest: "4.1.10" },
      scripts: {
        "check:landing": "node gate.mjs",
        "herdr:skill:check": "node --check gate.mjs",
        "fmt:check": "node --check vitest.config.ts",
        lint: "node --check apps/proof/test/flake.test.ts",
        deadcode: "node --check apps/proof/src/one.ts",
      },
    }),
  );
  await writeFile(
    join(source, "vitest.config.ts"),
    `import {defineConfig} from 'vitest/config';export default defineConfig({test:{include:process.env.CLANKIE_RELEASE_RETRY_FILE?[process.env.CLANKIE_RELEASE_RETRY_FILE]:['apps/proof/test/*.test.ts'],pool:'forks',maxWorkers:1,fileParallelism:false}});`,
  );
  // Actual first batch waits at a filesystem barrier so two following requests coalesce.
  const release = join(directory, "release"),
    started = join(directory, "started"),
    ledger = join(directory, "gates.jsonl");
  await writeFile(
    join(source, "gate.mjs"),
    `import {existsSync,writeFileSync,appendFileSync} from 'node:fs';import {spawnSync,execFileSync} from 'node:child_process';import {setTimeout as delay} from 'node:timers/promises';
 appendFileSync(${JSON.stringify(ledger)},JSON.stringify({head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()})+'\\n');
 writeFileSync(${JSON.stringify(started)},'ready');while(!existsSync(${JSON.stringify(release)}))await delay(50);
 const result=spawnSync(process.execPath,[${JSON.stringify(join(repo, "scripts/check-landing.mjs"))},'--root',process.cwd(),...process.argv.slice(2)],{stdio:'inherit',env:process.env});process.exitCode=result.status??1;`,
  );
  await writeFile(join(source, "apps/proof/src/one.ts"), "export const one = false;\n");
  await writeFile(join(source, "apps/proof/src/two.ts"), "export const two = false;\n");
  await writeFile(
    join(source, "apps/proof/test/flake.test.ts"),
    `import {it,expect} from 'vitest';import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {one} from '../src/one.ts';mkdirSync('.local',{recursive:true});const p='.local/flake.count';const count=existsSync(p)?Number(readFileSync(p,'utf8'))+1:1;writeFileSync(p,String(count));it('real failing assertion',()=>expect(!one||${mode === "flaky" ? "count>1" : "false"}).toBe(true));`,
  );
  await writeFile(
    join(source, "apps/proof/test/pass.test.ts"),
    `import {it,expect} from 'vitest';import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {two} from '../src/two.ts';mkdirSync('.local',{recursive:true});const p='.local/pass.count';const count=existsSync(p)?Number(readFileSync(p,'utf8'))+1:1;writeFileSync(p,String(count));it('healthy member still checked',()=>expect(typeof two).toBe('boolean'));`,
  );
  await run("pnpm", ["install", "--lockfile-only"], { cwd: source, maxBuffer: 8 * 1024 * 1024 });
  await git(source, "add", ".");
  await git(source, "commit", "-m", "fixture base");
  const base = await git(source, "rev-parse", "HEAD");
  await git(source, "push", "origin", "HEAD:main");
  await writeFile(join(source, "apps/proof/src/one.ts"), "export const one = true;\n");
  await git(source, "add", "apps/proof/src/one.ts");
  await git(source, "commit", "-m", "member one");
  const one = await git(source, "rev-parse", "HEAD");
  await writeFile(join(source, "apps/proof/src/two.ts"), "export const two = true;\n");
  await git(source, "add", "apps/proof/src/two.ts");
  await git(source, "commit", "-m", "member two");
  const two = await git(source, "rev-parse", "HEAD");
  const queue = new IntegrationQueue({ core: source, directory: join(directory, "integration") });
  const guard = async () => {};
  const bootstrap = { action: "run", id: randomUUID(), core: [base], push: false };
  await queue.start(bootstrap, guard);
  for (let i = 0; ; i++) {
    if (i > 2400) throw Error("Own batch did not reach barrier");
    try {
      await readFile(started);
      break;
    } catch {
      await delay(50);
    }
  }
  const a = { action: "run", id: randomUUID(), core: [one], push: true },
    b = { action: "run", id: randomUUID(), core: [two], push: true };
  await queue.start(a, guard);
  await queue.start(b, guard);
  await writeFile(release, "go");
  await queue.wait();
  const first = await queue.status(a.id),
    second = await queue.status(b.id);
  const combined = JSON.parse(
    await readFile(
      first.attempts?.[0]
        ? join(directory, "integration/batches", first.attempts[0], "record.json")
        : first.evidence,
      "utf8",
    ),
  );
  assert.equal(combined.members.length, 2);
  assert.equal(combined.repos[0].gate.testRecovery.firstExitCode, 1);
  assert.equal(combined.repos[0].gate.testRecovery.reruns.length, 1);
  const recovery = combined.repos[0].gate.testRecovery;
  assert.equal(recovery.reruns[0].file, "apps/proof/test/flake.test.ts");
  const selected = JSON.parse(await readFile(recovery.firstReport, "utf8")).selected;
  assert.deepEqual(selected.sort(), ["apps/proof/test/flake.test.ts", "apps/proof/test/pass.test.ts"]);
  if (mode === "flaky") {
    assert.equal(first.state, "pushed");
    assert.equal(second.state, "pushed");
    assert.equal(first.batchId, second.batchId);
    assert.equal(combined.isolation, undefined);
    assert.equal(recovery.reruns[0].passed, true);
    assert.deepEqual(recovery.flakyFiles, ["apps/proof/test/flake.test.ts"]);
    assert.equal(await readFile(join(combined.repos[0].directory, ".local/flake.count"), "utf8"), "2");
    assert.equal(await readFile(join(combined.repos[0].directory, ".local/pass.count"), "utf8"), "1");
  } else {
    assert.equal(combined.state, "failed");
    assert.equal(recovery.reruns[0].passed, false);
    assert.equal(first.state, "failed");
    assert.equal(second.state, "pushed");
    assert.ok(first.isolation);
  }
  receipts.push({
    mode,
    first,
    second,
    combined,
    gates: JSON.parse("[" + (await readFile(ledger, "utf8")).trim().split("\n").join(",") + "]"),
  });
  await writeFile(".local/vuh-2163/batch-proof.json", JSON.stringify({ root, receipts }, null, 2));
  console.log(
    JSON.stringify({
      mode,
      combined: combined.id,
      state: combined.state,
      first: first.state,
      second: second.state,
      recovery,
    }),
  );
}
console.log(
  "REAL BATCH PROOF PASSED: recovered shared tree lands without isolation; repeated failure blocks and isolates.",
);
