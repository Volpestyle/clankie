import { mkdir, mkdtemp, open, opendir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AgentSessionRequestError } from "@clankie/agent-transcript";
import {
  openCodeDatabaseIdentity,
  readOpenCodeHistory,
  type OpenCodeHistorySource,
} from "./opencode-history.ts";

const Descriptor = z
  .object({
    kind: z.literal("opencode-sqlite"),
    machineId: z.literal("local"),
    profileId: z.string().regex(/^profile-[A-Za-z0-9]+$/u),
    database: z.string().max(4096),
    databaseIdentity: z.string().regex(/^\d+:\d+$/u),
    sessionId: z.string().regex(/^ses_[A-Za-z0-9]{8,128}$/u),
    version: z.literal("1.18.18"),
    workingDirectory: z.string().max(4096),
  })
  .strict();
export interface OpenCodeWorkerProfile {
  readonly profileId: string;
  readonly directory: string;
  readonly database: string;
}

/** Native-owned storage addresses. Never restores a retired controller or proves exit. */
export class OpenCodeProfiles {
  private readonly created = new WeakSet<OpenCodeWorkerProfile>();
  private readonly stateDir: string;
  public constructor(stateDir: string) {
    this.stateDir = stateDir;
  }
  private async root(create = false) {
    const path = join(await realpath(this.stateDir), "opencode-workers", "profiles");
    if (create) await mkdir(path, { recursive: true, mode: 0o700 });
    if ((await realpath(path)) !== path)
      throw new AgentSessionRequestError("Native profile root alias refused", 409);
    return path;
  }
  public async allocate(): Promise<OpenCodeWorkerProfile> {
    const directory = await mkdtemp(join(await this.root(true), "profile-"));
    const profile = {
      profileId: directory.split("/").at(-1)!,
      directory,
      database: join(directory, "opencode.db"),
    };
    this.created.add(profile);
    return profile;
  }
  public async register(
    profile: OpenCodeWorkerProfile,
    sessionId: string,
    cwd: string,
    verify: () => Promise<unknown>,
  ): Promise<void> {
    if (!this.created.has(profile) || profile.directory !== join(await this.root(), profile.profileId))
      throw new Error("Original native profile unavailable");
    await verify();
    const source = Descriptor.parse({
      kind: "opencode-sqlite",
      machineId: "local",
      profileId: profile.profileId,
      database: profile.database,
      databaseIdentity: await openCodeDatabaseIdentity(profile.database, profile.directory),
      sessionId,
      version: "1.18.18",
      workingDirectory: await realpath(cwd),
    });
    await readOpenCodeHistory(source, profile.directory, { metadataOnly: true });
    await verify();
    const temporary = join(profile.directory, `.descriptor-${randomUUID()}.json`);
    try {
      await writeFile(temporary, JSON.stringify(source) + "\n", { mode: 0o600, flag: "wx" });
      await verify();
      await readOpenCodeHistory(source, profile.directory, { metadataOnly: true });
      await verify();
      await rename(temporary, join(profile.directory, "source.json"));
      this.created.delete(profile);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  private async descriptors(): Promise<OpenCodeHistorySource[]> {
    let root: string;
    try {
      root = await this.root();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const sources: OpenCodeHistorySource[] = [];
    const directory = await opendir(root);
    let scanned = 0;
    for await (const entry of directory) {
      if (++scanned > 100)
        throw new AgentSessionRequestError("Native profile discovery exceeds 100 profiles", 409);
      if (!entry.isDirectory() || !/^profile-[A-Za-z0-9]+$/u.test(entry.name))
        throw new AgentSessionRequestError("Unsupported native profile entry", 409);
      const profile = join(root, entry.name);
      if ((await realpath(profile)) !== profile)
        throw new AgentSessionRequestError("Native profile alias refused", 409);
      let handle;
      try {
        handle = await open(join(profile, "source.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      let source: OpenCodeHistorySource;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || stat.size > 16_384)
          throw new AgentSessionRequestError("Native source descriptor unavailable", 409);
        const bytes = Buffer.alloc(16_385);
        const read = await handle.read(bytes, 0, bytes.length, 0);
        if (read.bytesRead > 16_384)
          throw new AgentSessionRequestError("Native source descriptor exceeds bound", 409);
        source = Descriptor.parse(JSON.parse(bytes.toString("utf8", 0, read.bytesRead)));
      } finally {
        await handle.close();
      }
      if (source.profileId !== entry.name || source.database !== join(profile, "opencode.db"))
        throw new AgentSessionRequestError("Native source descriptor retargeted", 409);
      sources.push(source);
    }
    return sources;
  }
  public async list(limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new AgentSessionRequestError("limit must be an integer from 1 to 100");
    const values = [];
    for (const source of await this.descriptors())
      values.push(
        await readOpenCodeHistory(source, join(await this.root(), source.profileId), { metadataOnly: true }),
      );
    return values.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, limit);
  }
  public async resolve(sessionId: string): Promise<OpenCodeHistorySource> {
    const matches = (await this.descriptors()).filter((value) => value.sessionId === sessionId);
    if (matches.length !== 1)
      throw new AgentSessionRequestError(
        matches.length ? "Ambiguous registered native session" : "No registered native OpenCode session",
        matches.length ? 409 : 404,
      );
    const source = matches[0]!;
    await readOpenCodeHistory(source, join(await this.root(), source.profileId), { metadataOnly: true });
    return source;
  }
  /** Read a task's direct child inside its registered parent's dedicated native profile. */
  public async readSubagent(
    parentId: string,
    callId: string,
    options: { tail?: number; after?: string } = {},
  ) {
    if (!callId || callId.length > 256) throw new AgentSessionRequestError("Invalid subagent identity");
    const source = await this.resolve(parentId);
    const root = join(await this.root(), source.profileId);
    const locate = async () => {
      const parent = await readOpenCodeHistory(source, root, {
        tail: 500,
        subagentsOnly: true,
        childCallId: callId,
      });
      if (!parent.subagent) throw new AgentSessionRequestError("No matching parent task call", 404);
      if (!parent.subagent.sessionId)
        throw new AgentSessionRequestError("Native child locator unavailable", 409);
      return parent.subagent.sessionId;
    };
    const childId = await locate();
    const page = await readOpenCodeHistory({ ...source, sessionId: childId }, root, options);
    if (
      (await locate()) !== childId ||
      JSON.stringify(await this.resolve(parentId)) !== JSON.stringify(source)
    )
      throw new AgentSessionRequestError("Native child source changed during read", 409);
    return page;
  }
  public async read(
    sessionId: string,
    options: { tail?: number; after?: string; subagentsOnly?: boolean } = {},
  ) {
    const source = await this.resolve(sessionId);
    const page = await readOpenCodeHistory(source, join(await this.root(), source.profileId), options);
    if (JSON.stringify(await this.resolve(sessionId)) !== JSON.stringify(source))
      throw new AgentSessionRequestError("Native source descriptor changed during read", 409);
    return page;
  }
}
