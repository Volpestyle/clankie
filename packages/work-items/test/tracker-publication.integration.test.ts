import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

// LOCAL-VUH-50: a real journal, shared backend instances and another process. The only
// injected behavior is holding the real FileHandle.sync, or making that one sync fail.
it("publishes local appends to waiting metadata readers, releases failed appends and validates external changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "tracker-publication-"));
  const source = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: "test", HOME: join(root, "home") };
  for (const kind of ["CONFIG", "STATE", "DATA", "CACHE"])
    env[`XDG_${kind}_HOME`] = join(root, kind.toLowerCase());
  env.XDG_RUNTIME_DIR = join(root, "runtime");
  for (const value of Object.values(env))
    if (value?.startsWith(root)) await mkdir(value, { recursive: true });
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { join } from "node:path";
      import { execFile } from "node:child_process";
      import { promisify } from "node:util";
      const source = ${JSON.stringify(source)};
      const directory = ${JSON.stringify(join(root, "tracker"))};
      const { createLocalTracker } = await import(source);
      const writer = createLocalTracker({ directory });
      const project = await writer.call("save_project", { name: "Initial", addTeams: ["LOCAL"] });
      for (let n = 0; !fs.existsSync(join(directory, "tracker.journal")); n++)
        await writer.call("save_issue", { team: "LOCAL", project: project.id,
          title: "journal " + n, description: "x".repeat(300 * 1024) });
      await writer.checkpoint();
      const reader = createLocalTracker({ directory });
      await reader.referenceProjects([project.id]);
      const storeId = await reader.projectStoreId(project.id);
      const checkpoint = join(directory, "tracker.json");
      const journal = join(directory, "tracker.journal");
      const live = () => join(journal, fs.readdirSync(journal).filter(name => name.endsWith(".jsonl")).sort().at(-1));
      const originalRead = fs.promises.readFile;
      const originalOpen = fs.promises.open;
      let checkpointReads = 0;
      fs.promises.readFile = (...args) => {
        if (String(args[0]) === checkpoint) checkpointReads++;
        return originalRead(...args);
      };
      syncBuiltinESMExports();
      assert.equal((await import("node:fs/promises")).readFile, fs.promises.readFile);
      const results = {};
      for (const fail of [false, true]) {
        let entered, release;
        const atSync = new Promise(resolve => { entered = resolve; });
        const proceed = new Promise(resolve => { release = resolve; });
        let held = false, late;
        fs.promises.open = async (...args) => {
          const handle = await originalOpen(...args);
          if (String(args[0]) === live() && args[1] === "r+" && !held) {
            held = true;
            const sync = handle.sync.bind(handle);
            handle.sync = async () => {
              // Bytes already reached the real journal. The cached generation still precedes them.
              entered();
              await proceed;
              if (fail) throw Object.assign(new Error("Injected append fsync EIO"), { code: "EIO" });
              return sync();
            };
          }
          return handle;
        };
        syncBuiltinESMExports();
        checkpointReads = 0;
        const name = fail ? "Must not publish" : "Published under concurrency";
        const saving = writer.call("save_project", { id: project.id, name }, {
          // Metadata checks run before disk dispatch: waiting for the entire write would deadlock.
          beforeWrite: async () => assert.equal(await reader.projectStoreId(project.id), storeId),
          effectConfirmed: () => { late = reader.referenceProjects([name]); },
        }).then(value => ({ value }), error => ({ error }));
        await atSync;
        let settled = 0;
        const names = reader.referenceProjects([name]).finally(() => { settled++; });
        const identity = reader.projectStoreId(project.id).finally(() => { settled++; });
        release();
        const outcome = await saving;
        const [owners, id] = await Promise.all([names, identity]);
        fs.promises.open = originalOpen;
        syncBuiltinESMExports();
        assert.equal(id, storeId);
        if (fail) {
          assert.equal(outcome.error?.code, "EIO");
          assert.equal(owners.has(name.toLowerCase()), false);
          // A failed append may need revalidation after truncation; it must release every waiter.
          await writer.call("save_project", { id: project.id, name: "Recovered after EIO" });
          assert.deepEqual([...(await reader.referenceProjects(["Recovered after EIO"])).values()][0], new Set([project.id]));
          results.failure = { readersReleased: settled === 2, recovered: true };
        } else {
          assert.equal(outcome.error, undefined);
          assert.deepEqual(owners.get(name.toLowerCase()), new Set([project.id]));
          assert.deepEqual((await late).get(name.toLowerCase()), new Set([project.id]), "reader at effectConfirmed is woken too");
          assert.equal(checkpointReads, 0, "local append must not reread the checkpoint");
          results.success = { checkpointReads, earlyReaders: settled, lateReader: true };
        }
      }
      checkpointReads = 0;
      // Another real process commits: the old process must validate and see the new journal tail.
      await promisify(execFile)(process.execPath, ["--input-type=module", "-e",
        "const {createLocalTracker}=await import(" + JSON.stringify(source) + ");" +
        "await createLocalTracker({directory:" + JSON.stringify(directory) + "}).call('save_project'," +
        JSON.stringify({ id: project.id, name: "External commit" }) + ");"], { env: process.env });
      assert.deepEqual((await reader.referenceProjects(["External commit"])).get("external commit"), new Set([project.id]));
      assert.ok(checkpointReads > 0, "external generation was read and validated");
      results.external = { validated: true };
      const segment = live(), valid = await originalRead(segment);
      await fs.promises.appendFile(segment, '{"syncId":999999,"commit":{}}\n');
      await assert.rejects(reader.referenceProjects([project.id]));
      await assert.rejects(reader.projectStoreId(project.id));
      await fs.promises.writeFile(segment, valid);
      assert.equal(await reader.projectStoreId(project.id), storeId);
      await fs.promises.writeFile(checkpoint, "{}");
      await assert.rejects(reader.referenceProjects([project.id]));
      await assert.rejects(reader.projectStoreId(project.id));
      assert.equal(await originalRead(checkpoint, "utf8"), "{}", "reads never heal damaged storage");
      results.external.journalDamageRefused = true;
      results.external.checkpointDamageRefused = true;
      fs.promises.readFile = originalRead;
      syncBuiltinESMExports();
      process.stdout.write(JSON.stringify(results));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
      env,
      timeout: 15_000,
      maxBuffer: 1 << 20,
    });
    expect(JSON.parse(stdout)).toEqual({
      success: { checkpointReads: 0, earlyReaders: 2, lateReader: true },
      failure: { readersReleased: true, recovered: true },
      external: { validated: true, journalDamageRefused: true, checkpointDamageRefused: true },
    });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10 });
  }
}, 20_000);
