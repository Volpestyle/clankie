import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONVENTION_FILE, discoverConvention, type CommandRunner } from "../src/convention.ts";
import { ConventionNeededError, resolveTracker } from "../src/tracker.ts";

async function repo(files: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "work-repo-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

function runner(outputs: {
  log?: string;
  branches?: string;
  origin?: string;
  issues?: string;
}): CommandRunner {
  return async (command, args) => {
    if (command === "git" && args[0] === "log") return outputs.log ?? "";
    if (command === "git" && args[0] === "branch") return outputs.branches ?? "";
    if (command === "git" && args[0] === "remote") {
      if (outputs.origin === undefined) throw new Error("no origin");
      return outputs.origin;
    }
    if (command === "gh") return outputs.issues ?? "0";
    throw new Error(`unexpected ${command}`);
  };
}

const clock = () => new Date("2026-09-26T12:00:00.000Z");

describe("discovering a repo's convention", () => {
  it("follows Linear when the instructions link a project and history cites a team key", async () => {
    const root = await repo({
      "CLAUDE.md":
        "Issues live in the [Clankie Linear project](https://linear.app/vuhlp/project/clankie-7f2de0de4a75/overview).",
      "docs/adr/0001-x.md": "# x",
    });
    const discovery = await discoverConvention(
      root,
      runner({
        log: "Fix it (VUH-12)\nMore VUH-13\nVUH-14 done\nADR-0001 note",
        origin: "git@github.com:o/r.git",
        issues: "0",
      }),
    );
    expect(discovery.suggestion).toMatchObject({
      backend: "linear",
      linear: { team: "VUH", project: "clankie-7f2de0de4a75" },
      decisions: "docs/adr",
      decidedBy: "discovery",
    });
  });

  it("does not mistake model names or versions for a Linear team", async () => {
    const root = await repo({ "AGENTS.md": "We ship Linear-style gradients." });
    const discovery = await discoverConvention(
      root,
      runner({
        log: "Try GROK-4\nGROK-4 again\nGPT-5 eval\nbump GROK-4",
        branches: "main\nfeature/grok-4-eval",
      }),
    );
    expect(discovery.signals.filter((signal) => signal.kind === "linear")).toEqual([]);
    expect(discovery.suggestion).toMatchObject({ backend: "default" });
  });

  it("finds the Linear team from issue links in the docs", async () => {
    const root = await repo({
      "docs/launch.md":
        "See [VUH-1093](https://linear.app/vuhlp/issue/VUH-1093) and https://linear.app/vuhlp/issue/VUH-1095.",
    });
    expect((await discoverConvention(root, runner({}))).suggestion).toMatchObject({
      backend: "linear",
      linear: { team: "VUH" },
    });
  });

  it("follows GitHub issues when the origin repo uses them", async () => {
    const root = await repo();
    const discovery = await discoverConvention(
      root,
      runner({ origin: "https://github.com/Volpestyle/portfolio.git", issues: "8\n" }),
    );
    expect(discovery.suggestion).toMatchObject({
      backend: "github",
      github: { repo: "Volpestyle/portfolio" },
    });
  });

  it("follows a repo's own item directory", async () => {
    const root = await repo({ "docs/tasks/T-1-a.md": "# a", "docs/tasks/README.md": "# tasks" });
    expect((await discoverConvention(root, runner({}))).suggestion).toMatchObject({
      backend: "markdown",
      directory: "docs/tasks",
    });
  });

  it("asks instead of guessing when two trackers compete, or only a TODO.md exists", async () => {
    const both = await repo({ "docs/tasks/T-1-a.md": "# a" });
    const competing = await discoverConvention(
      both,
      runner({ origin: "git@github.com:o/r.git", issues: "3" }),
    );
    expect(competing.suggestion).toBeUndefined();
    expect(competing.question).toMatch(/more than one place/u);
    const todo = await discoverConvention(await repo({ "TODO.md": "- a" }), runner({}));
    expect(todo.question).toMatch(/single task list/u);
  });

  it("defaults to .clankie/work only when nothing exists", async () => {
    expect((await discoverConvention(await repo(), runner({}))).suggestion).toMatchObject({
      backend: "default",
    });
  });
});

describe("resolving the tracker", () => {
  it("reads without recording, and records only when a write is about to happen", async () => {
    const root = await repo();
    await resolveTracker(root, { run: runner({}), clock });
    expect(existsSync(join(root, CONVENTION_FILE))).toBe(false);
    const resolved = await resolveTracker(root, { run: runner({}), clock }, { record: true });
    expect(resolved.backend.kind).toBe("default");
    expect(JSON.parse(await readFile(join(root, CONVENTION_FILE), "utf8"))).toMatchObject({
      backend: "default",
      decidedBy: "discovery",
      decidedAt: "2026-09-26T12:00:00.000Z",
    });
  });

  it("raises the owner's question rather than picking a tracker", async () => {
    const root = await repo({ "TODO.md": "- a" });
    await expect(resolveTracker(root, { run: runner({}), clock }, { record: true })).rejects.toBeInstanceOf(
      ConventionNeededError,
    );
  });

  it("never creates .clankie/work in a repo that tracks work elsewhere", async () => {
    const root = await repo({ "docs/tasks/T-1-a.md": "# a" });
    const { backend } = await resolveTracker(root, { run: runner({}), clock }, { record: true });
    await backend.create({ title: "New task" });
    expect(existsSync(join(root, ".clankie/work"))).toBe(false);
    expect(existsSync(join(root, CONVENTION_FILE))).toBe(true);
  });
});
