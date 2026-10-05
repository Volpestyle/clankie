import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { createFilesBackend } from "../src/backends/files.ts";
import { createRepoTracker } from "../src/tracker-repo.ts";

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "tracker-repo-lock-"));
  await mkdir(join(root, "tasks"));
  for (const id of ["T-1", "T-2"])
    await writeFile(
      join(root, "tasks", `${id}.md`),
      `---\nid: ${id}\ntitle: ${id}\nstatus: todo\n---\nOwner body.\n`,
    );
  const directory = join(root, "metadata");
  const backend = createFilesBackend({ root, directory: "tasks", kind: "markdown" });
  return { root, directory, backend, tracker: createRepoTracker({ backend, directory }) };
}

/** Independent Node processes invoke the real repo tools and filesystem backend. */
function writer(root: string, directory: string, id: string, project: string, hold: boolean) {
  const code = `
    import { createFilesBackend } from ${JSON.stringify(new URL("../src/backends/files.ts", import.meta.url).pathname)};
    import { createRepoTracker } from ${JSON.stringify(new URL("../src/tracker-repo.ts", import.meta.url).pathname)};
    const [root, directory, id, project, hold] = process.argv.slice(1);
    const backend = createFilesBackend({root, directory: "tasks", kind: "markdown"});
    const tracker = createRepoTracker({backend, directory, async beforeWrite() {
      process.send({phase: "prepared"});
      if (hold === "yes") await new Promise(resolve => process.once("message", resolve));
    }});
    process.send({phase: "ready"});
    try {
      await tracker.call("save_issue", {id, project, dueDate: id === "T-1" ? "2026-10-06" : "2026-10-07"});
      process.send({phase: "done"});
    } catch (error) {
      process.send({phase: "failed", error: String(error)});
      process.exitCode = 1;
    } finally { process.disconnect(); }
  `;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", code, root, directory, id, project, hold ? "yes" : "no"],
    {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  const phases = new Set<string>();
  const listeners = new Map<string, () => void>();
  child.on("message", (message: { phase: string; error?: string }) => {
    phases.add(message.phase);
    if (message.error !== undefined) stderr += message.error;
    listeners.get(message.phase)?.();
  });
  const completed = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.on("error", (error) => {
      stderr += error.message;
      resolve({ code: 1, stderr });
    });
    child.on("exit", (code) => resolve({ code, stderr }));
  });
  return {
    child,
    phases,
    completed,
    reached(phase: string): Promise<void> {
      if (phases.has(phase)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Writer did not reach ${phase}: ${stderr}`)), 5_000);
        listeners.set(phase, () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

it("serializes repo metadata read/modify/publish across real tool processes without locking ancillary records", async () => {
  const f = await repository();
  const children: ChildProcess[] = [];
  try {
    const project = (await f.tracker.call("save_project", {
      name: "Local project",
      addTeams: ["LOCAL"],
    })) as { id: string };
    const first = writer(f.root, f.directory, "T-1", project.id, true);
    children.push(first.child);
    await first.reached("prepared");
    expect(existsSync(join(f.directory, "repo-issues.json.lock"))).toBe(true);
    // The first call resolved its project under ancillary/tracker.json's distinct lock.
    expect(existsSync(join(f.directory, "ancillary", "tracker.json.lock"))).toBe(false);
    const second = writer(f.root, f.directory, "T-2", project.id, false);
    children.push(second.child);
    await second.reached("ready");
    await delay(150);
    expect(second.phases.has("prepared")).toBe(false);
    first.child.send("release");
    expect(await first.completed).toEqual({ code: 0, stderr: "" });
    expect(await second.completed).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(await readFile(join(f.directory, "repo-issues.json"), "utf8"))).toEqual({
      "T-1": { projectId: project.id, dueDate: "2026-10-06" },
      "T-2": { projectId: project.id, dueDate: "2026-10-07" },
    });
    expect(await f.tracker.call("get_issue", { id: "T-1" })).toMatchObject({
      projectId: project.id,
      dueDate: "2026-10-06",
    });
    expect(await f.tracker.call("get_issue", { id: "T-2" })).toMatchObject({
      projectId: project.id,
      dueDate: "2026-10-07",
    });
    expect(await readdir(f.directory)).toEqual(["ancillary", "repo-issues.json"]);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await rm(f.root, { recursive: true, force: true });
  }
});

it("keeps the repo metadata fence immediately before rename and releases its lock and temporary file on refusal", async () => {
  const f = await repository();
  try {
    await f.tracker.call("save_issue", { id: "T-1", dueDate: "2026-10-06" });
    const path = join(f.directory, "repo-issues.json");
    const before = await readFile(path, "utf8");
    const hooks: string[] = [];
    const refused = createRepoTracker({
      backend: f.backend,
      directory: f.directory,
      async beforeWrite() {
        expect(existsSync(`${path}.lock`)).toBe(true);
        expect((await readdir(f.directory)).some((name) => name.endsWith(".tmp"))).toBe(true);
        throw new Error("Owner authority revoked");
      },
      onDispatch: () => {
        hooks.push("dispatch");
      },
      effectConfirmed: () => {
        hooks.push("confirmed");
      },
    });
    await expect(refused.call("save_issue", { id: "T-1", dueDate: "2026-10-07" })).rejects.toThrow(
      "Owner authority revoked",
    );
    expect(await readFile(path, "utf8")).toBe(before);
    expect(hooks).toEqual([]);
    expect(await readdir(f.directory)).toEqual(["repo-issues.json"]);
    await f.tracker.call("save_issue", { id: "T-1", dueDate: "2026-10-08" });
    expect(await f.tracker.call("get_issue", { id: "T-1" })).toMatchObject({ dueDate: "2026-10-08" });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
