import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./sync-agent-skills.mjs", import.meta.url));

test("sync validates a skill and creates relative provider links", async (context) => {
  const root = await fixtureRoot(context);
  await writeSkill(root, "valid-skill", {
    markdown: "[Details](references/details.md)\n",
    references: {
      "details.md": "# Details\n",
      "verify.sh": "#!/usr/bin/env bash\nset -euo pipefail\n",
    },
  });

  const sync = run(root);
  assert.equal(sync.status, 0, sync.stderr);

  for (const providerRoot of [".claude/skills", ".pi/agent/skills", ".codex/skills"]) {
    const link = resolve(root, providerRoot, "valid-skill");
    assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.equal(
      await readlink(link),
      relative(resolve(root, providerRoot), resolve(root, ".agents/skills/valid-skill")),
    );
  }

  const check = run(root, "--check");
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /Validated 1 skills/u);
});

test("validation rejects a frontmatter name that differs from the directory", async (context) => {
  const root = await fixtureRoot(context);
  await writeSkill(root, "valid-skill", { name: "other-skill" });

  const result = run(root, "--check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /frontmatter name must equal its directory/u);
});

test("validation reports broken local links and invalid shell references", async (context) => {
  const root = await fixtureRoot(context);
  await writeSkill(root, "valid-skill", {
    markdown: "[Missing](references/missing.md)\n",
    references: {
      "broken.sh": "#!/usr/bin/env bash\nif then\n",
    },
  });

  const result = run(root, "--check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /links to missing local path/u);
  assert.match(result.stderr, /fails bash -n/u);
});

async function fixtureRoot(context) {
  const root = await mkdtemp(resolve(tmpdir(), "clankie-skill-check."));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(resolve(root, ".agents/skills"), { recursive: true });
  return root;
}

async function writeSkill(root, directoryName, options = {}) {
  const skillDirectory = resolve(root, ".agents/skills", directoryName);
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    resolve(skillDirectory, "SKILL.md"),
    [
      "---",
      `name: ${options.name ?? directoryName}`,
      "description: Fixture skill for validator tests.",
      "---",
      "",
      "# Fixture",
      "",
      options.markdown ?? "",
    ].join("\n"),
  );

  for (const [name, contents] of Object.entries(options.references ?? {})) {
    const path = resolve(skillDirectory, "references", name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
    if (name.endsWith(".sh")) await chmod(path, 0o755);
  }
}

function run(root, ...arguments_) {
  return spawnSync(process.execPath, [script, "--root", root, ...arguments_], {
    encoding: "utf8",
  });
}
