import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const preflight = fileURLToPath(
  new URL("../.agents/skills/clankie-lead/references/preflight-base.sh", import.meta.url),
);

test("preflight isolates clankie-app external workspace packages", async (context) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "clankie-preflight-test."));
  context.after(async () => {
    await rm(fixture, { recursive: true, force: true });
  });

  const app = resolve(fixture, "clankie-app");
  const core = resolve(fixture, "clankie-v2");
  const temporaryParent = resolve(fixture, "preflight-temporary");
  const fakeBin = resolve(fixture, "bin");
  const receiptDirectory = resolve(fixture, "receipt");
  const pnpmLog = resolve(fixture, "pnpm.log");

  await mkdir(resolve(core, "packages/protocol"), { recursive: true });
  await writeFile(resolve(core, "packages/protocol/package.json"), '{"name":"@clankie/protocol"}\n');
  commitRepository(core);

  await mkdir(app, { recursive: true });
  await writeFile(
    resolve(app, "package.json"),
    '{"name":"clankie-app-fixture","scripts":{"check":"true"}}\n',
  );
  await writeFile(
    resolve(app, "pnpm-workspace.yaml"),
    'packages:\n  - "packages/*"\n  - "../clankie-v2/packages/protocol"\n',
  );
  commitRepository(app);

  await mkdir(fakeBin, { recursive: true });
  const fakePnpm = resolve(fakeBin, "pnpm");
  await writeFile(
    fakePnpm,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf "%s\\n" "$1 $(pwd -P)" >>"$TEST_PNPM_LOG"',
      'printf "core %s\\n" "$(cd ../clankie-v2 && pwd -P)" >>"$TEST_PNPM_LOG"',
      'if [[ "$1" == "install" ]]; then',
      "  mkdir -p ../clankie-v2/packages/protocol/node_modules",
      "  touch ../clankie-v2/packages/protocol/node_modules/preflight-test-marker",
      'elif [[ "$1" != "check" ]]; then',
      "  exit 64",
      "fi",
      "",
    ].join("\n"),
  );
  await chmod(fakePnpm, 0o755);
  await mkdir(temporaryParent, { recursive: true });

  const result = spawnSync("bash", [preflight, "--receipt-dir", receiptDirectory, "HEAD"], {
    cwd: app,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      CLANKIE_PREFLIGHT_CORE_ROOT: core,
      CLANKIE_PREFLIGHT_TMPDIR: temporaryParent,
      TEST_PNPM_LOG: pnpmLog,
    },
  });
  assert.equal(result.status, 0, result.stderr);

  const receipt = JSON.parse(await readFile(resolve(receiptDirectory, "preflight.json"), "utf8"));
  assert.equal(receipt.verdict, "green");
  assert.equal(receipt.external_workspace.kind, "clankie-v2");
  assert.equal(
    receipt.commands.some((command) => command.command === "pnpm check" && command.exit_code === 0),
    true,
  );

  const log = await readFile(pnpmLog, "utf8");
  assert.match(log, /install .*clankie-base-preflight\..*\/worktree/u);
  assert.match(log, /core .*clankie-base-preflight\..*\/clankie-v2/u);
  await assert.rejects(access(resolve(core, "packages/protocol/node_modules/preflight-test-marker")));
});

function commitRepository(repository) {
  for (const arguments_ of [
    ["init", "-q", "-b", "main"],
    ["config", "user.name", "Clankie Test"],
    ["config", "user.email", "test@clankie.invalid"],
    ["add", "."],
    ["commit", "-q", "-m", "fixture"],
  ]) {
    const result = spawnSync("git", arguments_, { cwd: repository, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
}
