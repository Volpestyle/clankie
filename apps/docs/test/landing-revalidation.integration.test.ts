import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { changePatchId, sourceFingerprint } from "../../../scripts/testing/landing-validity.mjs";

// VUH-2024: a green landing gate survives a base move that touches nothing it
// checked. Real git history and the real gate entrypoint; the recorded gate is
// written with the same functions the gate uses, standing in for a 4-minute run.

const gate = fileURLToPath(new URL("../../../scripts/check-landing.mjs", import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository() {
  const root = mkdtempSync(join(tmpdir(), "landing-revalidate-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const commit = (message: string) => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "gate@example.invalid");
  git("config", "user.name", "Gate");
  git("config", "commit.gpgsign", "false");
  write(".gitignore", "/.local/\n");
  write("package.json", "{}\n");
  write("apps/one/src/changed.ts", "export const changed = 1;\n");
  write("apps/one/src/imported.ts", "export const imported = 1;\n");
  write("apps/one/src/compiled.ts", "export const compiled = 1;\n");
  write("apps/two/src/unrelated.ts", "export const unrelated = 1;\n");
  write("docs/guide.md", "# Guide\n");
  const base = commit("base");
  // The change under test, rebased onto base and gated there.
  git("checkout", "-q", "-b", "change");
  write("apps/one/src/changed.ts", "export const changed = 2;\n");
  const head = commit("change");
  return { root, git, write, commit, base, head };
}

async function recordGreenGate(
  root: string,
  base: string,
  head: string,
  extra: Record<string, unknown> = {},
) {
  const report = {
    head,
    base,
    source: await sourceFingerprint(root),
    change: { rebased: true, patchId: changePatchId(root, base, head), files: ["apps/one/src/changed.ts"] },
    phases: [],
    typecheckScope: {
      reason: "real compiler import graph",
      affectedInputs: ["apps/one/src/changed.ts", "apps/one/src/compiled.ts"],
    },
    tests: {
      testModules: ["apps/one/test/changed.test.ts"],
      dependencies: ["apps/one/test/changed.test.ts", "apps/one/src/changed.ts", "apps/one/src/imported.ts"],
    },
    exitCode: 0,
    sourceStable: true,
    ...extra,
  };
  mkdirSync(join(root, ".local"), { recursive: true });
  writeFileSync(join(root, ".local/landing-gate.json"), JSON.stringify(report));
}

/** main moves by one commit, and the change is rebased onto it, as a landing worker does. */
function moveMainAndRebase(repo: ReturnType<typeof repository>, edit: () => void) {
  repo.git("checkout", "-q", "main");
  edit();
  const moved = repo.commit("someone else lands");
  repo.git("checkout", "-q", "change");
  repo.git("rebase", "-q", "main");
  return moved;
}

function revalidate(root: string, base: string) {
  const result = spawnSync(process.execPath, [gate, "--revalidate", "--root", root, "--base", base], {
    encoding: "utf8",
  });
  const verdict = JSON.parse(result.stdout.slice(0, result.stdout.lastIndexOf("}") + 1));
  return { status: result.status, verdict, stdout: result.stdout };
}

it("keeps a green gate when the incoming commit touches nothing it checked, and records the outcome", async () => {
  const repo = repository();
  await recordGreenGate(repo.root, repo.base, repo.head);
  const moved = moveMainAndRebase(repo, () =>
    repo.write("apps/two/src/unrelated.ts", "export const unrelated = 2;\n"),
  );
  const { status, verdict, stdout } = revalidate(repo.root, moved);
  expect(status).toBe(0);
  expect(verdict).toMatchObject({
    valid: true,
    reasons: [],
    incoming: ["apps/two/src/unrelated.ts"],
    overlaps: [],
  });
  expect(stdout).toContain("push without rerunning");
  const report = JSON.parse(readFileSync(join(repo.root, ".local/landing-gate.json"), "utf8"));
  expect(report.revalidations).toHaveLength(1);
  const history = readFileSync(join(repo.root, ".git/clankie-landing-history.jsonl"), "utf8")
    .trim()
    .split("\n");
  expect(JSON.parse(history.at(-1)!)).toMatchObject({ kind: "revalidate", valid: true, gateHead: repo.head });
});

it.each([
  [
    "a selected test's import",
    "apps/one/src/imported.ts",
    "export const imported = 2;\n",
    "checked input apps/one/src/imported.ts",
  ],
  [
    "a compiler input of an affected file",
    "apps/one/src/compiled.ts",
    "export const compiled = 2;\n",
    "checked input apps/one/src/compiled.ts",
  ],
  [
    "repository-wide configuration",
    "package.json",
    '{"private":true}\n',
    "repository-wide input package.json",
  ],
  [
    "a gate script",
    "scripts/check-landing.mjs",
    "// changed\n",
    "repository-wide input scripts/check-landing.mjs",
  ],
])("forces a rerun when the incoming commit changes %s", async (_name, path, text, reason) => {
  const repo = repository();
  await recordGreenGate(repo.root, repo.base, repo.head);
  const moved = moveMainAndRebase(repo, () => repo.write(path, text));
  const { status, verdict } = revalidate(repo.root, moved);
  expect(status).toBe(1);
  expect(verdict.valid).toBe(false);
  expect(verdict.reasons.join("\n")).toContain(reason);
});

it("forces a rerun when the incoming commit deletes a file", async () => {
  const repo = repository();
  await recordGreenGate(repo.root, repo.base, repo.head);
  const moved = moveMainAndRebase(repo, () => rmSync(join(repo.root, "docs/guide.md")));
  const { status, verdict } = revalidate(repo.root, moved);
  expect(status).toBe(1);
  expect(verdict.reasons).toContain("incoming commit deletes docs/guide.md");
});

it("forces a rerun when the change itself differs from what the gate checked", async () => {
  const repo = repository();
  await recordGreenGate(repo.root, repo.base, repo.head);
  const moved = moveMainAndRebase(repo, () =>
    repo.write("apps/two/src/unrelated.ts", "export const unrelated = 2;\n"),
  );
  repo.write("apps/one/src/changed.ts", "export const changed = 3;\n");
  repo.git("commit", "-q", "-am", "amend after the gate");
  const { status, verdict } = revalidate(repo.root, moved);
  expect(status).toBe(1);
  expect(verdict.reasons).toContain("the change itself differs from the checked change after the rebase");
});

it("refuses a gate that was not green or predates selection recording", async () => {
  const repo = repository();
  await recordGreenGate(repo.root, repo.base, repo.head, { exitCode: 1 });
  expect(revalidate(repo.root, repo.base).verdict.reasons).toContain("the recorded gate was not green");
  await recordGreenGate(repo.root, repo.base, repo.head, { tests: undefined });
  expect(revalidate(repo.root, repo.base).verdict.reasons).toContain(
    "the recorded gate predates selection recording; run the gate",
  );
});
