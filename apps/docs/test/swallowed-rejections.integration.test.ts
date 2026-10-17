import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";

// VUH-2396 acceptance: the landing gate's check stops new silently swallowed
// rejections in changed lines and leaves existing ones alone. Real git history,
// the real script.
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository() {
  const root = mkdtempSync(join(tmpdir(), "swallowed-rejections-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "gate@example.invalid");
  git("config", "user.name", "Gate");
  git("config", "commit.gpgsign", "false");
  mkdirSync(join(root, "scripts"));
  copyFileSync(
    new URL("../../../scripts/check-swallowed-rejections.mjs", import.meta.url),
    join(root, "scripts/check-swallowed-rejections.mjs"),
  );
  write(
    "apps/one/src/old.ts",
    "export const old = () => load().catch(() => undefined);\nexport const a = 1;\n",
  );
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  const check = () =>
    spawnSync(process.execPath, [join(root, "scripts/check-swallowed-rejections.mjs"), base], {
      cwd: root,
      encoding: "utf8",
    });
  return { write, check };
}

it("leaves existing sites alone and passes an explained new one", () => {
  const { write, check } = repository();
  write(
    "apps/one/src/old.ts",
    [
      "export const old = () => load().catch(() => undefined);",
      "export const a = 2;",
      "// allow-swallowed-rejection -- the socket already closed; nobody waits on it",
      "export const closed = () => socket.end().catch(() => {});",
      "export const quiet = () => ping().catch(() => null); // allow-swallowed-rejection -- best-effort ping",
      "",
    ].join("\n"),
  );
  write("apps/one/test/old.test.ts", "afterEach(() => server.close().catch(() => undefined));\n");
  const result = check();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

it("rejects a new silent swallow in a changed or untracked file and names the line", () => {
  const { write, check } = repository();
  write(
    "apps/one/src/old.ts",
    "export const old = () => load().catch(() => undefined);\nexport const a = 1;\n\nexport const b = () => run().catch((_error) => {});\n",
  );
  write("apps/one/src/new.ts", "export const c = () => run().catch(() => null);\n");
  const result = check();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "- apps/one/src/old.ts:4: export const b = () => run().catch((_error) => {});",
  );
  expect(result.stderr).toContain("- apps/one/src/new.ts:1: export const c = () => run().catch(() => null);");
  expect(result.stderr).not.toContain("old.ts:1");
});
