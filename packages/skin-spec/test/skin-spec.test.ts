import { describe, expect, it } from "vitest";
import {
  loadSkinAnimationPack,
  resolveSkinState,
  validateSkinModelAsset,
  SkinSpecError,
  type SkinAnimationPack,
} from "../src/index.ts";

const sprite = {
  specVersion: 1,
  id: "example.sprite",
  version: "1.0.0",
  displayName: "Example",
  roles: ["worker"],
  body: {
    kind: "2d",
    atlas: {
      image: "atlas.png",
      width: 2,
      height: 1,
      frames: { a: { x: 0, y: 0, width: 1, height: 1 }, b: { x: 1, y: 0, width: 1, height: 1 } },
    },
    animations: { idle: { frames: ["a", "b"], playback: "loop", frameDurationsMs: [100, 200] } },
  },
} satisfies SkinAnimationPack;
const model = {
  ...sprite,
  id: "example.model",
  roles: ["lead"],
  body: {
    kind: "3d",
    model: "body.glb",
    cell: { width: 40, height: 64 },
    fps: 12,
    animations: {
      idle: { playback: "loop" },
      think: { playback: "loop" },
      work_type: { clip: "think", playback: "loop" },
      sleep: { clip: "think", playback: "hold", range: { from: 0.5, to: 0.5 } },
    },
    postProcess: { kind: "pixel", levels: 4, outline: true },
  },
} satisfies SkinAnimationPack;

describe("published animation pack contract", () => {
  it("loads both body kinds through one API, preserving timing and shared clips", () => {
    expect(loadSkinAnimationPack(sprite)).toBe(sprite);
    expect(loadSkinAnimationPack(model)).toBe(model);
    validateSkinModelAsset(model, {
      asset: { version: "2.0" },
      animations: [{ name: "idle" }, { name: "think" }],
      images: [{ bufferView: 0 }],
      buffers: [{ byteLength: 8 }],
    });
    expect(resolveSkinState(model.body, "work_read")).toBe("think");
    expect(resolveSkinState(sprite.body, "poof")).toBe("idle");
  });
  it("rejects bad atlas bounds, references, timings, states and unsupported versions", () => {
    for (const mutate of [
      (p: typeof sprite) => {
        p.specVersion = 2 as 1;
      },
      (p: typeof sprite) => {
        p.body.atlas.frames.a.x = 2;
      },
      (p: typeof sprite) => {
        p.body.animations.idle.frames[0] = "absent";
      },
      (p: typeof sprite) => {
        p.body.animations.idle.frameDurationsMs.pop();
      },
      (p: typeof sprite) => {
        Object.assign(p.body.animations, { unknown: p.body.animations.idle });
      },
    ]) {
      const p = structuredClone(sprite);
      mutate(p);
      expect(() => loadSkinAnimationPack(p)).toThrow(SkinSpecError);
    }
  });
  it("rejects invalid ranges, missing or duplicate clips and external GLB resources", () => {
    const p = structuredClone(model);
    p.body.animations.sleep.range.from = 0.8;
    p.body.animations.sleep.range.to = 0.2;
    expect(() => loadSkinAnimationPack(p)).toThrow(SkinSpecError);
    for (const gltf of [
      { asset: { version: "2.0" }, animations: [{ name: "idle" }] },
      { asset: { version: "2.0" }, animations: [{ name: "idle" }, { name: "idle" }, { name: "think" }] },
      {
        asset: { version: "2.0" },
        animations: [{ name: "idle" }, { name: "think" }],
        images: [{ uri: "private.png" }],
      },
    ])
      expect(() => validateSkinModelAsset(model, gltf)).toThrow(SkinSpecError);
  });
});
