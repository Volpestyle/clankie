import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { evidenceIssueKeys, splitEvidenceIssueKeys } from "@clankie/protocol/evidence";
import { evidenceRoots } from "./evidence.ts";

const exec = promisify(execFile);

/** Local repair of records only. Dry runs open SQLite read-only and never open blobs. */
export async function evidenceBackfill(input: { database: string; repo: string; apply?: boolean }) {
  const repo = await realpath(input.repo);
  const git = async (args: string[]) =>
    (await exec("git", ["-C", repo, "--literal-pathspecs", ...args])).stdout.trim();
  if ((await realpath(await git(["rev-parse", "--show-toplevel"]))) !== repo)
    throw new Error("--repo must name the repository root");
  const roots = (await evidenceRoots(repo)).map((root) => resolve(repo, root));
  const remote = await git(["remote", "get-url", "origin"]).catch(() => "");
  const database = await realpath(input.database);
  const db = new DatabaseSync(database, { readOnly: !input.apply });
  try {
    const rows = db
      .prepare("SELECT id,file_name,issue_key,details FROM records ORDER BY id")
      .all() as unknown as {
      id: string;
      file_name: string;
      issue_key: string | null;
      details: string;
    }[];
    const changes: {
      id: string;
      fileName: string;
      before: string[];
      after: string[];
      source: string;
      original: (typeof rows)[number];
    }[] = [];
    let skippedRepo = 0;
    let unkeyedBefore = 0;
    let multiKeyBefore = 0;
    for (const row of rows) {
      const details = JSON.parse(row.details);
      const before: string[] = details.issueKeys ?? splitEvidenceIssueKeys(row.issue_key ?? undefined);
      if (!before.length) unkeyedBefore++;
      if (splitEvidenceIssueKeys(row.issue_key ?? undefined).length > 1) multiKeyBefore++;
      let after = before;
      let source = "existing keys";
      if (!before.length) {
        // Never use this checkout's README/history for another repository's records.
        if (details.repo && details.repo !== remote && details.repo !== repo) {
          skippedRepo++;
          continue;
        }
        if (isAbsolute(row.file_name) || row.file_name.split(/[\\/]/u).includes("..")) continue;
        const file = resolve(repo, row.file_name);
        if (relative(repo, file).startsWith("..")) continue;
        const root = roots.find((candidate) => file.startsWith(`${candidate}/`));
        if (!root) continue;
        let folder = dirname(file);
        let historyReadme = join(folder, "README.md");
        while (folder !== root) {
          const readme = join(folder, "README.md");
          const resolved = await realpath(readme).catch(() => undefined);
          if (resolved && !relative(repo, resolved).startsWith("..")) {
            historyReadme = readme;
            after = evidenceIssueKeys(await readFile(resolved, "utf8"));
            if (after.length) source = relative(repo, readme);
            break;
          }
          folder = dirname(folder);
        }
        if (!after.length) {
          // Most recent path-specific commit that names an issue, not the current branch.
          const history = await git([
            "log",
            "-n",
            "50",
            "--format=%H%n%B%x00",
            "--",
            row.file_name,
            relative(repo, historyReadme),
          ]);
          for (const entry of history.split("\0")) {
            const [commit, ...message] = entry.trim().split("\n");
            after = evidenceIssueKeys(message.join("\n"));
            if (after.length) {
              source = `git history ${commit}`;
              break;
            }
          }
        }
      }
      if (
        after.length &&
        (row.issue_key !== after[0] || JSON.stringify(details.issueKeys) !== JSON.stringify(after))
      )
        changes.push({ id: row.id, fileName: row.file_name, before, after, source, original: row });
    }
    if (input.apply) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const update = db.prepare(
          "UPDATE records SET issue_key=?,details=? WHERE id=? AND issue_key IS ? AND details=?",
        );
        for (const change of changes) {
          const row = change.original;
          const result = update.run(
            change.after[0]!,
            JSON.stringify({ ...JSON.parse(row.details), issueKeys: change.after }),
            row.id,
            row.issue_key,
            row.details,
          );
          if (Number(result.changes) !== 1)
            throw new Error(`Record ${row.id} changed since the scan; rerun the dry run`);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    const filled = changes.filter((change) => !change.before.length).length;
    return {
      dryRun: !input.apply,
      database,
      repo,
      records: rows.length,
      changed: changes.length,
      filled,
      split: multiKeyBefore,
      skippedRepo,
      before: { unkeyed: unkeyedBefore, multiKey: multiKeyBefore },
      after: { unkeyed: unkeyedBefore - filled, multiKey: 0 },
      changes: changes.map(({ original: _, ...change }) => change),
      summary: `${input.apply ? "Applied" : "Dry run"}: ${rows.length} records; ${changes.length} changes, ${filled} unkeyed filled, ${multiKeyBefore} multi-key strings split; unkeyed ${unkeyedBefore} -> ${unkeyedBefore - filled}. Blobs untouched.`,
    };
  } finally {
    db.close();
  }
}
