import { randomUUID } from "node:crypto";
import { syncOwnerCheckout } from "@clankie/settings";
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, open, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  IntegrationBatchSchema,
  type IntegrationBatch,
  type IntegrationRepo,
  type IntegrationRun,
  type IntegrationQueueStatus,
  type HoldOverride,
} from "@clankie/protocol/integrate";
import { DeployHolds, durableJson, withDirectoryLock } from "./deploy-holds.ts";
import { integrationEnvironment } from "./integrate-environment.ts";

const execute = promisify(execFile);
const now = () => new Date().toISOString();
const active = new Set(["queued", "composing", "installing", "gating", "isolating", "pushing"]);
interface PendingIntegration {
  batch: IntegrationBatch;
  guard: () => Promise<void>;
}
interface IntegrationOptions {
  directory: string;
  core: string;
  app?: string;
  holds: DeployHolds;
}

/** The running pin can be a nested linked worktree; app lives beside its source checkout. */
/**
 * Landing runs the repository's fast, change-scoped `check:landing` when it
 * defines one; the full `check` stays for releases and manual runs.
 */
async function landingGateScript(directory: string): Promise<"check:landing" | "check"> {
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
    scripts?: Record<string, unknown>;
  };
  return typeof manifest.scripts?.["check:landing"] === "string" ? "check:landing" : "check";
}

export async function integrationSources(runtimeRoot: string): Promise<{ core: string; app: string }> {
  const { stdout } = await execute("git", [
    "-C",
    runtimeRoot,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const core = dirname(stdout.trim());
  return { core, app: join(dirname(core), "clankie-app") };
}

export class IntegrationQueue {
  private tail: Promise<void> = Promise.resolve();
  private running = new Set<string>();
  private pending: PendingIntegration[] = [];
  private draining = false;
  readonly options: IntegrationOptions;
  constructor(options: IntegrationOptions) {
    this.options = options;
  }
  private path(id: string): string {
    if (!/^[a-f0-9-]{36}$/u.test(id)) throw Error("Invalid batch ID");
    return join(this.options.directory, "batches", id, "record.json");
  }
  private async save(batch: IntegrationBatch): Promise<void> {
    batch.updatedAt = now();
    await durableJson(this.path(batch.id), IntegrationBatchSchema.parse(batch));
  }
  private async read(id: string): Promise<IntegrationBatch> {
    return IntegrationBatchSchema.parse(JSON.parse(await readFile(this.path(id), "utf8")));
  }
  async status(id: string): Promise<IntegrationBatch> {
    const receipt = await this.read(id);
    const shared = receipt.batchId ? await this.read(receipt.batchId) : receipt;
    const batch = receipt.batchId
      ? {
          ...shared,
          id: receipt.id,
          request: receipt.request,
          batchId: shared.id,
          attempts: receipt.attempts,
        }
      : shared;
    if (receipt.batchId && ["conflict", "failed"].includes(receipt.state))
      return { ...batch, state: receipt.state, error: receipt.error };
    // Polling a member must not mistake the failed shared attempt for its final result.
    if (shared.state === "failed" && this.running.has(shared.id) && (shared.members?.length ?? 0) > 1)
      return { ...batch, state: "isolating" };
    // A lost process never manufactures a pass. Retain the original record for diagnosis.
    if (active.has(batch.state) && !this.running.has(shared.id))
      return {
        ...batch,
        state: "interrupted",
        error:
          "Operation interrupted or owned by another process; inspect record and retained locks before starting a fresh batch",
      };
    return batch;
  }
  async snapshot(): Promise<IntegrationQueueStatus> {
    const directory = join(this.options.directory, "batches");
    const ids = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const batches: IntegrationBatch[] = [];
    for (const id of ids) {
      if (!/^[a-f0-9-]{36}$/u.test(id)) continue;
      // The request directory can exist briefly before its first atomic record.
      const receipt = await this.read(id).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (receipt && !receipt.batchId) batches.push(await this.status(id));
    }
    batches.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const completed = batches.filter((b) => !active.has(b.state) && b.state !== "interrupted");
    completed.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      running: batches.filter((b) => active.has(b.state) && b.state !== "queued"),
      waiting: batches.filter((b) => b.state === "queued"),
      ...(completed[0] ? { lastResult: completed[0] } : {}),
      interrupted: batches.filter((b) => b.state === "interrupted"),
    };
  }
  async start(request: IntegrationRun, guard: () => Promise<void>): Promise<IntegrationBatch> {
    try {
      const previous = await this.status(request.id);
      if (JSON.stringify(previous.request) !== JSON.stringify(request))
        throw Error("Batch ID belongs to a different request");
      return previous;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const batch: IntegrationBatch = {
      schemaVersion: 1,
      id: request.id,
      request,
      state: "queued",
      createdAt: now(),
      updatedAt: now(),
      evidence: this.path(request.id),
      repos: [],
    };
    // Reserve the batch identity before writing, including across service processes.
    await mkdir(dirname(this.path(request.id)), { recursive: false, mode: 0o700 }).catch(
      async (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        await mkdir(join(this.options.directory, "batches"), { recursive: true, mode: 0o700 });
        await mkdir(dirname(this.path(request.id)), { mode: 0o700 });
      },
    );
    this.running.add(batch.id);
    await this.save(batch);
    this.pending.push({ batch, guard });
    this.schedule();
    return batch;
  }
  private schedule(): void {
    if (this.draining) return;
    this.draining = true;
    this.tail = this.tail
      .catch(() => undefined)
      .then(async () => {
        try {
          await withDirectoryLock(join(this.options.directory, "queue.lock"), async () => {
            while (this.pending.length) {
              const first = this.pending.shift()!;
              const members = [first];
              const request = first.batch.request;
              // Preserve FIFO and keep restores / gate-only requests / distinct override intent apart.
              while (!request.restore && this.pending.length) {
                const next = this.pending[0]!.batch.request;
                if (
                  next.restore ||
                  next.push !== request.push ||
                  JSON.stringify(next.overrides) !== JSON.stringify(request.overrides)
                )
                  break;
                members.push(this.pending.shift()!);
              }
              try {
                await this.runMembers(members);
              } finally {
                for (const member of members) this.running.delete(member.batch.id);
              }
            }
          });
        } catch (error) {
          // A retained cross-process lock is a refusal, never permission to run a second gate.
          for (const member of this.pending.splice(0)) {
            member.batch.state = "failed";
            member.batch.error = String(error);
            await this.save(member.batch);
            this.running.delete(member.batch.id);
          }
        } finally {
          this.draining = false;
          if (this.pending.length) this.schedule();
        }
      });
  }
  async wait(): Promise<void> {
    do {
      await this.tail;
    } while (this.draining);
  }

  private async runMembers(input: PendingIntegration[], fresh = false): Promise<void> {
    const members: PendingIntegration[] = [];
    for (const member of input) {
      try {
        await member.guard();
        members.push(member);
      } catch (error) {
        member.batch.state = "failed";
        member.batch.error = String(error);
        await this.save(member.batch);
      }
    }
    if (!members.length) return;
    const first = members[0]!.batch;
    const requests = members.map((m) => m.batch.request);
    const id = members.length === 1 && !fresh ? first.id : randomUUID();
    const batch: IntegrationBatch =
      id === first.id
        ? first
        : {
            schemaVersion: 1,
            id,
            // Shared options come from the first request; members retain every bounded input.
            request: { ...first.request, id },
            state: "queued",
            createdAt: now(),
            updatedAt: now(),
            evidence: this.path(id),
            repos: [],
          };
    batch.members = requests;
    this.running.add(id);
    await this.save(batch);
    for (const member of members) {
      if (member.batch.id === id) continue;
      member.batch.batchId = id;
      member.batch.attempts = [...(member.batch.attempts ?? []), id];
      await this.save(member.batch);
    }
    let remaining = members;
    try {
      try {
        await this.composeAndGate(batch);
      } catch (error) {
        batch.state = "failed";
        batch.error = String(error);
        await this.save(batch);
      }
      remaining = members.filter((m) => !batch.excluded?.some((e) => e.id === m.batch.id));
      for (const excluded of batch.excluded ?? []) {
        const member = members.find((m) => m.batch.id === excluded.id)!;
        if (member.batch.id !== id) {
          member.batch.state = excluded.state;
          member.batch.error = excluded.error;
          await this.save(member.batch);
        }
      }
      if (batch.state === "failed" && remaining.length > 1) {
        batch.state = "isolating";
        await this.save(batch);
        // Bounded diagnosis: every failed subset gets smaller; good subsets get fresh attestations.
        const middle = Math.ceil(remaining.length / 2);
        await this.runMembers(remaining.slice(0, middle), true);
        await this.runMembers(remaining.slice(middle), true);
        batch.state = "failed";
        batch.error = `${batch.error ?? "Shared gate failed"}; isolated members have separate results (use their request IDs)`;
        await this.save(batch);
      } else if (batch.state === "passed" && batch.request.push) {
        await this.land(id, batch.request.overrides, async () => {
          for (const member of remaining) await member.guard();
        });
      }
    } finally {
      this.running.delete(id);
    }
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    // The clone's local config disables client hooks. Do not forward a -c hook override to
    // a local receive-pack: disposable bare origins must retain their real server hooks.
    const hookArgs = args[0] === "push" ? [] : ["-c", "core.hooksPath=/dev/null"];
    const { stdout } = await execute("git", [...hookArgs, "-C", cwd, ...args], {
      env,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.trim();
  }
  private async head(repo: IntegrationRepo): Promise<string> {
    return this.git(repo.directory, ["rev-parse", "HEAD"]);
  }
  private async clean(repo: IntegrationRepo): Promise<void> {
    if (await this.git(repo.directory, ["status", "--porcelain"]))
      throw Error(`${repo.name} worktree changed; gate cannot attest it`);
  }
  private async command(
    repo: IntegrationRepo,
    name: "install" | "gate",
    env: NodeJS.ProcessEnv,
    evidence: string,
  ): Promise<NonNullable<IntegrationRepo["gate"]>> {
    const log = join(evidence, `${repo.name}-${name}.log`);
    const startedAt = now();
    const head = await this.head(repo);
    const gateScript = name === "gate" ? await landingGateScript(repo.directory) : "check";
    const result = await new Promise<{ exitCode: number | null; signal: string | null }>(
      (resolve, reject) => {
        const out = createWriteStream(log, { flags: "wx", mode: 0o600 });
        out.on("error", reject);
        const args =
          name === "install"
            ? [
                "install",
                "--frozen-lockfile",
                "--store-dir",
                env.npm_config_store_dir!,
                "--package-import-method=copy",
              ]
            : [gateScript];
        const child = spawn("pnpm", args, {
          cwd: repo.directory,
          env: name === "gate" ? { ...env, CLANKIE_LANDING_BASE: repo.base } : env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout.pipe(out, { end: false });
        child.stderr.pipe(out, { end: false });
        child.on("error", (error) => {
          out.end(String(error));
          reject(error);
        });
        child.on("close", (exitCode, signal) => {
          out.end(() => resolve({ exitCode, signal }));
        });
      },
    );
    const file = await open(log, "r");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    return { head, ...result, startedAt, finishedAt: now(), log };
  }

  private async composeAndGate(batch: IntegrationBatch): Promise<void> {
    const root = dirname(batch.evidence);
    const restore = batch.request.restore ? await this.status(batch.request.restore) : undefined;
    if (restore && !["passed", "held", "pushed", "partial"].includes(restore.state))
      throw Error("Restore requires a recorded passed batch");
    const names: ("core" | "app")[] = restore
      ? restore.repos.map((r) => r.name)
      : (batch.members ?? [batch.request]).some((member) => member.app !== undefined)
        ? ["core", "app"]
        : ["core"];
    batch.state = "composing";
    await this.save(batch);
    for (const name of names) {
      const source = name === "core" ? this.options.core : this.options.app;
      if (!source) throw Error("App repository is unavailable");
      const origin = await this.git(source, ["remote", "get-url", "origin"]);
      const repository = join(root, "repositories", name);
      await mkdir(dirname(repository), { recursive: true, mode: 0o700 });
      await this.git(root, ["clone", "--no-hardlinks", "--no-checkout", source, repository]);
      await this.git(repository, ["remote", "set-url", "origin", origin]);
      await this.git(repository, ["config", "core.hooksPath", "/dev/null"]);
      await this.git(repository, ["config", "user.name", "Clankie"]);
      await this.git(repository, ["config", "user.email", "integrate@clankie.bot"]);
      await this.git(repository, ["config", "commit.gpgsign", "false"]);
      await this.git(repository, ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
      const base = await this.git(repository, ["rev-parse", "refs/remotes/origin/main"]);
      const directory = join(root, "worktrees", name === "core" ? "clankie" : "clankie-app");
      await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
      await this.git(repository, ["worktree", "add", "--detach", directory, base]);
      const repo: IntegrationRepo = {
        name,
        source,
        origin,
        base,
        directory,
        head: base,
        commits: (batch.members ?? [batch.request]).flatMap((member) =>
          (name === "core" ? member.core : (member.app ?? [])).map((commit) => ({
            commit,
            memberId: member.id,
            state: "pending" as const,
          })),
        ),
      };
      batch.repos.push(repo);
      await this.save(batch);
      if (restore) {
        const good = restore.repos.find((r) => r.name === name)!;
        if (
          good.source !== source ||
          good.origin !== origin ||
          good.gate?.exitCode !== 0 ||
          good.gate.head !== good.head
        )
          throw Error("Restore source does not match a recorded passed tree");
        await this.git(directory, ["fetch", good.directory, good.head]);
        await this.git(directory, ["read-tree", "--reset", "-u", `${good.head}^{tree}`]);
        await this.git(directory, [
          "commit",
          "--allow-empty",
          "-m",
          `Restore ${name} tree from passed integration ${restore.id} (${good.head})`,
        ]);
        repo.head = await this.head(repo);
        await this.save(batch);
      }
    }
    batch.excluded = [];
    for (const member of batch.members ?? [batch.request]) {
      const before = batch.repos.map((r) => r.head);
      let failure: NonNullable<IntegrationBatch["excluded"]>[number] | undefined;
      for (const repo of batch.repos) {
        for (const item of repo.commits.filter((c) => c.memberId === member.id)) {
          if (failure) {
            item.state = "blocked";
            continue;
          }
          try {
            const commit = await this.git(repo.source, ["rev-parse", "--verify", `${item.commit}^{commit}`]);
            item.commit = commit;
            await this.git(repo.directory, ["fetch", repo.source, commit]);
            const ancestry = await this.git(repo.directory, ["merge-base", commit, "HEAD"]);
            if (ancestry === commit) item.state = "already_present";
            else {
              await this.git(repo.directory, ["cherry-pick", "--empty=drop", commit]);
              item.state = "applied";
            }
            repo.head = await this.head(repo);
            item.head = repo.head;
          } catch (error) {
            const conflicts = (await this.git(repo.directory, ["diff", "--name-only", "--diff-filter=U"]))
              .split("\n")
              .filter(Boolean);
            item.state = conflicts.length ? "conflict" : "failed";
            item.conflicts = conflicts;
            item.error = String(error);
            failure = { id: member.id, state: item.state, error: item.error };
          }
          await this.save(batch);
        }
      }
      if (failure) {
        batch.excluded.push(failure);
        // A request is atomic across both siblings. Roll it back before applying another member.
        for (const [index, repo] of batch.repos.entries()) {
          await this.git(repo.directory, ["cherry-pick", "--abort"]).catch(() => undefined);
          await this.git(repo.directory, ["reset", "--hard", before[index]!]);
          repo.head = before[index]!;
          for (const item of repo.commits.filter((c) => c.memberId === member.id && c.state === "applied")) {
            item.state = "blocked";
            delete item.head;
          }
        }
      }
      await this.save(batch);
    }
    if (batch.excluded.length === (batch.members ?? [batch.request]).length) {
      batch.state = batch.excluded.some((e) => e.state === "conflict") ? "conflict" : "failed";
      batch.error = batch.excluded.map((e) => `${e.id}: ${e.error}`).join("; ");
      await this.save(batch);
      return;
    }
    // Install every sibling before either gate; both gates validate the exact composed pair.
    batch.state = "installing";
    await this.save(batch);
    for (const repo of batch.repos) {
      const env = await integrationEnvironment(join(root, "isolation", repo.name));
      await this.clean(repo);
      repo.install = await this.command(repo, "install", env, root);
      await this.save(batch);
      if (repo.install.exitCode !== 0) {
        batch.state = "failed";
        await this.save(batch);
        return;
      }
    }
    batch.state = "gating";
    await this.save(batch);
    for (const repo of batch.repos) {
      const env = await integrationEnvironment(join(root, "isolation", repo.name));
      repo.gate = await this.command(repo, "gate", env, root);
      await this.save(batch);
    }
    for (const repo of batch.repos) {
      if (
        repo.gate?.exitCode !== 0 ||
        repo.gate.head !== (await this.head(repo)) ||
        repo.head !== repo.gate.head
      )
        throw Error(`${repo.name} gate failed or HEAD changed; see ${repo.gate?.log}`);
      await this.clean(repo);
    }
    batch.state = "passed";
    await this.save(batch);
  }

  async land(id: string, overrides: HoldOverride[], guard: () => Promise<void>): Promise<IntegrationBatch> {
    const batch = await this.status(id);
    if (batch.batchId) {
      if (["conflict", "failed", "interrupted"].includes(batch.state))
        throw Error(`Request ${id} has no landable pass (${batch.state})`);
      await this.land(batch.batchId, overrides, guard);
      return this.status(id);
    }
    if (batch.state === "pushed") return batch;
    if (!["passed", "held", "partial"].includes(batch.state))
      throw Error(`Batch ${id} has no landable pass (${batch.state})`);
    const wasRunning = this.running.has(id);
    this.running.add(id);
    try {
      return await withDirectoryLock(join(dirname(batch.evidence), "push.lock"), async () => {
        try {
          return await this.options.holds.landing(`integrate:${id}`, overrides, async () => {
            await guard();
            // Read the persisted attestation rather than trusting an in-memory check result.
            const recorded = await this.status(id);
            recorded.repos.sort((a, b) => (a.name === b.name ? 0 : a.name === "core" ? -1 : 1));
            if (!recorded.repos.length) throw Error("No repositories were gated");
            for (const repo of recorded.repos) {
              if (
                repo.gate?.exitCode !== 0 ||
                repo.gate.head !== repo.head ||
                repo.head !== (await this.head(repo))
              )
                throw Error(`${repo.name}: recorded gate is not a pass for exact HEAD`);
              await this.clean(repo);
              if ((await this.git(repo.directory, ["remote", "get-url", "origin"])) !== repo.origin)
                throw Error(`${repo.name}: origin changed since composition`);
              if ((await this.git(repo.directory, ["remote", "get-url", "--push", "origin"])) !== repo.origin)
                throw Error(`${repo.name}: push destination changed since composition`);
              const current = (
                await this.git(repo.directory, ["ls-remote", "origin", "refs/heads/main"])
              ).split(/\s/u)[0];
              if (repo.push && repo.push.state !== "confirmed" && repo.push.state !== "rejected") {
                // Reconcile an uncertain send, never replay it.
                if (current !== repo.head)
                  throw Error(
                    `${repo.name}: previous push unconfirmed; inspect origin and start a fresh batch`,
                  );
                repo.push.state = "confirmed";
                repo.ownerCheckoutSync = await syncOwnerCheckout(repo.source);
                await this.save(recorded);
              }
              if (repo.push?.state === "confirmed") {
                if (current !== repo.head)
                  throw Error(`${repo.name}: origin advanced after landing; start a fresh batch`);
              } else if (current !== repo.base)
                throw Error(
                  `${repo.name}: origin/main moved from ${repo.base} to ${current}; compose a fresh batch`,
                );
            }
            recorded.state = "pushing";
            delete recorded.error;
            await this.save(recorded);
            for (const repo of recorded.repos) {
              if (repo.push?.state === "confirmed") continue;
              await guard();
              // Recheck both HEADs after each network operation, including the sibling dependency.
              for (const sibling of recorded.repos) {
                if (sibling.head !== (await this.head(sibling)))
                  throw Error(`${sibling.name}: HEAD changed after gate`);
                await this.clean(sibling);
              }
              const log = join(
                dirname(recorded.evidence),
                `${repo.name}-push-${now().replaceAll(":", "-")}.log`,
              );
              repo.push = { state: "attempting", at: now(), exitCode: null, log };
              await this.save(recorded);
              try {
                const output = await this.git(repo.directory, [
                  "push",
                  "--porcelain",
                  "origin",
                  `${repo.head}:refs/heads/main`,
                ]);
                await durableJson(log, { stdout: output });
                repo.push.exitCode = 0;
              } catch (error) {
                const stdout = (error as { stdout?: string }).stdout ?? "";
                await durableJson(log, { error: String(error), stdout });
                const code = (error as { code?: unknown }).code;
                repo.push.exitCode = typeof code === "number" ? code : null;
                if (/^!\t.*\[(?:remote )?rejected\]/mu.test(stdout)) repo.push.state = "rejected";
              }
              if (repo.push.state !== "rejected") repo.push.state = "unconfirmed";
              await this.save(recorded);
              const landed = (
                await this.git(repo.directory, ["ls-remote", "origin", "refs/heads/main"])
              ).split(/\s/u)[0];
              if (landed !== repo.head)
                throw Error(`${repo.name}: push ${repo.push.state}; no automatic retry (see ${log})`);
              repo.push.state = "confirmed";
              repo.ownerCheckoutSync = await syncOwnerCheckout(repo.source);
              await this.save(recorded);
            }
            recorded.state = "pushed";
            await this.save(recorded);
            return recorded;
          });
        } catch (error) {
          // Keep successful/uncertain individual repo landings; two origins have no atomic transaction.
          const latest = await this.status(id);
          latest.state = latest.repos.some((r) => r.push) ? "partial" : "held";
          const core = latest.repos.find((r) => r.name === "core");
          const app = latest.repos.find((r) => r.name === "app");
          latest.error =
            core?.push?.state === "confirmed" && app?.push?.state !== "confirmed"
              ? `Core landed at ${core.head}; app pending. ${String(error)}`
              : String(error);
          await this.save(latest);
          return latest;
        }
      });
    } finally {
      if (!wasRunning) this.running.delete(id);
    }
  }
}
