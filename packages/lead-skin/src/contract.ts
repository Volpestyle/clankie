/** Node-free lead-body contract, shared by installed compilers and client renderers. */
export const SKIN_CONTRACT_VERSION = 1 as const;
export const SKIN_LEAD_ANIMATION_KEYS = [
  "idle",
  "blink",
  "look_left",
  "look_right",
  "walk_left",
  "walk_right",
  "walk_down",
  "walk_up",
  "hop",
  "fall_asleep",
  "sleep",
  "wake",
  "think",
  "talk",
  "play",
  "alert",
  "happy",
  "catch",
  "offline",
  "rustle",
  "tap",
  "lead",
  "lift",
  "drop",
] as const;
export type SkinLeadAnimationKey = (typeof SKIN_LEAD_ANIMATION_KEYS)[number];
export type SkinAssetReference = string | number;
export type SkinFrameId = string;
export interface SkinPoint {
  x: number;
  y: number;
}
export interface SkinFrame extends SkinPoint {
  width: number;
  height: number;
}
export interface SkinAnimationSequence {
  frames: SkinFrameId[];
  playback: "loop" | "once" | "hold";
  fps?: number | undefined;
  frameDurationsMs?: number[] | undefined;
}
export interface SkinAtlas {
  image: SkinAssetReference;
  width: number;
  height: number;
  frames: Record<SkinFrameId, SkinFrame>;
}
export interface SkinLeadBody {
  atlas: SkinAtlas;
  scale?: number | undefined;
  bounds?: SkinFrame | undefined;
  animations: { idle: SkinAnimationSequence } & Partial<Record<string, SkinAnimationSequence>>;
  origin: SkinPoint;
  glyph?: SkinPoint | undefined;
}
export interface SkinLeadPackManifest {
  contractVersion: typeof SKIN_CONTRACT_VERSION;
  id: string;
  version: string;
  displayName: string;
  lead: SkinLeadBody;
}
export const LEAD_SKIN_LIMITS = Object.freeze({
  cellWidth: 32,
  cellHeight: 96,
  frames: 1024,
  playedFrames: 4096,
  atlasDimension: 32768,
  atlasPixels: 3145728,
  bytes: 8 * 1024 * 1024,
  manifestBytes: 1024 * 1024,
});
export type LeadSkinIssueCode =
  | "invalid_sequence"
  | "invalid_frames"
  | "unknown_frame"
  | "invalid_playback"
  | "invalid_timing"
  | "missing_required"
  | "anchor_out_of_bounds"
  | "lead_coverage";
export interface LeadSkinIssue {
  code?: LeadSkinIssueCode | undefined;
  path: string;
  message: string;
}
export class LeadSkinLoadError extends Error {
  override readonly name = "LeadSkinLoadError";
  readonly code: "incompatible_contract_version" | "invalid_manifest";
  readonly issues: readonly LeadSkinIssue[];
  readonly declaredContractVersion: unknown;
  constructor(
    code: "incompatible_contract_version" | "invalid_manifest",
    issues: readonly LeadSkinIssue[],
    declaredContractVersion?: unknown,
  ) {
    super(`Lead skin ${code}: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    this.code = code;
    this.issues = issues;
    this.declaredContractVersion = declaredContractVersion;
  }
}
function record(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}
const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256;
const inside = (p: SkinPoint, f: SkinFrame) => p.x >= 0 && p.y >= 0 && p.x <= f.width && p.y <= f.height;

/** Structural checks also apply to a lead embedded in a full client skin. */
export function leadBodyIssues(value: unknown): LeadSkinIssue[] {
  const issues: LeadSkinIssue[] = [];
  const fail = (path: string, message: string, code?: LeadSkinIssueCode) =>
    issues.push({ path, message, ...(code ? { code } : {}) });
  const lead = record(value);
  if (!lead) {
    fail("lead", "must be a lead body object");
    return issues;
  }
  const atlas = record(lead.atlas);
  if (!atlas || !(text(atlas.image) || integer(atlas.image)))
    fail("lead.atlas.image", "must be a URI/path or bundled numeric asset id");
  const width = atlas?.width,
    height = atlas?.height;
  if (
    !integer(width) ||
    width === 0 ||
    width > LEAD_SKIN_LIMITS.atlasDimension ||
    !integer(height) ||
    height === 0 ||
    height > LEAD_SKIN_LIMITS.cellHeight ||
    width * height > LEAD_SKIN_LIMITS.atlasPixels
  )
    fail("lead.atlas", "dimensions exceed the lead atlas limits");
  const frames = record(atlas?.frames);
  if (!frames || Object.keys(frames).length === 0 || Object.keys(frames).length > LEAD_SKIN_LIMITS.frames) {
    fail("lead.atlas.frames", "must contain bounded named frames");
    return issues;
  }
  for (const [id, v] of Object.entries(frames ?? {})) {
    const f = record(v);
    if (
      !text(id) ||
      !f ||
      !integer(f.x) ||
      !integer(f.y) ||
      !integer(f.width) ||
      f.width === 0 ||
      f.width > LEAD_SKIN_LIMITS.cellWidth ||
      !integer(f.height) ||
      f.height === 0 ||
      f.height > LEAD_SKIN_LIMITS.cellHeight ||
      !integer(width) ||
      !integer(height) ||
      f.x + f.width > width ||
      f.y + f.height > height
    )
      fail(
        `lead.atlas.frames.${id}`,
        "must be a bounded integer rectangle inside the atlas",
        "anchor_out_of_bounds",
      );
  }
  if (lead.scale !== undefined && !positive(lead.scale)) fail("lead.scale", "must be positive");
  const origin = record(lead.origin);
  if (!origin || !integer(origin.x) || !integer(origin.y))
    fail("lead.origin", "must be a non-negative integer point");
  const glyph = record(lead.glyph);
  if (
    lead.glyph !== undefined &&
    (!glyph ||
      typeof glyph.x !== "number" ||
      !Number.isFinite(glyph.x) ||
      typeof glyph.y !== "number" ||
      !Number.isFinite(glyph.y))
  )
    fail("lead.glyph", "must be a finite frame-local point");
  const animations = record(lead.animations);
  if (!animations || animations.idle === undefined)
    fail("lead.animations.idle", "is required", "missing_required");
  if (animations && Object.keys(animations).length > 128) {
    fail("lead.animations", "too many animations");
    return issues;
  }
  let playedFrames = 0;
  for (const [name, v] of Object.entries(animations ?? {})) {
    const p = `lead.animations.${name}`,
      s = record(v);
    if (!text(name) || !s) {
      fail(p, "must be an animation sequence", "invalid_sequence");
      continue;
    }
    if (
      !Array.isArray(s.frames) ||
      s.frames.length === 0 ||
      s.frames.length > LEAD_SKIN_LIMITS.playedFrames ||
      !s.frames.every(text)
    ) {
      fail(`${p}.frames`, "must contain bounded frame ids", "invalid_frames");
      continue;
    }
    playedFrames += s.frames.length;
    if (playedFrames > LEAD_SKIN_LIMITS.playedFrames) {
      fail("lead.animations", "too many played frames", "invalid_frames");
      return issues;
    }
    for (const id of s.frames)
      if (!frames || !Object.hasOwn(frames, id))
        fail(`${p}.frames`, `references unknown frame ${id}`, "unknown_frame");
    if (!["loop", "once", "hold"].includes(String(s.playback)))
      fail(`${p}.playback`, "must be loop, once, or hold", "invalid_playback");
    const fps = s.fps !== undefined,
      durations = s.frameDurationsMs !== undefined;
    if (
      fps === durations ||
      (fps && !positive(s.fps)) ||
      (durations &&
        (!Array.isArray(s.frameDurationsMs) ||
          s.frameDurationsMs.length !== s.frames.length ||
          !s.frameDurationsMs.every(positive)))
    )
      fail(p, "must declare exactly one valid timing per frame", "invalid_timing");
  }
  const idle = record(animations?.idle),
    ids = idle?.frames;
  const f = Array.isArray(ids) ? record(frames?.[ids[0]]) : undefined;
  const bounds = record(lead.bounds);
  if (
    lead.bounds !== undefined &&
    (!bounds ||
      !integer(bounds.x) ||
      !integer(bounds.y) ||
      !integer(bounds.width) ||
      bounds.width === 0 ||
      !integer(bounds.height) ||
      bounds.height === 0 ||
      !f ||
      !integer(f.width) ||
      !integer(f.height) ||
      bounds.x + bounds.width > f.width ||
      bounds.y + bounds.height > f.height)
  )
    fail("lead.bounds", "must fit inside the first idle frame", "anchor_out_of_bounds");
  if (!issues.length) issues.push(...leadBodyReviewIssues(value as SkinLeadBody));
  return issues;
}
export function leadBodyReviewIssues(lead: SkinLeadBody): LeadSkinIssue[] {
  const issues: LeadSkinIssue[] = [];
  const idle = lead.atlas.frames[lead.animations.idle.frames[0]!]!;
  for (const [name, s] of Object.entries(lead.animations))
    for (const id of s?.frames ?? []) {
      const f = lead.atlas.frames[id]!;
      if (f.width !== idle.width || f.height !== idle.height || !inside(lead.origin, f))
        issues.push({
          code: "anchor_out_of_bounds",
          path: "lead.origin",
          message: `must fit same-sized frame ${id} used by ${name}`,
        });
    }
  return issues;
}
export function loadSkinLeadPack(input: unknown): SkinLeadPackManifest {
  const m = record(input);
  if (!m || m.contractVersion !== SKIN_CONTRACT_VERSION)
    throw new LeadSkinLoadError("incompatible_contract_version", [], m?.contractVersion);
  const issues = leadBodyIssues(m.lead);
  for (const key of ["id", "version", "displayName"])
    if (!text(m[key])) issues.push({ path: key, message: "must be a bounded non-empty string" });
  if (!/^[a-z0-9][a-z0-9.-]{0,127}$/u.test(String(m.id)))
    issues.push({ path: "id", message: "must be an appearance-compatible id" });
  if (issues.length) throw new LeadSkinLoadError("invalid_manifest", issues);
  return input as SkinLeadPackManifest;
}
/** Mechanical coverage is necessary; publication also requires owner pose approval and visual review. */
export function validateSkinLeadPackForReview(input: unknown): SkinLeadPackManifest {
  const m = loadSkinLeadPack(input),
    issues = leadBodyReviewIssues(m.lead);
  for (const name of SKIN_LEAD_ANIMATION_KEYS)
    if (!m.lead.animations[name])
      issues.push({ code: "lead_coverage", path: `lead.animations.${name}`, message: "must be authored" });
  if (issues.length) throw new LeadSkinLoadError("invalid_manifest", issues);
  return m;
}
