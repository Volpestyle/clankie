# VUH-2666: Linear and evidence media render inline

Core (this commit) (the `work_media` op and its resolver) and app `0fa71bab`
(rendering), against a scratch service.

## The cause

The app's own Markdown reader found the embeds but classified each link by its
file extension. Linear upload links have none (`uploads.linear.app/<org>/<id>/<id>`),
so every image and video became `kind: "file"`, which draws a grey file card.

Two more gaps sat behind that:

- A plain `<Image>` can't send Linear credentials. An unsigned link answers
  401 and a signed one expires in five minutes (checked with curl).
- The inline player only plays recorded evidence blobs.

## The fix

**Core.** A new `work_media` dispatch op takes up to 32 links. Each answers
`ready` (with sha256, type, kind and size), `pending` or `failed` with a reason.

- **Linear uploads.** The service fetches one only when a recent `work_items`,
  `work_project_details` or `work_item_activity` read returned it. Anything else
  answers `not_returned` and is never fetched, so this is not an open proxy.
  - The download uses the connected Linear app's bearer, to an allowlisted
    host, with no redirects, a 128 MiB and 30 s cap, and two downloads at a time.
  - The bytes become an evidence blob, cached by the link without its signature.
- **Evidence links.** A `clankie://evidence` link resolves only to a recorded
  blob.

**App.** The views resolve media links through the op.

- **Where:** Activity, Overview, and the issue's description and comments.
- **Images** show through `evidence_preview`; a large PNG gets the host
  thumbnail.
- **Videos** play inline through the existing evidence player, with their
  first frame.
- **States:** a tile shows a spinner and title while it loads. A link that
  can't load says so and opens in the browser.

## The data

Real records were copied read-only through the connected account. No Linear
credential was copied into the scratch service.

**Records:**

- KH2 Multiplayer status updates `06ed7e4b` and `03c72763` (full), plus an
  excerpt of `b37e949a`;
- VUH-2628, VUH-2632 and VUH-2660 with their comments;
- 10 real mp4s and one 900×900 PNG.

**Checks on the bytes:** recovery04 hashes to `5d8e4ad1…`, matching the
`clankie://evidence` link already in its comment, and bot01 to `bdd949f5…`,
matching its description.

**Scratch setup:** a `scratch-stack.mjs --broker-operator` stack, with the
records imported into its built-in tracker and the bytes pre-cached as its
work-media cache.

**Fixture:** the project description carries two real embeds, because the real
KH2 description has none (labelled in the description itself).

## HTTP boundary (`work-media-http.txt`)

Dispatch to the scratch service:

- **Cached upload under a new signature:** `ready`, video.
- **Crown PNG:** `ready`, image.
- **Evidence link:** `ready`.
- **Upload no cached item had:** `pending`, then `failed unavailable`, since the
  scratch has no Linear credential; the log shows the reason.
- **Never-returned upload and an arbitrary `example.com` URL:** both
  `not_returned`, never fetched.

## iPhone 17 Pro, iOS 27 (leased simulator)

Debug client `io.clankie.dev.vuh2666`, paired to the scratch service only.

- **Activity** (`iphone-11-activity.png`, `iphone-13a.png`): recovery04 renders
  inline with its first frame.
  - It plays inline in the native player (`iphone-playback-ax.txt`): 0:02
    elapsed with Pause, then the clip played to its end at 0:10, back to Play.
- **The rest of Activity** (`sheet-iphone-scroll.png`):
  - the bot01 clip renders inline;
  - the real 373 KB PNG shows through the thumbnail;
  - the upload that couldn't be fetched shows "Couldn't load this here · Open
    it in the browser".
- **Tail-`moov` clips** (the T-pose and Reversal clips): they sat black until
  played (`iphone-17-tpose.png`). Two-roxas, also tail-`moov`, shows its first
  frame after about 20 s on screen (`iphone-19-roxas.png`).
  - The loader is not at fault: see the Mac section.
  - The tile now shows a spinner and title until the player is ready. The AX
    read lists "Loading bot01…", "Loading Before: Reversal T-pose…" and others
    (`iphone-22-activity-loading.png`).
- **Issue view** (`sheet-iphone-issue.png`): VUH-2632's comment renders its
  three real clips inline with captioned first frames.
- **Overview** (`iphone-25-overview-media.png`): the description's PNG and video
  render inline.

## iPad

The iPad Air 11-inch capture is recorded with the app change in clankie-app's
`docs/testing/2026-10-22-vuh-2666-media/`.

## Mac: UI not captured

The Mac app draws all its UI in the pet's pocket panel; its main window's root
is empty. The background, pet-disabled proof path therefore shows nothing.
Re-rooting the pocket into a plain window fails at render.

- A visible proof pet would sit on James's screen, behind his installed app's
  pet lock.
- lldb would need Developer Tools access, and developer mode is off.

On Clankie's direction, the Mac pocket check goes on James's list after
install. What is proven on the Mac (`mac-loader-harness.txt`): the shipped
`EvidenceResourceLoader.swift`, which the Mac player shares, drives AVFoundation
on this Mac over simulated relay ranges (0.25 s each) with the real bytes.

| Clip          | Layout       | Ready  | First frame decoded |
| ------------- | ------------ | ------ | ------------------- |
| recovery04    | `moov` first | 0.40 s | yes                 |
| host Reversal | `moov` last  | 0.89 s | yes                 |
| T-pose        | `moov` last  | 0.89 s | yes                 |
| two-roxas     | `moov` last  | 0.89 s | yes                 |

The views are shared command-center code.

## Review follow-ups

Sage approved the first patch. Clankie asked for three of the notes before
landing:

- **Content types:** only raster images, video and PDF keep their type. HTML,
  SVG and anything else are recorded as `application/octet-stream`.
- **Cache reads:** a damaged `work-media.json` reads as empty, and a failed read
  is tried again instead of blocking all media until a restart.
- **The op's comment:** it now matches the real route: any device that reads
  work, like `work_items` and `evidence_preview`.

A third integration test covers the first two. Restoring the old type rule
fails it, and so does restoring the old cache parse.

## Checks

- **Core integration test** (`apps/clankie/test/work-media.integration.test.ts`),
  against a real HTTP fake for `uploads.linear.app`:
  - auth required (401 without the bearer);
  - redirects refused;
  - more than 128 MiB refused as `too_large`;
  - a never-returned link is never fetched;
  - a re-signed link hits the cache;
  - the cache survives a restart;
  - evidence links resolve.
  - Removing the not-returned gate fails it.
- **Core landing gate:** the first run failed on knip (an unused export, fixed).
  The second run passed all checks and stopped at review (exit 3,
  `core-gate-1.txt`).
- **App:** package typecheck and ESLint passed on the changed files, and the
  existing work tests passed 84/84. The app gate runs before its landing.
