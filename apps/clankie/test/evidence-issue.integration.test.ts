import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { expect, it } from "vitest";
import { EvidenceStore, createEvidenceRoutes } from "../src/evidence-store.ts";
import { runEvidenceCommand, callEvidenceTool } from "../../tui/src/command/evidence.ts";
import { evidenceBackfill } from "../../tui/src/command/evidence-backfill.ts";

const exec = promisify(execFile);
// Inferred keys carry this repo's tracker team or the built-in LOCAL prefix (VUH-1997).
const CONVENTION = JSON.stringify({
  schemaVersion: 1,
  backend: "linear",
  linear: { team: "VUH" },
  decidedBy: "owner",
  decidedAt: "2026-10-09T00:00:00Z",
});
const actor = { kind: "operator" as const, id: "integration", onBehalfOf: [] };

it("infers push keys in precedence order across real git, HTTP, SQLite and disk blobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-issue-"));
  const repo = join(root, "vuh-1952");
  await mkdir(join(repo, "docs/testing/proof"), { recursive: true });
  await mkdir(join(repo, ".clankie"));
  await writeFile(join(repo, ".clankie/tracking.json"), CONVENTION);
  const git = async (...args: string[]) => exec("git", ["-C", repo, ...args]);
  await git("init", "-b", "clankie2/vuh-1951-proof");
  await git(
    "-c",
    "user.name=Integration",
    "-c",
    "user.email=integration@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  );
  const folder = join(repo, "docs/testing/proof");
  await writeFile(join(folder, "README.md"), "VUH-1954 VUH-1955\n");
  const store = EvidenceStore.local(join(root, "store"));
  const app = createEvidenceRoutes(store, async (request) =>
    request.headers.get("authorization") === "Bearer integration" ? actor : undefined,
  );
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const options = {
    cwd: repo,
    host: `http://127.0.0.1:${address.port}`,
    env: { CLANKIE_OPERATOR_TOKEN: "integration" },
    stderr: { write() {} },
  };
  try {
    const push = async (expected: string, source: string, extra: string[] = []) => {
      await writeFile(join(folder, `${source}.txt`), expected.repeat(4000));
      const result = await runEvidenceCommand(["push", "docs/testing/proof", ...extra], options);
      expect(result.ok, JSON.stringify(result.body)).toBe(true);
      expect(result.body).toMatchObject({ issueKey: expected, issueSource: source, uploaded: 1 });
      expect(await store.list({ issueKey: expected.split(" ")[0]! })).not.toHaveLength(0);
    };
    await push("VUH-1951", "branch");
    await git("checkout", "-b", "plain");
    await push("VUH-1952", "worktree directory");
    const plain = join(root, "plain");
    // A real rename changes the worktree fallback without changing its git history.
    const { rename } = await import("node:fs/promises");
    await rename(repo, plain);
    options.cwd = plain;
    await writeFile(join(plain, "docs/testing/proof/proof.txt"), "readme".repeat(4000));
    const result = await runEvidenceCommand(["push", "docs/testing/proof"], options);
    expect(result.body).toMatchObject({ issueKey: "VUH-1954 VUH-1955", issueSource: "folder README" });
    const listed = await runEvidenceCommand(["list", "--issue", "VUH-1955"], options);
    expect(listed.body).toMatchObject({
      records: [expect.objectContaining({ issueKey: "VUH-1954" })],
    });
    const metadata = new DatabaseSync(join(root, "store/evidence.sqlite"), { readOnly: true });
    const keyed = metadata.prepare("SELECT details FROM records WHERE issue_key='VUH-1954'").get() as {
      details: string;
    };
    expect(JSON.parse(keyed.details).issueKeys).toEqual(["VUH-1954", "VUH-1955"]);
    metadata.close();
    const recent = await runEvidenceCommand(["list", "--recent", "--issue", "VUH-1955"], options);
    expect(recent.body).toMatchObject({ records: [expect.objectContaining({ issueKey: "VUH-1954" })] });
    await writeFile(join(plain, "docs/testing/proof/explicit.txt"), "explicit".repeat(4000));
    expect(
      (await callEvidenceTool("evidence_push", { path: "docs/testing/proof", issue: "VUH-1999" }, options))
        .isError,
    ).toBeUndefined();
    expect(await store.list({ issueKey: "VUH-1999" })).toHaveLength(1);
    await writeFile(join(plain, "docs/testing/proof/README.md"), "No tracker here\n");
    await writeFile(join(plain, "docs/testing/proof/unkeyed.txt"), "unkeyed".repeat(4000));
    const unkeyed = await runEvidenceCommand(["push", "docs/testing/proof"], options);
    expect(unkeyed.ok).toBe(true);
    expect(unkeyed.body).toMatchObject({ summary: expect.stringContaining("No issue key found") });
  } finally {
    server.close();
    store.close();
  }
});

it("backfills README/history keys and splits legacy strings without changing blobs or receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-backfill-"));
  const git = async (...args: string[]) => exec("git", ["-C", root, ...args]);
  await git("init", "-b", "main");
  await mkdir(join(root, "docs/testing/readme"), { recursive: true });
  await mkdir(join(root, "docs/testing/history"), { recursive: true });
  await mkdir(join(root, ".clankie"));
  await writeFile(join(root, ".clankie/tracking.json"), CONVENTION);
  await writeFile(join(root, "docs/testing/readme/README.md"), "VUH-1951\n");
  await writeFile(join(root, "docs/testing/history/README.md"), "A proof\n");
  await git("add", ".");
  await git(
    "-c",
    "user.name=Integration",
    "-c",
    "user.email=integration@example.invalid",
    "commit",
    "-m",
    "VUH-1954 historical proof",
  );
  const store = EvidenceStore.local(join(root, "store"));
  const bytes = Buffer.from("immutable proof");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  for (const [index, folder] of ["readme", "history", "legacy", "unknown"].entries()) {
    const receipt = await store.upload(actor, {
      idempotencyKey: `integration-key-${index}`,
      sha256,
      size: bytes.length,
      contentType: "text/plain",
      fileName: `docs/testing/${folder}/proof.txt`,
    });
    await store.acceptBlob(
      EvidenceStore.actorKey(actor),
      receipt.receiptId,
      (async function* () {
        yield bytes;
      })(),
    );
  }
  const database = join(root, "store/evidence.sqlite");
  const db = new DatabaseSync(database);
  db.prepare("UPDATE records SET issue_key='VUH-1856 VUH-1875' WHERE file_name LIKE '%legacy%'").run();
  db.prepare("UPDATE records SET details='{}'").run();
  expect(await store.list({ issueKey: "VUH-1875" })).toHaveLength(1);
  expect((await store.metadata.recent({ issue: "VUH-1875", limit: 10 })).records).toHaveLength(1);
  const recordsBefore = db.prepare("SELECT * FROM records").all();
  const uploadsBefore = db.prepare("SELECT * FROM uploads").all();
  const dry = await evidenceBackfill({ database, repo: root });
  expect(dry).toMatchObject({ dryRun: true, filled: 2, split: 1, after: { unkeyed: 1 } });
  expect(db.prepare("SELECT * FROM records").all()).toEqual(recordsBefore);
  const applied = await evidenceBackfill({ database, repo: root, apply: true });
  expect(applied.filled).toBe(2);
  expect(await store.list({ issueKey: "VUH-1951" })).toHaveLength(1);
  expect(await store.list({ issueKey: "VUH-1954" })).toHaveLength(1);
  expect(await store.list({ issueKey: "VUH-1875" })).toHaveLength(1);
  expect(db.prepare("SELECT * FROM uploads").all()).toEqual(uploadsBefore);
  expect(await readFile(join(root, "store/blobs/sha256", sha256.slice(0, 2), sha256))).toEqual(bytes);
  expect((await evidenceBackfill({ database, repo: root, apply: true })).changed).toBe(0);
  db.close();
  store.close();
});

it("infers no key from README noise, prefers explicit references, and backfills by the same rule (VUH-1997)", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-noise-"));
  const repo = join(root, "checkout");
  const git = async (...args: string[]) => exec("git", ["-C", repo, ...args]);
  await mkdir(join(repo, "docs/testing/noise"), { recursive: true });
  await mkdir(join(repo, "docs/testing/explicit"), { recursive: true });
  await mkdir(join(repo, ".clankie"));
  await writeFile(join(repo, ".clankie/tracking.json"), CONVENTION);
  const noise =
    "Hashes are SHA-256, text is UTF-8, judged by GPT-6 and SONNET-5; see POST-0145 and RFC-9110.\n";
  await writeFile(join(repo, "docs/testing/noise/README.md"), `# Round trip\n\n${noise}`);
  await writeFile(
    join(repo, "docs/testing/explicit/README.md"),
    `# Proof\n\nTracks: https://linear.app/vuhlp/issue/VUH-1997/readme-keys\n\n${noise}Builds on VUH-1951.\n`,
  );
  await git("init", "-b", "main");
  await git("add", ".");
  await git(
    "-c",
    "user.name=Integration",
    "-c",
    "user.email=integration@example.invalid",
    "commit",
    "-m",
    "Hash with SHA-256 over UTF-8",
  );
  const store = EvidenceStore.local(join(root, "store"));
  const app = createEvidenceRoutes(store, async (request) =>
    request.headers.get("authorization") === "Bearer integration" ? actor : undefined,
  );
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const options = {
    cwd: repo,
    host: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    env: { CLANKIE_OPERATOR_TOKEN: "integration" },
    stderr: { write() {} },
  };
  try {
    await writeFile(join(repo, "docs/testing/noise/run.txt"), "noise".repeat(4000));
    const unkeyed = await runEvidenceCommand(["push", "docs/testing/noise"], options);
    expect(unkeyed.ok, JSON.stringify(unkeyed.body)).toBe(true);
    expect(unkeyed.body).not.toHaveProperty("issueKey");
    expect(unkeyed.body).toMatchObject({ summary: expect.stringContaining("No issue key found") });
    await writeFile(join(repo, "docs/testing/explicit/run.txt"), "explicit".repeat(4000));
    const explicit = await runEvidenceCommand(["push", "docs/testing/explicit"], options);
    expect(explicit.body).toMatchObject({ issueKey: "VUH-1997", issueSource: "folder README" });

    // Backfill: the unkeyed record stays unkeyed through README and history noise.
    const database = join(root, "store/evidence.sqlite");
    const db = new DatabaseSync(database);
    db.prepare("UPDATE records SET issue_key=NULL, details='{}'").run();
    db.close();
    const dry = await evidenceBackfill({ database, repo });
    expect(dry.changes).toEqual([
      expect.objectContaining({ fileName: "docs/testing/explicit/run.txt", after: ["VUH-1997"] }),
    ]);
    expect(dry).toMatchObject({ dryRun: true, filled: 1, after: { unkeyed: 1 } });
  } finally {
    server.close();
    store.close();
  }
});
