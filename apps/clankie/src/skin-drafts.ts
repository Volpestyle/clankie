import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { sampleReference, decodePNG, decodeReference, digest, IMAGE_LIMITS } from "@clankie/lead-skin";
import {
  SKIN_KEY_POSES,
  SkinDraftCommandSchema,
  SkinDraftSchema,
  type SkinDraft,
  type SkinDraftCommand,
  type SkinDraftReference,
  type SkinDraftResult,
  type SkinKeyPose,
} from "@clankie/protocol/skin-drafts";
import { authorizeQuestion, type QuestionAuthority } from "./captain/conversation-questions.ts";
import type { DeliveredFileStore } from "./delivered-files.ts";
import { withSerializedLock } from "./app/request-state.ts";

const locks = new Map<string, Promise<unknown>>();
const RecordSchema = z
  .object({
    creationDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    draft: SkinDraftSchema,
  })
  .strict();
type Record = z.infer<typeof RecordSchema>;

export class SkinDraftError extends Error {
  readonly code: string;
  readonly status: 400 | 403 | 404 | 409 | 413;
  constructor(code: string, status: SkinDraftError["status"]) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
async function authorized(authority: QuestionAuthority | undefined) {
  try {
    await authorizeQuestion(authority);
  } catch {
    throw new SkinDraftError("skin_draft_owner_required", 403);
  }
}
async function bounded(path: string, limit: number) {
  const file = await open(path, "r");
  try {
    if ((await file.stat()).size > limit) throw new SkinDraftError("skin_draft_bytes_exceeded", 413);
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await file.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    if (count > limit) throw new SkinDraftError("skin_draft_bytes_exceeded", 413);
    return bytes.subarray(0, count);
  } finally {
    await file.close();
  }
}
async function atomic(path: string, bytes: Buffer) {
  const pending = path + "." + randomUUID() + ".pending";
  try {
    await writeFile(pending, bytes, { mode: 0o600, flag: "wx" });
    await rename(pending, path);
  } finally {
    await rm(pending, { force: true });
  }
}
function seal(input: Omit<SkinDraft, "revision"> | SkinDraft): SkinDraft {
  const parsed = SkinDraftSchema.parse({ ...input, revision: "0".repeat(64) });
  return { ...parsed, revision: digest(Buffer.from(JSON.stringify({ ...parsed, revision: undefined }))) };
}
const complete = (draft: SkinDraft) => SKIN_KEY_POSES.every((pose) => draft.poses[pose]);

/** One host-proven owner domain. No provider dispatch, animation or appearance mutation. */
export class SkinDraftService {
  private readonly root: string;
  readonly owner: string;
  private readonly files: Pick<DeliveredFileStore, "attachment" | "read">;
  constructor(options: {
    root: string;
    /** Stable owner account selected by the host, never a request or model field. */
    ownerId: string;
    files: Pick<DeliveredFileStore, "attachment" | "read">;
  }) {
    if (!options.ownerId) throw Error("skin_draft_owner_missing");
    this.owner = createHash("sha256").update(options.ownerId).digest("hex");
    this.root = resolve(options.root, this.owner);
    this.files = options.files;
  }
  private async read(id: string, version?: number): Promise<Record | undefined> {
    // current.json is the commit marker. A revoked/crashed write may have staged
    // a future history file, but it must never become a visible revision.
    if (version !== undefined) {
      const current = await this.read(id);
      if (!current || version > current.draft.version) return undefined;
      if (version === current.draft.version) return current;
    }
    const path = join(
      this.root,
      "drafts",
      id,
      version === undefined ? "current.json" : "v" + version + ".json",
    );
    let bytes: Buffer;
    try {
      bytes = await bounded(path, 64 * 1024);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const parsed = RecordSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    if (!parsed.success || parsed.data.draft.owner !== this.owner || parsed.data.draft.id !== id)
      throw new SkinDraftError("skin_draft_storage_invalid", 409);
    const draft = parsed.data.draft;
    if (
      seal(draft).revision !== draft.revision ||
      (version !== undefined && draft.version !== version) ||
      (draft.state === "approved" && (!complete(draft) || !draft.approval)) ||
      (draft.state !== "approved" && draft.approval) ||
      (draft.approval &&
        (draft.approval.owner !== this.owner ||
          SKIN_KEY_POSES.some((pose) => draft.approval!.poseDigests[pose] !== draft.poses[pose]?.sha256)))
    )
      throw new SkinDraftError("skin_draft_storage_invalid", 409);
    return parsed.data;
  }
  private async blob(bytes: Buffer): Promise<string> {
    const sha = digest(bytes);
    const directory = join(this.root, "blobs");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, sha);
    // Content is copied into this owner's private store; conversation retention cannot alter a draft.
    await atomic(path, bytes);
    return sha;
  }
  private async source(reference: SkinDraftReference, draft?: SkinDraft) {
    // A previously committed owner input remains usable after conversation retention.
    const stored = [draft?.reference, ...Object.values(draft?.poses ?? {}).map((pose) => pose?.source)].find(
      (source) =>
        source?.conversationId === reference.conversationId && source.artifactId === reference.artifactId,
    );
    if (stored) {
      const bytes = await this.sourceBytes(stored);
      return { bytes, source: stored };
    }
    if (!(await this.files.attachment(reference.conversationId, reference.artifactId)))
      throw new SkinDraftError("skin_draft_reference_not_found", 404);
    const found = await this.files.read(reference.conversationId, reference.artifactId);
    if (!found) throw new SkinDraftError("skin_draft_reference_not_found", 404);
    if (!(["image/png", "image/jpeg"] as string[]).includes(found.file.mediaType))
      throw new SkinDraftError("skin_draft_reference_format", 400);
    if (found.data.length > IMAGE_LIMITS.bytes) throw new SkinDraftError("skin_draft_bytes_exceeded", 413);
    try {
      decodeReference(found.data);
    } catch {
      throw new SkinDraftError("skin_draft_invalid_reference", 400);
    }
    return {
      bytes: found.data,
      source: {
        ...reference,
        sha256: digest(found.data),
        byteCount: found.data.length,
        mediaType: found.file.mediaType as "image/png" | "image/jpeg",
      },
    };
  }
  private async save(record: Record, authority: QuestionAuthority) {
    const directory = join(this.root, "drafts", record.draft.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(JSON.stringify(record));
    await authorized(authority);
    await atomic(join(directory, "v" + record.draft.version + ".json"), bytes);
    await authorized(authority);
    await atomic(join(directory, "current.json"), bytes);
  }
  async handle(authority: QuestionAuthority | undefined, value: SkinDraftCommand): Promise<SkinDraftResult> {
    await authorized(authority);
    const parsed = SkinDraftCommandSchema.safeParse(value);
    if (!parsed.success) throw new SkinDraftError("skin_draft_malformed", 400);
    const command = parsed.data;
    return withSerializedLock(locks, this.root, async () => {
      await authorized(authority);
      if (command.action === "list") {
        const ids = await readdir(join(this.root, "drafts")).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
        const drafts: SkinDraft[] = [];
        for (const id of ids.sort()) {
          if (!z.uuid().safeParse(id).success) continue;
          const record = await this.read(id);
          if (record) drafts.push(record.draft);
        }
        if (drafts.length > 128) throw new SkinDraftError("skin_draft_count_exceeded", 413);
        await authorized(authority);
        return { outcome: "list", drafts };
      }
      if (command.action === "create") {
        const creationDigest = digest(Buffer.from(JSON.stringify(command)));
        const prior = await this.read(command.requestId);
        if (prior) {
          if (prior.creationDigest !== creationDigest)
            throw new SkinDraftError("skin_draft_request_conflict", 409);
          await authorized(authority);
          return { outcome: "draft", draft: prior.draft };
        }
        if (
          (
            await readdir(join(this.root, "drafts")).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return [];
              throw error;
            })
          ).length >= 128
        )
          throw new SkinDraftError("skin_draft_count_exceeded", 413);
        const reference = command.reference ? await this.source(command.reference) : undefined;
        if (reference) await this.blob(reference.bytes);
        const now = new Date().toISOString();
        const draft = seal({
          schemaVersion: 1,
          id: command.requestId,
          owner: this.owner,
          version: 1,
          description: command.description,
          state: "awaiting_poses",
          generation: "not_requested",
          createdAt: now,
          updatedAt: now,
          poses: {},
          ...(reference ? { reference: reference.source } : {}),
        });
        await this.save({ creationDigest, draft }, authority!);
        return { outcome: "draft", draft };
      }
      const record = await this.read(command.draftId, command.action === "get" ? command.version : undefined);
      if (!record) throw new SkinDraftError("skin_draft_not_found", 404);
      if (command.action === "get") {
        await authorized(authority);
        return { outcome: "draft", draft: record.draft };
      }
      const before = record.draft;
      if (before.revision !== command.expectedRevision) throw new SkinDraftError("skin_draft_conflict", 409);
      if (before.state === "cancelled") throw new SkinDraftError("skin_draft_cancelled", 409);
      if (before.version >= 64) throw new SkinDraftError("skin_draft_versions_exceeded", 413);
      let draft: SkinDraft = { ...before, version: before.version + 1, updatedAt: new Date().toISOString() };
      delete draft.approval;
      if (command.action === "pose") {
        if (command.pose !== "rest" && !before.poses.rest)
          throw new SkinDraftError("skin_draft_rest_required", 409);
        const source = await this.source(command.source, before);
        let sampled;
        try {
          sampled = sampleReference(source.bytes, {
            grid: {
              pitch: command.sampling.grid.pitch,
              columns: command.sampling.grid.columns,
              rows: command.sampling.grid.rows,
              ...(command.sampling.grid.x === undefined ? {} : { x: command.sampling.grid.x }),
              ...(command.sampling.grid.y === undefined ? {} : { y: command.sampling.grid.y }),
            },
            ...(command.sampling.background === undefined ? {} : { background: command.sampling.background }),
            ...(command.sampling.backgroundTolerance === undefined
              ? {}
              : { backgroundTolerance: command.sampling.backgroundTolerance }),
            ...(command.sampling.colors === undefined ? {} : { colors: command.sampling.colors }),
            ...(command.pose !== "rest" ? { approvedPalette: before.poses.rest!.palette } : {}),
          });
        } catch {
          throw new SkinDraftError("skin_draft_invalid_sampling", 400);
        }
        if (!sampled.palette.length || !sampled.image.rgba.some((byte, at) => at % 4 === 3 && byte === 255))
          throw new SkinDraftError("skin_draft_empty_pose", 400);
        if (
          command.pose !== "rest" &&
          (sampled.image.width !== before.poses.rest!.width ||
            sampled.image.height !== before.poses.rest!.height)
        )
          throw new SkinDraftError("skin_draft_pose_geometry", 400);
        const sourceSha = await this.blob(source.bytes);
        if (sourceSha !== source.source.sha256) throw new SkinDraftError("skin_draft_reference_changed", 409);
        const sha = await this.blob(sampled.png);
        draft.poses = {
          ...(command.pose === "rest" ? {} : before.poses),
          [command.pose]: {
            source: source.source,
            sampling: command.sampling,
            sha256: sha,
            width: sampled.image.width,
            height: sampled.image.height,
            palette: sampled.palette as [number, number, number][],
          },
        };
        draft.state = complete(draft) ? "awaiting_approval" : "awaiting_poses";
      } else if (command.action === "revise") {
        draft.description = command.description;
        draft.state = complete(draft) ? "awaiting_approval" : "awaiting_poses";
      } else if (command.action === "approve") {
        if (before.state !== "awaiting_approval" || !complete(before))
          throw new SkinDraftError("skin_draft_poses_required", 409);
        for (const pose of SKIN_KEY_POSES) {
          await this.poseBytes(before, pose, "source");
          await this.poseBytes(before, pose, "native");
        }
        draft.state = "approved";
        draft.approval = {
          owner: this.owner,
          actor: { ...authority!.principal },
          revision: before.revision,
          poseDigests: {
            rest: before.poses.rest!.sha256,
            work: before.poses.work!.sha256,
            comms: before.poses.comms!.sha256,
          },
          approvedAt: draft.updatedAt,
        };
      } else draft.state = command.action === "cancel" ? "cancelled" : "declined";
      draft = seal(draft);
      await this.save({ ...record, draft }, authority!);
      return { outcome: "draft", draft };
    });
  }
  private async sourceBytes(source: NonNullable<SkinDraft["reference"]>) {
    const bytes = await bounded(join(this.root, "blobs", source.sha256), IMAGE_LIMITS.bytes);
    if (digest(bytes) !== source.sha256 || bytes.length !== source.byteCount)
      throw new SkinDraftError("skin_draft_artifact_changed", 409);
    return bytes;
  }
  async referencePreview(authority: QuestionAuthority | undefined, id: string, revision: string) {
    await authorized(authority);
    if (!z.uuid().safeParse(id).success || !/^[a-f0-9]{64}$/u.test(revision))
      throw new SkinDraftError("skin_draft_malformed", 400);
    const record = await this.read(id);
    if (!record?.draft.reference) throw new SkinDraftError("skin_draft_reference_not_found", 404);
    if (record.draft.revision !== revision) throw new SkinDraftError("skin_draft_conflict", 409);
    const source = record.draft.reference;
    const bytes = await this.sourceBytes(source);
    await authorized(authority);
    return { bytes, sha256: source.sha256, mediaType: source.mediaType };
  }
  private async poseBytes(draft: SkinDraft, pose: SkinKeyPose, kind: "source" | "native") {
    const entry = draft.poses[pose];
    if (!entry) throw new SkinDraftError("skin_draft_pose_not_found", 404);
    const sha = kind === "native" ? entry.sha256 : entry.source.sha256;
    const bytes = await bounded(join(this.root, "blobs", sha), IMAGE_LIMITS.bytes);
    if (digest(bytes) !== sha) throw new SkinDraftError("skin_draft_artifact_changed", 409);
    if (kind === "native") {
      const decoded = decodePNG(bytes);
      if (decoded.width !== entry.width || decoded.height !== entry.height)
        throw new SkinDraftError("skin_draft_artifact_changed", 409);
    }
    return { bytes, sha256: sha, mediaType: kind === "native" ? "image/png" : entry.source.mediaType };
  }
  async preview(
    authority: QuestionAuthority | undefined,
    id: string,
    pose: SkinKeyPose,
    revision: string,
    kind: "source" | "native",
  ) {
    await authorized(authority);
    if (
      !z.uuid().safeParse(id).success ||
      !SKIN_KEY_POSES.includes(pose) ||
      !/^[a-f0-9]{64}$/u.test(revision) ||
      !["source", "native"].includes(kind)
    )
      throw new SkinDraftError("skin_draft_malformed", 400);
    const record = await this.read(id);
    if (!record) throw new SkinDraftError("skin_draft_not_found", 404);
    if (record.draft.revision !== revision) throw new SkinDraftError("skin_draft_conflict", 409);
    const image = await this.poseBytes(record.draft, pose, kind);
    await authorized(authority);
    return image;
  }
}
