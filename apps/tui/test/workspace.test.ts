import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  conversationWorkspace,
  launchWorkspace,
  resolveWorkspacePath,
  workspaceRoot,
} from "../src/session/workspace.ts";
import type { OperatorConversation } from "@clankie/protocol";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A checkout with a nested subdirectory, plus a sibling that is not a repo. */
async function fixture(): Promise<{ repo: string; nested: string; loose: string }> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "clankie-workspace-")));
  roots.push(root);
  const repo = join(root, "project");
  const nested = join(repo, "apps", "web");
  const loose = join(root, "loose");
  await mkdir(nested, { recursive: true });
  await mkdir(loose, { recursive: true });
  await writeFile(join(repo, ".git"), "gitdir: elsewhere\n", "utf8");
  return { repo, nested, loose };
}

describe("console workspace resolution", () => {
  it("takes the checkout root from anywhere inside it, and the directory itself otherwise", async () => {
    const { repo, nested, loose } = await fixture();
    expect(workspaceRoot(nested)).toBe(repo);
    expect(workspaceRoot(repo)).toBe(repo);
    expect(workspaceRoot(loose)).toBe(loose);
  });

  it("has no workspace inside the service repo, so that launch stays global", async () => {
    const { repo, nested, loose } = await fixture();
    expect(launchWorkspace(nested, repo)).toBeUndefined();
    expect(launchWorkspace(repo, repo)).toBeUndefined();
    expect(launchWorkspace(loose, repo)).toBe(loose);
    // A sibling whose path merely starts with the repo's is a different project.
    expect(launchWorkspace(`${repo}-fork`, repo)).toBe(`${repo}-fork`);
  });

  it("resolves an operator-typed path against the workspace and refuses a non-directory", async () => {
    const { repo, nested } = await fixture();
    await writeFile(join(repo, "README.md"), "# hi\n", "utf8");
    expect(resolveWorkspacePath("apps/web", repo)).toBe(repo);
    expect(resolveWorkspacePath(nested, repo)).toBe(repo);
    expect(() => resolveWorkspacePath("README.md", repo)).toThrow(/is not a directory/u);
    expect(() => resolveWorkspacePath("nope", repo)).toThrow(/is not a directory/u);
  });

  it("reads the working directory off a conversation's scope", () => {
    const base: OperatorConversation = {
      schemaVersion: 1,
      conversationId: "c",
      scope: { kind: "global" },
      title: "Clankie",
      isDefault: true,
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
      sessionState: "waiting",
      revision: 0,
    };
    expect(conversationWorkspace(base)).toBeUndefined();
    expect(
      conversationWorkspace({ ...base, scope: { kind: "workspace", workspaceId: "/repos/thing" } }),
    ).toBe("/repos/thing");
  });
});
