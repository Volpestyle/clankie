import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname, platform } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { Hono, type Context } from "hono";
import type { SettingsStore } from "@clankie/settings";
import {
  BODY_TRANSFER_ABORT_PATH,
  BODY_TRANSFER_APPLY_PATH,
  BODY_TRANSFER_BUNDLE_PATH,
  BODY_TRANSFER_DISCARD_PATH,
  BODY_TRANSFER_FORMAT,
  BODY_TRANSFER_FREEZE_PATH,
  BODY_TRANSFER_REBIND_PATH,
  BODY_TRANSFER_RECLAIM_PATH,
  BODY_TRANSFER_RELEASE_PATH,
  BODY_TRANSFER_DOWNLOAD_CHUNK_BYTES,
  BODY_TRANSFER_STAGE_CHUNK_PATH,
  BODY_TRANSFER_STAGE_PATH,
  BODY_TRANSFER_UPLOAD_CHUNK_BYTES,
  BodyTransferBundleRequestSchema,
  BodyTransferStageChunkRequestSchema,
  BodyTransferStageRequestSchema,
  BODY_TRANSFER_STATUS_PATH,
  BodySelfSchema,
  BodyTransferAbortRequestSchema,
  BodyTransferFreezeRequestSchema,
  BodyTransferIdRequestSchema,
  BodyTransferIdSchema,
  BodyTransferManifestSchema,
  BodyTransferRebindRequestSchema,
  BodyTransferReclaimRequestSchema,
  BodyTransferReleaseRequestSchema,
  type BodyAuthority,
  type BodySelf,
  type BodyTransferEntry,
  type BodyTransferManifest,
  type BodyTransferRecord,
} from "@clankie/protocol/body-transfer";
import { discordAttachmentRoot } from "@clankie/settings";
import { defaultMemoryDir } from "./memory.ts";

/**
 * One body holds Clankie at a time (ADR 0286). The self record fences every
 * transfer step; a body that is not active boots dormant and serves only
 * `/health` and these owner routes.
 */
export interface BodyTransferRoots {
  readonly state: string;
  readonly memory: string;
  readonly attachments: string;
}

export function bodyTransferRoots(stateRoot: string, env: NodeJS.ProcessEnv): BodyTransferRoots {
  return { state: stateRoot, memory: defaultMemoryDir(env), attachments: discordAttachmentRoot(env) };
}

// What Clankie knows and has said. Everything else in the state root binds this
// body to its machine, accounts or devices and stays (listed as retained).
const STATE_ENTRIES = [
  "captain/conversations",
  "captain/conversation-archives",
  "captain/rooms",
  "captain/room-forks.json",
  "captain/turns",
  "captain/durable-pi-room",
  "captain/lanes",
  "captain/autonomy.json",
  "captain/fleet-room",
  "captain/routines",
  "captain/auto-rounds",
  "captain/huddles.json",
  "captain/turn-settled.jsonl",
  "captain/personas.json",
  "captain/personas.markers.json",
  "captain/persona-avatars",
  "captain/seat-ledger.jsonl",
  "captain/delivery-receipts",
  "captain/next-turn-mailboxes.json",
  "tracker",
  "tracker-imports",
  "work-repos.json",
  "work-write-receipts.json",
  "repo-trackers",
  "linear-writes.json",
  "linear-attribution.json",
  "linear-wake-read-receipts.json",
  "evidence",
  "views",
  "discord-turn-receipts.json",
  "discord-tracking.json",
] as const;
const MEMORY_ENTRIES = ["captain-episodes", "discord-people"] as const;
const ATTACHMENT_ENTRIES = ["delivered"] as const;
const MOVED_SETTINGS = [
  "discord",
  "persona",
  "appearance",
  "voice",
  "fleet",
  "maximumTrustMode",
  "autonomy",
  "retiredWorkingPreferences",
  "projects",
  "workTrackerDefault",
  "gameplay",
  "evidence",
  "captain",
] as const;
// Machine paths in captain settings stay with the machine.
const STAYING_CAPTAIN_SETTINGS = ["workingDirectory", "extensions"] as const;
/** A workspace on the source's own machine, until the source joins the destination. */
const transferredMachineId = (transferId: string) => `transferred:${transferId}`;

class BodyTransferError extends Error {
  readonly code: string;
  readonly status: 400 | 404 | 409 | 503;

  constructor(code: string, status: 400 | 404 | 409 | 503 = 409) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/** Runs `commit` only once the body is idle and closed to new turns, then shuts the service down. */
export type BodyCutover = (commit: () => Promise<void>) => Promise<"ready" | "busy">;

export class BodyTransfer {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly roots: BodyTransferRoots;
  private readonly settings: SettingsStore;
  private readonly label: string;
  private readonly now: () => Date;
  /** Set when boot could not apply a staged transfer; the body stays dormant. */
  bootError: string | undefined;
  /**
   * What this process is, fixed at boot. A body that froze itself stays a
   * shutting-down active process until it restarts, so it never reports itself
   * dormant or exports from a store something may still write.
   */
  private bootedDormant: boolean | undefined;

  constructor(options: {
    roots: BodyTransferRoots;
    settings: SettingsStore;
    label?: string;
    now?: () => Date;
  }) {
    this.roots = options.roots;
    this.settings = options.settings;
    this.label = options.label ?? hostname();
    this.now = options.now ?? (() => new Date());
  }

  private get selfPath() {
    return join(this.roots.state, "self.json");
  }

  private dir(...parts: string[]) {
    return join(this.roots.state, "transfer", ...parts);
  }

  /** A corrupt record throws: the body must not guess whether it is Clankie. */
  read(): BodySelf | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.selfPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    return BodySelfSchema.parse(JSON.parse(raw));
  }

  private write(self: BodySelf): void {
    const value = BodySelfSchema.parse(self);
    const temporary = `${this.selfPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    const file = openSync(temporary, "r");
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, this.selfPath);
    const directory = openSync(this.roots.state, "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }

  private current(): BodySelf {
    return this.read() ?? { schemaVersion: 1, epoch: 0, state: "active", transfers: {} };
  }

  private record(self: BodySelf, transferId: string, record: Omit<BodyTransferRecord, "at">): BodySelf {
    return {
      ...self,
      transfers: { ...self.transfers, [transferId]: { ...record, at: this.now().toISOString() } },
    };
  }

  dormant(): boolean {
    return this.bootedDormant ?? this.current().state !== "active";
  }

  authority(options: { transfers?: boolean } = {}): BodyAuthority {
    const self = this.current();
    return {
      ...(self.selfId === undefined ? {} : { selfId: self.selfId }),
      epoch: self.epoch,
      state: self.state,
      dormant: this.dormant(),
      ...(self.transferId === undefined ? {} : { transferId: self.transferId }),
      ...(self.releasedTo === undefined ? {} : { releasedTo: self.releasedTo }),
      ...(options.transfers ? { transfers: self.transfers } : {}),
    };
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run, run);
    // allow-swallowed-rejection -- the caller receives the rejection through `result`; the queue only orders work
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Source, active: stop being Clankie before any snapshot exists. */
  freeze(input: unknown, cutover: BodyCutover): Promise<BodyAuthority> {
    const request = BodyTransferFreezeRequestSchema.parse(input);
    return this.serial(async () => {
      const self = this.current();
      const known = self.transfers[request.transferId];
      if (known?.role === "source" && (known.outcome === "frozen" || known.outcome === "released"))
        return this.authority();
      if (known !== undefined) throw new BodyTransferError("transfer_id_used");
      if (self.state !== "active") throw new BodyTransferError("body_not_active");
      const epoch = self.epoch + 1;
      const frozen: BodySelf = this.record(
        {
          ...self,
          selfId: self.selfId ?? randomUUID(),
          epoch,
          state: "frozen",
          transferId: request.transferId,
        },
        request.transferId,
        {
          role: "source",
          outcome: "frozen",
          epoch,
          peer: request.destination,
          ...(request.destinationMachineId === undefined
            ? {}
            : { destinationMachineId: request.destinationMachineId }),
        },
      );
      delete frozen.releasedTo;
      if ((await cutover(async () => this.write(frozen))) === "busy")
        throw new BodyTransferError("body_busy");
      return this.authority();
    });
  }

  private frozenSource(transferId: string): { self: BodySelf; record: BodyTransferRecord } {
    const self = this.current();
    const record = self.transfers[transferId];
    if (self.state !== "frozen" || self.transferId !== transferId || record?.role !== "source")
      throw new BodyTransferError("transfer_not_frozen_here");
    return { self, record };
  }

  /** Source, dormant: nothing writes these files while they are read. */
  async exportBundle(transferId: string): Promise<{ manifest: BodyTransferManifest; stream: Readable }> {
    const { self, record } = this.frozenSource(BodyTransferIdSchema.parse(transferId));
    if (record.outcome !== "frozen") throw new BodyTransferError("transfer_not_frozen_here");
    const replaces: BodyTransferEntry[] = [
      ...STATE_ENTRIES.map((path) => ({ root: "state" as const, path })),
      ...(await topLevel(this.roots.memory, MEMORY_ENTRIES)).map((path) => ({
        root: "memory" as const,
        path,
      })),
      ...(await topLevel(this.roots.attachments, ATTACHMENT_ENTRIES)).map((path) => ({
        root: "attachments" as const,
        path,
      })),
    ];
    const files: BodyTransferManifest["files"] = [];
    const skipped: string[] = [];
    for (const entry of replaces) {
      for await (const path of walk(this.roots[entry.root], entry.path, skipped)) {
        const absolute = join(this.roots[entry.root], path);
        const { size, sha256 } = await digest(absolute);
        files.push({ root: entry.root, path, size, sha256 });
      }
    }
    const moved = new Set(replaces.filter((entry) => entry.root === "state").map((entry) => entry.path));
    const retained = [
      ...(await retainedNames(this.roots.state, moved)),
      ...skipped,
      "credential broker, model and harness sign-ins, account tokens",
      "paired devices, device-session key, gateway and hosted identity",
      "machines, joins, Herdr bindings, worker grants, captain/herdr-watches*",
    ];
    const manifest = BodyTransferManifestSchema.parse({
      format: BODY_TRANSFER_FORMAT,
      transferId,
      selfId: self.selfId,
      epoch: record.epoch,
      source: {
        label: this.label,
        platform: platform() === "win32" ? "windows" : "posix",
        createdAt: this.now().toISOString(),
      },
      settings: movedSettings(await this.settings.load(), transferId, record.destinationMachineId),
      replaces,
      files,
      retained,
    });
    const roots = this.roots;
    async function* frames() {
      const head = Buffer.from(JSON.stringify(manifest));
      yield Buffer.from(`${BODY_TRANSFER_FORMAT}\n${head.length}\n`);
      yield head;
      for (const file of manifest.files) {
        const hash = createHash("sha256");
        let size = 0;
        for await (const chunk of createReadStream(join(roots[file.root], file.path))) {
          hash.update(chunk as Buffer);
          size += (chunk as Buffer).length;
          yield chunk as Buffer;
        }
        if (size !== file.size || hash.digest("hex") !== file.sha256)
          throw new BodyTransferError("source_changed_during_export");
      }
    }
    return { manifest, stream: Readable.from(frames()).pipe(createGzip()) };
  }

  /** Source, frozen: become a tombstone only after the destination says it is active. */
  release(input: unknown): Promise<BodyAuthority> {
    const request = BodyTransferReleaseRequestSchema.parse(input);
    return this.serial(async () => {
      const self = this.current();
      const record = self.transfers[request.transferId];
      if (record?.role === "source" && record.outcome === "released") return this.authority();
      const { self: frozen } = this.frozenSource(request.transferId);
      const activation = request.activation;
      if (
        activation.state !== "active" ||
        activation.dormant ||
        activation.selfId !== frozen.selfId ||
        activation.epoch !== frozen.epoch ||
        activation.transferId !== request.transferId
      )
        throw new BodyTransferError("destination_not_active_for_transfer");
      const at = this.now().toISOString();
      await this.removeOutgoing(request.transferId);
      this.write({
        ...this.record(frozen, request.transferId, { ...record!, outcome: "released" }),
        state: "released",
        releasedTo: { peer: request.destination, epoch: frozen.epoch, at },
      });
      return this.authority();
    });
  }

  /** Source, frozen: only a destination that burned the id can return Clankie here. */
  abort(input: unknown): Promise<BodyAuthority> {
    const request = BodyTransferAbortRequestSchema.parse(input);
    return this.serial(async () => {
      const { self, record } = this.frozenSource(request.transferId);
      if (request.discarded.transfers?.[request.transferId]?.outcome !== "burned")
        throw new BodyTransferError("destination_has_not_burned_transfer");
      await this.removeOutgoing(request.transferId);
      this.write({
        ...this.record(self, request.transferId, { ...record, outcome: "aborted" }),
        state: "active",
      });
      return this.authority();
    });
  }

  /** Owner's explicit escape from a dormant body. May leave two histories; recorded. */
  reclaim(input: unknown): Promise<BodyAuthority> {
    const request = BodyTransferReclaimRequestSchema.parse(input);
    return this.serial(async () => {
      const self = this.current();
      if (self.state === "active") throw new BodyTransferError("body_already_active");
      const id = randomUUID();
      const epoch = self.epoch + 1;
      const reclaimed = this.record({ ...self, epoch, state: "active", transferId: id }, id, {
        role: "source",
        outcome: "aborted",
        epoch,
        peer: `reclaim --force: ${request.reason}`,
      });
      delete reclaimed.releasedTo;
      this.write(reclaimed);
      return this.authority();
    });
  }

  /** Source, dormant: the bundle is written once, then read in chunks the carrier can hold. */
  async bundleChunk(input: unknown) {
    const request = BodyTransferBundleRequestSchema.parse(input);
    const { path, size, sha256 } = await this.outgoingBundle(request.transferId);
    if (request.offset > size) throw new BodyTransferError("bundle_offset_out_of_range", 400);
    const length = Math.min(BODY_TRANSFER_DOWNLOAD_CHUNK_BYTES, size - request.offset);
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, request.offset);
      return {
        transferId: request.transferId,
        size,
        sha256,
        offset: request.offset,
        bytesBase64: buffer.subarray(0, bytesRead).toString("base64"),
      };
    } finally {
      await handle.close();
    }
  }

  private outgoingBundle(transferId: string): Promise<{ path: string; size: number; sha256: string }> {
    return this.serial(async () => {
      if (this.bootedDormant === false) throw new BodyTransferError("source_still_shutting_down");
      const { record } = this.frozenSource(transferId);
      if (record.outcome !== "frozen") throw new BodyTransferError("transfer_not_frozen_here");
      const path = this.dir("outgoing", `${transferId}.bundle`);
      const summary = `${path}.json`;
      if (existsSync(summary)) {
        const { size, sha256 } = JSON.parse(await readFile(summary, "utf8")) as {
          size: number;
          sha256: string;
        };
        return { path, size, sha256 };
      }
      const { stream } = await this.exportBundle(transferId);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      const hash = createHash("sha256");
      let size = 0;
      await pipeline(
        stream,
        async function* (chunks) {
          for await (const chunk of chunks) {
            hash.update(chunk as Buffer);
            size += (chunk as Buffer).length;
            yield chunk;
          }
        },
        createWriteStream(temporary, { mode: 0o600 }),
      );
      await rename(temporary, path);
      const sha256 = hash.digest("hex");
      await writeFile(summary, JSON.stringify({ size, sha256 }), { mode: 0o600 });
      return { path, size, sha256 };
    });
  }

  /** A frozen source builds its bundle at boot, before anything else opens. */
  async prepareOutgoing(): Promise<void> {
    const self = this.read();
    const record = self?.transferId === undefined ? undefined : self.transfers[self.transferId];
    if (self?.state !== "frozen" || record?.role !== "source" || record.outcome !== "frozen") return;
    await this.outgoingBundle(self.transferId!);
  }

  private async removeOutgoing(transferId: string): Promise<void> {
    const path = this.dir("outgoing", `${transferId}.bundle`);
    await rm(path, { force: true });
    await rm(`${path}.json`, { force: true });
  }

  private incomingBundle(transferId: string): string {
    return this.dir("incoming", `${transferId}.bundle`);
  }

  /** Destination: append one chunk; a resent chunk rewrites from its offset. */
  stageChunk(input: unknown) {
    const request = BodyTransferStageChunkRequestSchema.parse(input);
    return this.serial(async () => {
      const known = this.current().transfers[request.transferId];
      if (known !== undefined && known.outcome !== "staged") throw new BodyTransferError("transfer_id_used");
      const bytes = Buffer.from(request.bytesBase64, "base64");
      if (bytes.length > BODY_TRANSFER_UPLOAD_CHUNK_BYTES)
        throw new BodyTransferError("chunk_too_large", 400);
      const path = this.incomingBundle(request.transferId);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      if (!existsSync(path)) await writeFile(path, "", { mode: 0o600 });
      if (request.offset > (await stat(path)).size) throw new BodyTransferError("stage_offset_gap");
      const handle = await open(path, "r+");
      try {
        await handle.truncate(request.offset);
        await handle.write(bytes, 0, bytes.length, request.offset);
      } finally {
        await handle.close();
      }
      return { transferId: request.transferId, received: request.offset + bytes.length };
    });
  }

  /** Destination: the uploaded bundle is complete and intact; stage it. Repeatable. */
  async stage(input: unknown) {
    const request = BodyTransferStageRequestSchema.parse(input);
    const known = this.current().transfers[request.transferId];
    const path = this.incomingBundle(request.transferId);
    if (known?.role === "destination" && known.outcome !== "burned" && !existsSync(path)) {
      // allow-swallowed-rejection -- an applied stage removed its manifest; the counts then read 0
      const manifest = await this.stagedManifest(request.transferId).catch(() => undefined);
      return {
        transferId: request.transferId,
        outcome: known.outcome === "staged" ? ("staged" as const) : ("applied" as const),
        files: manifest?.files.length ?? 0,
        bytes: manifest?.files.reduce((total, file) => total + file.size, 0) ?? 0,
      };
    }
    if (!existsSync(path)) throw new BodyTransferError("bundle_missing", 400);
    const received = await digest(path);
    if (received.size !== request.size || received.sha256 !== request.sha256)
      throw new BodyTransferError("bundle_incomplete", 400);
    const result = await this.stageStream(request.transferId, createReadStream(path), {
      replace: request.replace === true,
    });
    await rm(path, { force: true });
    return result;
  }

  /** Destination: verify every byte before anything is admitted. */
  private stageStream(transferId: string, body: Readable, options: { replace: boolean }) {
    const id = BodyTransferIdSchema.parse(transferId);
    return this.serial(async () => {
      const known = this.current().transfers[id];
      if (known?.outcome === "applied" || known?.outcome === "applying")
        return { transferId: id, outcome: "applied" as const, files: 0, bytes: 0 };
      if (known !== undefined && known.outcome !== "staged") throw new BodyTransferError("transfer_id_used");
      const incoming = this.dir("incoming", id);
      await rm(incoming, { recursive: true, force: true });
      await mkdir(join(incoming, "files"), { recursive: true, mode: 0o700 });
      let manifest: BodyTransferManifest | undefined;
      let bytes = 0;
      const reader = new ByteReader(body.pipe(createGunzip()));
      try {
        if ((await reader.line()) !== BODY_TRANSFER_FORMAT) throw new BodyTransferError("bundle_format", 400);
        const length = Number(await reader.line());
        if (!Number.isSafeInteger(length) || length <= 0 || length > 512 * 1024 * 1024)
          throw new BodyTransferError("bundle_format", 400);
        manifest = BodyTransferManifestSchema.parse(
          JSON.parse((await reader.exact(length)).toString("utf8")),
        );
        if (manifest.transferId !== id) throw new BodyTransferError("bundle_transfer_mismatch", 400);
        await this.admit(manifest, options.replace);
        const covered = new Set(manifest.replaces.map((entry) => `${entry.root}/${entry.path}`));
        for (const file of manifest.files) {
          const parts = file.path.split("/");
          if (!parts.some((_, index) => covered.has(`${file.root}/${parts.slice(0, index + 1).join("/")}`)))
            throw new BodyTransferError("bundle_path_outside_moved_entries", 400);
          const target = join(incoming, "files", file.root, file.path);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          const hash = createHash("sha256");
          await pipeline(
            Readable.from(reader.stream(file.size)),
            async function* (chunks) {
              for await (const chunk of chunks) {
                hash.update(chunk as Buffer);
                yield chunk;
              }
            },
            createWriteStream(target, { mode: 0o600 }),
          );
          if (hash.digest("hex") !== file.sha256) throw new BodyTransferError("bundle_hash_mismatch", 400);
          bytes += file.size;
        }
        if (!(await reader.ended())) throw new BodyTransferError("bundle_trailing_bytes", 400);
      } catch (error) {
        await rm(incoming, { recursive: true, force: true });
        if (error instanceof BodyTransferError) throw error;
        throw new BodyTransferError(
          error instanceof SyntaxError ? "bundle_format" : "bundle_unreadable",
          400,
        );
      }
      await writeFile(join(incoming, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
      this.write(
        this.record(this.current(), id, {
          role: "destination",
          outcome: "staged",
          epoch: manifest.epoch,
          peer: manifest.source.label,
          ...(options.replace ? { replace: true } : {}),
        }),
      );
      return { transferId: id, outcome: "staged" as const, files: manifest.files.length, bytes };
    });
  }

  /** The destination is unclaimed, or the same self released at a lower epoch, or the owner replaces it. */
  private async admit(manifest: BodyTransferManifest, replace: boolean): Promise<void> {
    const self = this.read();
    if (self?.selfId === manifest.selfId) {
      if (self.state === "active") throw new BodyTransferError("self_already_active_here");
      if (manifest.epoch <= self.epoch) throw new BodyTransferError("stale_epoch");
      return;
    }
    if (replace) return;
    if (self?.selfId !== undefined) throw new BodyTransferError("destination_holds_another_clankie");
    if (await this.hasOwnHistory()) throw new BodyTransferError("destination_has_history");
  }

  /** Memory or a model conversation of its own; an empty fresh body has neither. */
  async hasOwnHistory(): Promise<boolean> {
    for (const path of MEMORY_ENTRIES)
      for await (const file of walk(this.roots.memory, path, [])) {
        if ((await stat(join(this.roots.memory, file))).size > 0) return true;
      }
    for (const path of ["captain/conversations", "captain/turns"])
      for await (const file of walk(this.roots.state, path, [])) {
        const session = path === "captain/turns" || file.includes("/pi/");
        if (session && (await stat(join(this.roots.state, file))).size > 0) return true;
      }
    return false;
  }

  /** Destination: persist the intent, then apply at the next boot before any store opens. */
  apply(input: unknown, cutover: BodyCutover | undefined): Promise<BodyAuthority> {
    const request = BodyTransferIdRequestSchema.parse(input);
    return this.serial(async () => {
      const self = this.current();
      const record = self.transfers[request.transferId];
      if (record?.role === "destination" && (record.outcome === "applied" || record.outcome === "applying"))
        return this.authority();
      if (record?.role !== "destination" || record.outcome !== "staged")
        throw new BodyTransferError("transfer_not_staged");
      const manifest = await this.stagedManifest(request.transferId);
      const applying: BodySelf = this.record(
        { ...self, selfId: manifest.selfId, state: "frozen", transferId: request.transferId },
        request.transferId,
        { ...record, outcome: "applying" },
      );
      delete applying.releasedTo;
      if (self.state === "active") {
        if (cutover === undefined) throw new BodyTransferError("cutover_unavailable", 503);
        if ((await cutover(async () => this.write(applying))) === "busy")
          throw new BodyTransferError("body_busy");
      } else this.write(applying);
      return this.authority();
    });
  }

  private async stagedManifest(transferId: string): Promise<BodyTransferManifest> {
    return BodyTransferManifestSchema.parse(
      JSON.parse(await readFile(this.dir("incoming", transferId, "manifest.json"), "utf8")),
    );
  }

  /**
   * Boot: finish an apply this body committed to. Every step is repeatable, so a
   * crash part way comes back here, still dormant.
   */
  async boot(): Promise<void> {
    const self = this.read();
    const id = self?.transferId;
    const record = id === undefined ? undefined : self?.transfers[id];
    if (
      self?.state === "frozen" &&
      id !== undefined &&
      record?.role === "destination" &&
      record.outcome === "applying"
    )
      try {
        await this.applyStaged(self, id, record);
      } catch (error) {
        this.bootError = error instanceof Error ? error.message : String(error);
      }
    this.bootedDormant = this.current().state !== "active";
  }

  private async applyStaged(self: BodySelf, id: string, record: BodyTransferRecord): Promise<void> {
    const manifest = await this.stagedManifest(id);
    const incoming = this.dir("incoming", id);
    const archive = this.dir("archive", id);
    for (const entry of manifest.replaces) {
      const target = join(this.roots[entry.root], entry.path);
      const archived = join(archive, entry.root, entry.path);
      const staged = join(incoming, "files", entry.root, entry.path);
      // rename is atomic: an existing target with an archived copy is already installed.
      if (existsSync(target) && !existsSync(archived)) {
        await mkdir(dirname(archived), { recursive: true, mode: 0o700 });
        await rename(target, archived);
      }
      if (existsSync(staged) && !existsSync(target)) {
        await mkdir(dirname(target), { recursive: true });
        await rename(staged, target);
      }
    }
    const archivedSettings = join(archive, "settings.json");
    if (!existsSync(archivedSettings)) {
      await mkdir(archive, { recursive: true, mode: 0o700 });
      if (existsSync(this.settings.path)) await copyFile(this.settings.path, archivedSettings);
      else await writeFile(archivedSettings, "{}\n", { mode: 0o600 });
    }
    await this.settings.update((current) => ({ ...current, ...manifest.settings }) as typeof current);
    await rm(incoming, { recursive: true, force: true });
    const active: BodySelf = this.record(
      { ...self, selfId: manifest.selfId, epoch: manifest.epoch, state: "active", transferId: id },
      id,
      { ...record, outcome: "applied" },
    );
    delete active.releasedTo;
    this.write(active);
  }

  /** Destination: burn an id that was never applied, so a late apply can never happen. */
  discard(input: unknown): Promise<BodyAuthority> {
    const request = BodyTransferIdRequestSchema.parse(input);
    return this.serial(async () => {
      const self = this.current();
      const record = self.transfers[request.transferId];
      if (record?.outcome === "applied" || record?.outcome === "applying")
        throw new BodyTransferError("transfer_applied");
      if (record?.role === "source") throw new BodyTransferError("transfer_is_outgoing_here");
      await rm(this.dir("incoming", request.transferId), { recursive: true, force: true });
      this.write(
        this.record(self, request.transferId, {
          role: "destination",
          outcome: "burned",
          epoch: record?.epoch ?? Math.max(1, self.epoch),
          peer: record?.peer ?? "discarded before staging",
        }),
      );
      return this.authority({ transfers: true });
    });
  }

  /** Destination, active: the source machine joined; its workspaces run there now. */
  rebind(input: unknown): Promise<{ rebound: number }> {
    const request = BodyTransferRebindRequestSchema.parse(input);
    return this.serial(async () => {
      const self = this.current();
      const record = self.transfers[request.transferId];
      if (self.state !== "active" || record?.role !== "destination" || record.outcome !== "applied")
        throw new BodyTransferError("transfer_not_applied_here");
      const from = transferredMachineId(request.transferId);
      let rebound = 0;
      await this.settings.update((current) => ({
        ...current,
        projects: {
          ...current.projects,
          projects: current.projects.projects.map((project) => ({
            ...project,
            workspaces: project.workspaces.map((workspace) =>
              workspace.machineId === from
                ? (rebound++, { ...workspace, machineId: request.machineId })
                : workspace,
            ),
            worktreeRoots: project.worktreeRoots.map((root) =>
              root.machineId === from ? { ...root, machineId: request.machineId } : root,
            ),
          })),
        },
      }));
      return { rebound };
    });
  }
}

/** Owner settings that move, with this machine's workspaces marked for rebinding. */
function movedSettings(
  settings: Record<string, unknown>,
  transferId: string,
  destinationMachineId: string | undefined,
): Record<string, unknown> {
  const machine = (id: string) =>
    id === "local" ? transferredMachineId(transferId) : id === destinationMachineId ? "local" : id;
  const moved: Record<string, unknown> = {};
  for (const key of MOVED_SETTINGS)
    if (settings[key] !== undefined) moved[key] = structuredClone(settings[key]);
  const captain = moved.captain as Record<string, unknown> | undefined;
  if (captain !== undefined) for (const key of STAYING_CAPTAIN_SETTINGS) delete captain[key];
  const projects = moved.projects as
    | { projects: { workspaces: { machineId: string }[]; worktreeRoots: { machineId: string }[] }[] }
    | undefined;
  for (const project of projects?.projects ?? []) {
    for (const workspace of project.workspaces) workspace.machineId = machine(workspace.machineId);
    for (const root of project.worktreeRoots) root.machineId = machine(root.machineId);
  }
  return moved;
}

async function topLevel(root: string, known: readonly string[]): Promise<string[]> {
  let present: string[] = [];
  try {
    present = (await readdir(root)).filter((name) => !name.startsWith("."));
  } catch {
    /* An absent root moves nothing but still replaces the known entries. */
  }
  return [...new Set([...known, ...present])].sort();
}

/** Regular files under one entry, as root-relative paths. Links and SQLite shared memory never move. */
async function* walk(root: string, path: string, skipped: string[]): AsyncGenerator<string> {
  let info;
  try {
    info = await lstat(join(root, path));
  } catch {
    return;
  }
  if (info.isSymbolicLink()) skipped.push(`link not moved: ${path}`);
  else if (info.isFile()) {
    if (path.endsWith("-shm")) return;
    yield path;
  } else if (info.isDirectory())
    for (const name of (await readdir(join(root, path))).sort())
      yield* walk(root, `${path}/${name}`, skipped);
}

async function retainedNames(stateRoot: string, moved: ReadonlySet<string>): Promise<string[]> {
  const names: string[] = [];
  for (const name of await readdir(stateRoot).catch(() => [] as string[])) {
    if (name === "captain") {
      for (const inner of await readdir(join(stateRoot, "captain")).catch(() => [] as string[]))
        if (!moved.has(`captain/${inner}`)) names.push(`captain/${inner}`);
    } else if (!moved.has(name) && name !== "memory" && name !== "attachments") names.push(name);
  }
  return names.sort();
}

async function digest(path: string): Promise<{ size: number; sha256: string }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { size, sha256: hash.digest("hex") };
}

/** Sequential reads over a byte stream: lines, exact lengths and bounded sub-streams. */
class ByteReader {
  private buffer = Buffer.alloc(0);
  private done = false;
  private readonly chunks: AsyncIterator<Buffer>;

  constructor(stream: Readable) {
    this.chunks = stream[Symbol.asyncIterator]();
  }

  private async fill(): Promise<boolean> {
    if (this.done) return false;
    const next = await this.chunks.next();
    if (next.done) {
      this.done = true;
      return false;
    }
    this.buffer = Buffer.concat([this.buffer, next.value]);
    return true;
  }

  async line(): Promise<string> {
    for (;;) {
      const end = this.buffer.indexOf(10);
      if (end >= 0 && end <= 256) {
        const line = this.buffer.subarray(0, end).toString("utf8");
        this.buffer = this.buffer.subarray(end + 1);
        return line;
      }
      if (this.buffer.length > 256 || !(await this.fill())) throw new BodyTransferError("bundle_format", 400);
    }
  }

  async exact(length: number): Promise<Buffer> {
    while (this.buffer.length < length)
      if (!(await this.fill())) throw new BodyTransferError("bundle_truncated", 400);
    const value = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return value;
  }

  async *stream(length: number): AsyncGenerator<Buffer> {
    let remaining = length;
    while (remaining > 0) {
      if (this.buffer.length === 0 && !(await this.fill()))
        throw new BodyTransferError("bundle_truncated", 400);
      const take = Math.min(remaining, this.buffer.length);
      yield this.buffer.subarray(0, take);
      this.buffer = this.buffer.subarray(take);
      remaining -= take;
    }
  }

  async ended(): Promise<boolean> {
    while (this.buffer.length === 0) if (!(await this.fill())) return true;
    return false;
  }
}

type OwnerAuthorizer = (request: Request) => Promise<true | "authentication_required" | "forbidden">;

/**
 * Owner-only transfer routes. An active body freezes, stages, applies, discards
 * and rebinds; a dormant body exports, stages, applies, releases, aborts and
 * reclaims. Each method checks its own state, so both modes mount every route.
 */
export function createBodyTransferRoutes(options: {
  transfer: BodyTransfer;
  /** The owner: the operator bearer, or a paired device with Take Control. */
  authorize: OwnerAuthorizer;
  cutover?: BodyCutover;
  /** Dormant body: restart so boot applies what was committed. */
  restart?: () => void;
}): Hono {
  const { transfer } = options;
  const app = new Hono();
  app.use("/v1/body-transfer/*", async (context, next) => {
    context.header("cache-control", "no-store");
    const allowed = await options.authorize(context.req.raw);
    if (allowed !== true) return context.json({ error: allowed }, allowed === "forbidden" ? 403 : 401);
    await next();
  });
  const handle = async (context: Context, run: () => Promise<unknown>) => {
    try {
      return context.json((await run()) as object);
    } catch (error) {
      if (error instanceof BodyTransferError) return context.json({ error: error.code }, error.status);
      if (error instanceof Error && error.name === "ZodError")
        return context.json({ error: "malformed" }, 400);
      throw error;
    }
  };
  app.get(BODY_TRANSFER_STATUS_PATH, (context) =>
    handle(context, async () => ({
      ...transfer.authority({ transfers: true }),
      ...(transfer.bootError === undefined ? {} : { bootError: transfer.bootError }),
    })),
  );
  app.post(BODY_TRANSFER_FREEZE_PATH, (context) =>
    handle(context, async () => {
      if (options.cutover === undefined) throw new BodyTransferError("body_not_active");
      return transfer.freeze(await context.req.json(), options.cutover);
    }),
  );
  app.post(BODY_TRANSFER_BUNDLE_PATH, (context) =>
    handle(context, async () => transfer.bundleChunk(await context.req.json())),
  );
  app.post(BODY_TRANSFER_STAGE_CHUNK_PATH, (context) =>
    handle(context, async () => transfer.stageChunk(await context.req.json())),
  );
  app.post(BODY_TRANSFER_STAGE_PATH, (context) =>
    handle(context, async () => transfer.stage(await context.req.json())),
  );
  app.post(BODY_TRANSFER_APPLY_PATH, (context) =>
    handle(context, async () => {
      const input = BodyTransferIdRequestSchema.parse(await context.req.json());
      const before = transfer.read()?.transfers[input.transferId]?.outcome;
      const result = await transfer.apply(input, options.cutover);
      // A dormant body restarts only when this call committed the apply; a repeat is a no-op.
      if (options.cutover === undefined && before === "staged") setImmediate(() => options.restart?.());
      return result;
    }),
  );
  app.post(BODY_TRANSFER_RELEASE_PATH, (context) =>
    handle(context, async () => transfer.release(await context.req.json())),
  );
  app.post(BODY_TRANSFER_ABORT_PATH, (context) =>
    handle(context, async () => {
      const result = await transfer.abort(await context.req.json());
      setImmediate(() => options.restart?.());
      return result;
    }),
  );
  app.post(BODY_TRANSFER_RECLAIM_PATH, (context) =>
    handle(context, async () => {
      const result = await transfer.reclaim(await context.req.json());
      setImmediate(() => options.restart?.());
      return result;
    }),
  );
  app.post(BODY_TRANSFER_DISCARD_PATH, (context) =>
    handle(context, async () => transfer.discard(await context.req.json())),
  );
  app.post(BODY_TRANSFER_REBIND_PATH, (context) =>
    handle(context, async () => transfer.rebind(await context.req.json())),
  );
  return app;
}
