/** Public, node-free animation data. No renderer, executable plugin or art is included. */
export const SKIN_SPEC_VERSION = 1 as const;
export const WORLD_STATE_KEYS = [
  "idle",
  "walk",
  "work",
  "carry",
  "blocked",
  "sleep",
  "poof",
  "germinate",
  "wilt",
  "seed",
  "seed_sink",
  "celebrate",
  "talk",
  "listen",
] as const;
export const ROLE_WORK_STATE_KEYS = [
  "work_planner",
  "work_designer",
  "work_builder",
  "work_tester",
  "work_reviewer",
  "work_researcher",
] as const;
export const LEAD_STATE_KEYS = [
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
export const PET_STATE_KEYS = [
  ...LEAD_STATE_KEYS,
  "run_left",
  "run_right",
  "skid_left",
  "skid_right",
  "seed",
  "conduct",
  "read_message",
  "wilt",
  "wait",
  "work_type",
  "work_read",
  "work_write",
  "work_tinker",
  "voice_listen",
  "play_watch",
  "play_cheer",
] as const;
export const LIFECYCLE_STATE_KEYS = ["spawn", "handoff"] as const;
export type SkinState =
  | (typeof WORLD_STATE_KEYS)[number]
  | (typeof ROLE_WORK_STATE_KEYS)[number]
  | (typeof PET_STATE_KEYS)[number]
  | (typeof LIFECYCLE_STATE_KEYS)[number];
export const SKIN_STATES: readonly SkinState[] = [
  ...new Set<SkinState>([
    ...WORLD_STATE_KEYS,
    ...ROLE_WORK_STATE_KEYS,
    ...PET_STATE_KEYS,
    ...LIFECYCLE_STATE_KEYS,
  ]),
];
export type SkinRole = "lead" | "worker";
export type SkinPlayback = "loop" | "once" | "hold";
/** Strings in authored JSON; numeric IDs are allowed only after a client binds bundled assets. */
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
export interface SkinCell {
  width: number;
  height: number;
}
export interface SkinAnimationSequence {
  frames: SkinFrameId[];
  playback: SkinPlayback;
  fps?: number | undefined;
  frameDurationsMs?: number[] | undefined;
  /** A directional adapter may reuse right-facing pixels for a left-facing state. */
  mirrorX?: boolean | undefined;
}
export interface SkinAtlas {
  image: SkinAssetReference;
  width: number;
  height: number;
  frames: Record<SkinFrameId, SkinFrame>;
}
export interface SpriteSkinBody {
  kind: "2d";
  atlas: SkinAtlas;
  animations: { idle: SkinAnimationSequence } & Partial<Record<SkinState, SkinAnimationSequence>>;
  origin?: SkinPoint;
}
export interface ModelSkinAnimation {
  playback: SkinPlayback;
  /** Defaults to this state's name. Reuse a canonically named clip without copying tracks. */
  clip?: SkinState;
  /** Fractions of the baked clip duration; equal endpoints are allowed only for a hold. */
  range?: { from: number; to: number };
}
export interface ModelSkinBody {
  kind: "3d";
  model: SkinAssetReference;
  cell: SkinCell;
  fps: number;
  animations: { idle: ModelSkinAnimation } & Partial<Record<SkinState, ModelSkinAnimation>>;
  postProcess?: { kind: "pixel"; levels: number; outline: boolean };
}
export interface SkinAnimationPack {
  specVersion: typeof SKIN_SPEC_VERSION;
  id: string;
  version: string;
  displayName: string;
  roles: SkinRole[];
  body: SpriteSkinBody | ModelSkinBody;
  /** Rest-pose image for clients whose World, Messages and pairing remain 2D. */
  restStill?: SkinAssetReference;
}

/** Authored acts stay distinct; these are presentation fallbacks, not renamed states. */
export const SKIN_STATE_FALLBACKS: Partial<Record<SkinState, SkinState>> = {
  spawn: "germinate",
  handoff: "carry",
  walk_left: "walk",
  walk_right: "walk",
  walk_down: "walk",
  walk_up: "walk",
  run_left: "walk_left",
  run_right: "walk_right",
  skid_left: "walk_left",
  skid_right: "walk_right",
  work_type: "think",
  work_read: "think",
  work_write: "think",
  work_tinker: "think",
  think: "work",
  work_planner: "work",
  work_designer: "work",
  work_builder: "work",
  work_tester: "work",
  work_reviewer: "work",
  work_researcher: "work",
  read_message: "think",
  conduct: "lead",
  lead: "think",
  voice_listen: "listen",
  listen: "talk",
  play_watch: "play",
  play_cheer: "play",
  happy: "celebrate",
  celebrate: "idle",
  wilt: "sleep",
  fall_asleep: "sleep",
  wake: "idle",
  wait: "idle",
  seed: "happy",
};
export function resolveSkinState(body: SkinAnimationPack["body"], requested: SkinState): SkinState {
  let state = requested;
  const seen = new Set<SkinState>();
  while (!Object.hasOwn(body.animations, state)) {
    if (seen.has(state)) return "idle";
    seen.add(state);
    state = SKIN_STATE_FALLBACKS[state] ?? "idle";
  }
  return state;
}

/** Semantic inputs from the client. These do not grant actions or invent agent status. */
export const SKIN_EVENT_STATES = {
  hired: "spawn",
  report: "handoff",
  closed: "poof",
  thinking: "think",
  working: "work",
  blocked: "blocked",
  completed: "celebrate",
  speaking: "talk",
  listening: "listen",
  disconnected: "offline",
  sleep: "fall_asleep",
  wake: "wake",
  move: "walk",
  rest: "idle",
} as const satisfies Record<string, SkinState>;

export interface SkinSpecIssue {
  path: string;
  message: string;
}
export class SkinSpecError extends Error {
  override readonly name = "SkinSpecError";
  readonly issues: readonly SkinSpecIssue[];
  constructor(issues: readonly SkinSpecIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.issues = issues;
  }
}
const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256;
const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const asset = (v: unknown) => text(v) || integer(v);
const playback = (v: unknown) => v === "loop" || v === "once" || v === "hold";

/** Bounded structural validation before loading any asset. No filesystem or network access. */
export function skinAnimationPackIssues(input: unknown): SkinSpecIssue[] {
  const issues: SkinSpecIssue[] = [];
  const fail = (path: string, message: string) => {
    issues.push({ path, message });
  };
  const m = record(input);
  if (!m || m.specVersion !== SKIN_SPEC_VERSION) {
    fail("specVersion", "unsupported skin spec version");
    return issues;
  }
  for (const key of ["id", "version", "displayName"])
    if (!text(m[key])) fail(key, "must be a bounded non-empty string");
  if (!/^[a-z0-9][a-z0-9.-]{0,127}$/u.test(String(m.id))) fail("id", "must be a stable lowercase pack id");
  if (
    !Array.isArray(m.roles) ||
    !m.roles.length ||
    m.roles.length > 2 ||
    new Set(m.roles).size !== m.roles.length ||
    m.roles.some((v) => v !== "lead" && v !== "worker")
  )
    fail("roles", "must contain distinct lead and/or worker roles");
  if (m.restStill !== undefined && !asset(m.restStill)) fail("restStill", "must be an asset reference");
  const body = record(m.body);
  if (!body || (body.kind !== "2d" && body.kind !== "3d")) {
    fail("body.kind", "must be 2d or 3d");
    return issues;
  }
  const animations = record(body.animations);
  if (!animations || !Object.hasOwn(animations, "idle")) fail("body.animations.idle", "is required");
  if (animations && Object.keys(animations).length > SKIN_STATES.length) {
    fail("body.animations", "too many states");
    return issues;
  }
  let frames: Record<string, unknown> | undefined;
  if (body.kind === "2d") {
    const atlas = record(body.atlas);
    if (!asset(atlas?.image)) fail("body.atlas.image", "must be an asset reference");
    const width = atlas?.width,
      height = atlas?.height;
    if (
      !integer(width) ||
      !width ||
      width > 32768 ||
      !integer(height) ||
      !height ||
      height > 32768 ||
      width * height > 16777216
    )
      fail("body.atlas", "dimensions exceed the atlas budget");
    frames = record(atlas?.frames);
    if (!frames || !Object.keys(frames).length || Object.keys(frames).length > 8192) {
      fail("body.atlas.frames", "must contain bounded named frames");
      return issues;
    }
    for (const [id, candidate] of Object.entries(frames)) {
      const f = record(candidate);
      if (
        !text(id) ||
        !f ||
        !integer(f.x) ||
        !integer(f.y) ||
        !integer(f.width) ||
        !f.width ||
        !integer(f.height) ||
        !f.height ||
        !integer(width) ||
        !integer(height) ||
        f.x + f.width > width ||
        f.y + f.height > height
      )
        fail(`body.atlas.frames.${id}`, "must be an integer rectangle inside the atlas");
    }
    if (body.origin !== undefined) {
      const o = record(body.origin);
      if (!o || !integer(o.x) || !integer(o.y)) fail("body.origin", "must be a non-negative integer point");
    }
  } else {
    if (!asset(body.model)) fail("body.model", "must be an embedded-resource glTF asset reference");
    const cell = record(body.cell);
    if (
      !cell ||
      !integer(cell.width) ||
      !cell.width ||
      cell.width > 1024 ||
      !integer(cell.height) ||
      !cell.height ||
      cell.height > 1024
    )
      fail("body.cell", "must be a bounded positive integer cell");
    if (!positive(body.fps) || body.fps > 60) fail("body.fps", "must be positive and at most 60");
    if (body.postProcess !== undefined) {
      const p = record(body.postProcess);
      if (
        !p ||
        p.kind !== "pixel" ||
        !integer(p.levels) ||
        p.levels < 2 ||
        p.levels > 256 ||
        typeof p.outline !== "boolean"
      )
        fail("body.postProcess", "must be a bounded pixel filter");
    }
  }
  let playedFrames = 0;
  for (const [state, candidate] of Object.entries(animations ?? {})) {
    const path = `body.animations.${state}`,
      a = record(candidate);
    if (!(SKIN_STATES as readonly string[]).includes(state)) fail(path, "unknown animation state");
    if (!a || !playback(a.playback)) {
      fail(path, "must declare loop, once or hold playback");
      continue;
    }
    if (body.kind === "2d") {
      if (a.mirrorX !== undefined && typeof a.mirrorX !== "boolean")
        fail(`${path}.mirrorX`, "must be boolean");
      if (!Array.isArray(a.frames) || !a.frames.length || a.frames.length > 8192 || !a.frames.every(text)) {
        fail(`${path}.frames`, "must contain bounded frame ids");
        continue;
      }
      playedFrames += a.frames.length;
      if (playedFrames > 32768) {
        fail("body.animations", "too many played frames");
        return issues;
      }
      for (const id of a.frames)
        if (!frames || !Object.hasOwn(frames, id)) fail(`${path}.frames`, `unknown frame ${id}`);
      const fps = a.fps !== undefined,
        durations = a.frameDurationsMs !== undefined;
      if (
        fps === durations ||
        (fps && !positive(a.fps)) ||
        (durations &&
          (!Array.isArray(a.frameDurationsMs) ||
            a.frameDurationsMs.length !== a.frames.length ||
            !a.frameDurationsMs.every(positive)))
      )
        fail(path, "must declare exactly one timing per frame");
    } else {
      if (a.clip !== undefined && !(SKIN_STATES as readonly unknown[]).includes(a.clip))
        fail(`${path}.clip`, "must reference a canonical state clip");
      if (a.range !== undefined) {
        const r = record(a.range);
        if (
          !r ||
          typeof r.from !== "number" ||
          typeof r.to !== "number" ||
          !Number.isFinite(r.from) ||
          !Number.isFinite(r.to) ||
          r.from < 0 ||
          r.to > 1 ||
          r.from > r.to ||
          (r.from === r.to && a.playback !== "hold")
        )
          fail(`${path}.range`, "must be ordered fractions from 0 to 1; only hold may use one instant");
      }
    }
  }
  return issues;
}
export function loadSkinAnimationPack(input: unknown): SkinAnimationPack {
  const issues = skinAnimationPackIssues(input);
  if (issues.length) throw new SkinSpecError(issues);
  return input as SkinAnimationPack;
}

/** Call after parsing the actual GLB, before making a scene. Image bytes must be embedded. */
export function validateSkinModelAsset(pack: SkinAnimationPack, gltf: unknown): void {
  if (pack.body.kind !== "3d")
    throw new SkinSpecError([{ path: "body.kind", message: "requires a 3d pack" }]);
  const json = record(gltf),
    issues: SkinSpecIssue[] = [];
  const fail = (path: string, message: string) => {
    issues.push({ path, message });
  };
  if (record(json?.asset)?.version !== "2.0") fail("asset.version", "requires glTF 2.0");
  const clips = Array.isArray(json?.animations) ? json.animations.map((v) => record(v)?.name) : [];
  if (
    new Set(clips).size !== clips.length ||
    clips.some((v) => !(SKIN_STATES as readonly unknown[]).includes(v))
  )
    fail("animations", "clips must have unique canonical state names");
  for (const [state, a] of Object.entries(pack.body.animations))
    if (a && !clips.includes(a.clip ?? state)) fail(`animations.${state}`, `missing clip ${a.clip ?? state}`);
  for (const key of ["buffers", "images"]) {
    const values = json?.[key];
    if (values !== undefined && !Array.isArray(values)) {
      fail(key, "must be an array");
      continue;
    }
    for (const [i, value] of (Array.isArray(values) ? values : []).entries()) {
      const item = record(value);
      if (!item || item.uri !== undefined || (key === "images" && !integer(item.bufferView)))
        fail(`${key}.${i}`, "must be embedded in the GLB");
    }
  }
  if (issues.length) throw new SkinSpecError(issues);
}
