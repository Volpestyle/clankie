# Clankie animation packs

`@clankie/skin-spec` is the public, node-free animation contract for lead and
worker appearances. It exports TypeScript types, the exact `SKIN_STATES` list,
event/fallback maps and a runtime validator. No art, renderer or executable
plugin is included. See [ADR 0267](../../docs/adr/0267-skins-share-one-public-animation-spec.md).

## Author a pack

Choose a stable lowercase ID, a pack version, display name and supported roles.
Keep the same envelope for either body kind. Supply idle; other states can use
the documented public fallback chain. Prefer authored spawn/handoff/poof for
worker lifecycle, and the lead/pet acts your look supports. `SKIN_STATES` is the
complete accepted list; misspellings fail validation.

A minimal 2D JSON manifest:

```json
{
  "specVersion": 1,
  "id": "example.sprout",
  "version": "1.0.0",
  "displayName": "Sprout",
  "roles": ["lead", "worker"],
  "body": {
    "kind": "2d",
    "atlas": {
      "image": "sprout.png",
      "width": 32,
      "height": 40,
      "frames": { "rest": { "x": 0, "y": 0, "width": 32, "height": 40 } }
    },
    "animations": {
      "idle": { "frames": ["rest"], "playback": "loop", "frameDurationsMs": [1000] }
    }
  }
}
```

Use named atlas rectangles within its bounds; preserve transparent margins and
stable feet/origin. Each animation has exactly one timing source: fps or one
positive duration per frame. A once animation emits completion after its final
duration. A hold selects a pose and emits no completion. `mirrorX` can reuse
right-facing pixels on the left. The renderer determines its scale and mask.

For 3D, replace only `body`:

```json
{
  "kind": "3d",
  "model": "sprout.glb",
  "cell": { "width": 40, "height": 64 },
  "fps": 12,
  "animations": {
    "idle": { "playback": "loop" },
    "think": { "playback": "loop" },
    "work_type": { "clip": "think", "playback": "loop" },
    "sleep": { "clip": "think", "playback": "hold", "range": { "from": 0.5, "to": 0.5 } }
  },
  "postProcess": { "kind": "pixel", "levels": 4, "outline": true }
}
```

Bake/retarget animations before export. Name each clip after its public state:
this example needs unique idle and think clips, not a second copy for work_type.
Embed buffers and textures in the GLB; external image URIs are rejected. The
cell is the render target and hit-mask grid. Range endpoints are fractions of
clip duration in [0,1]; only hold may have equal endpoints. A once completes
when its selected range finishes. Rendering fps is independent of baked track
sample rate. An optional envelope `restStill` is a 2D rest-pose image.

## Validate and load

```ts
import { loadSkinAnimationPack, validateSkinModelAsset, resolveSkinState } from "@clankie/skin-spec";
const pack = loadSkinAnimationPack(untrustedManifest);
const state = resolveSkinState(pack.body, "work_type");
// For 3D, after the client's glTF loader parses the actual asset:
if (pack.body.kind === "3d") validateSkinModelAsset(pack, parsedGltfJson);
```

Validation performs no IO. `SkinSpecError.issues` provides paths and reasons.
Use paths in authored JSON; the importing client resolves them under its own
asset policy. Numeric asset IDs are only the client's in-memory bundled form.
Use assets you may distribute; licensed source clips do not belong in this
public repository. A complete pack should be reviewed in motion in the target
renderer; passing structural checks is not visual approval.
