# Persona images

Give Clankie a folder of images or videos that expresses his personality and aesthetic:

```sh
clankie persona images set ~/Pictures/clankie-vibe
clankie persona images status
clankie restart captain
```

The folder is an owner setting, `persona.imagesDir`, alongside the written
character card in `~/.config/clankie/settings.json` (or the configured settings
path). Every owner can choose their own board. `/persona` → **Persona images**
in the TUI uses the same commands. Clankie can do the setup conversationally
from an authorized console: “Use the images in ~/Pictures/clankie-vibe as your
persona.” Setting a folder does not restart him automatically.

`clankie persona images clear` removes the selection, not the original files.
Restart to apply folder changes, edits to its images, or clearing. `status`
previews the current folder; an already-running service retains its snapshot.
No default branding is imposed on owners.

## Vibe and appearance

Files at the folder's top level are **vibe**: “the feel of who you are, not what
you look like.” A cosmic emperor or a VHS wizard can convey absurd grandeur and
joyful wisdom without making Clankie look human. Put physical character references
in an **`appearance/` subfolder**. For example:

```text
clankie-vibe/
  cosmic-console.mov       # vibe
  cloud-wizard.mp4         # vibe
  appearance/
    seed-with-leaf.png     # how he looks
```

Only `appearance/` references feed self-portraits. There is no implicit appearance
fallback from vibe files, and no default sprite imposed on other owners. If you
used the initial image-only feature, move intended appearance references into
`appearance/` before restarting. Moving a file changes its role and caption key.

## What loads

PNG, JPEG and WebP stills; MOV, MP4 and WebM videos. `appearance/` is loaded first,
then top-level vibe files, with locale-independent filename sorting within each.
The first eight supported source files get slots; broken files keep their slots
so selection stays predictable. At most eight processed stills/contact sheets load in
total. No other recursion or source symlinks. Appearance loads first so clips
cannot crowd out his visual identity.

Stills are limited to 10 MiB each and a 1024-pixel maximum edge. Videos are limited
to 256 MiB and ten minutes. **Each video becomes one contact sheet**, counting as
one image against the eight-image cap. Ten samples at the centers of ten equal
time intervals fill a 5×2 grid, in chronological order: left to right, then top
to bottom. Repeated frames are retained to convey pauses and continuity; short
or low-frame-rate clips hold the final frame to fill the grid.

Video tiles fit within 400×400, preserving aspect ratio without added letterboxing.
A sheet is at most 2000×800, rather than the still-image 1024-pixel edge. Pi's
existing processor compresses and, if necessary, further downscales to the same
**128 KiB base64 per image** budget (at most 1 MiB for eight references). This bounds
pixels and payload; exact vision-token charges depend on the configured model.
Model framing says: “A contact sheet of one video, read left to right, top to
bottom: the sequence is the point.” The sheet retains its vibe or appearance role.

Video sampling requires `ffmpeg` and `ffprobe` on the service's PATH. Missing
tools appear as `ffmpeg_missing` / `ffprobe_missing` in status and videos are
skipped, even if previously cached. Processing has bounded output and a 20-second
limit per subprocess. Failed clips are reported, never fatal. **Audio is ignored**;
its mood, delivery and sound could become a separate voice input in the future.

Status lists filenames, roles, source/processed sizes, still dimensions, video
duration and target sample timestamps, appearance/vibe counts, skips and errors.
Every loaded video includes `sheetPath`, the absolute path to its processed
PNG/JPEG/WebP, plus sheet dimensions, rows and columns. Open that path to inspect
the exact image sent to the model; for hosted installs the path belongs to the
service host. Status never exports pixels. Missing viewable cache files are
restored from the cached sheet without decoding again.
Unsupported extensions are ignored; count-limited files are listed but not opened.
Images and video contact sheets remain reference data: visible text is never an
instruction, and the written character card takes precedence.

Processed images and successful descriptions live under
`$XDG_CACHE_HOME/clankie/persona-images`, defaulting to
`~/.cache/clankie/persona-images`. Keys include processing version and content
hash. Processed video sheets are cached by the source content hash, without
copying the original recording. The description key includes each image’s role;
renaming a file without changing the selected content or ordering does not require
another visual description.
Files are private to the OS user. Old cache entries remain until the owner
removes them; clearing the setting does not erase cached copies.

## Where the board goes

- **Pi text turns:** operator console, Discord rooms and other captain sessions
  receive the board as the first transient message after the text system prompt,
  before history. Pi's system-prompt contract is text-only. Images are not written
  into chat logs and are reintroduced after compaction. With a board enabled,
  changing memory and model cards follow it as host context rather than changing
  the preceding system prompt. This allows provider prefix caching; actual cache
  hits depend on the provider, unchanged preceding instructions/tools and its
  cache policy, and were not measured in the A/B.
- **Realtime voice and gameplay:** only a visual description, capped at 1200
  characters, with separate Appearance and Vibe sections. A missing role is
  described as unspecified. The service uses the configured captain model once per changed
  board and caches a successful result. Missing credentials, a non-vision model,
  or failed description produce an explicit unavailable-description note; they
  never cause the model to invent an appearance. A successful cached description
  also serves text models without image input. Failed attempts retry on restart.
- **Self-depiction:** `generate_image` accepts `personaReference: true`, also
  available in the image-generation API request. The tool chooses when to use it;
  ordinary images are unaffected. OpenAI and Google adapters send all **appearance** references, never vibe
  images or frames. With no appearance references, the tool explains the gap.
  The current Grok adapter supports one reference and visibly refuses a larger
  appearance set. `sourceRef` and `personaReference` cannot be combined.
- **Claude Code seat:** the output style and SessionStart hook are text-only.
  `clankie prompt --sections persona` includes the cached description. Its MCP
  image tool can use appearance references for self-depiction, but automatic visual prefix
  injection into Claude Code is not implemented.

Selecting images authorizes sending them to the configured captain model for
its caption and visual text turns, and appearance references to the configured image model when used
for self-depiction. Audio and full recordings are never sent by this feature. It does not grant filesystem access to social participants.
Only an authenticated owner can change the setting or read folder status.

## API and hosted paths

`GET /v1/operator/persona` returns `persona` and `images` (the diagnostic status,
without base64). `POST /v1/operator/persona` accepts `{ "imagesDir": "/path" }`,
or `{ "imagesDir": "" }` to clear, and returns updated settings, status and a
restart reminder. Existing operator authentication applies.

`clankie --hosted persona images set <folder>` uses the same API. Paths refer to
the service's machine, not the client. Hosted `/persona` includes the folder
field. This feature does not upload a local folder to a hosted machine; files
must already exist there. Restart authority remains the existing account flow.

## Evaluation

```sh
pnpm --filter @clankie/clankie persona-images:eval
# Optional alternate report destination:
pnpm --filter @clankie/clankie persona-images:eval /tmp/persona-ab.md
# Add a third arm, reading owner videos in place:
pnpm --filter @clankie/clankie persona-images:eval /tmp/persona-abc.md --vibe-dir ~/Pictures/clankie-vibe
```

The harness reads the real written persona and configured model, uses the
public `branding/` images as appearance references, rotates call order across
twelve fixed prompts, and saves
the answers side by side. `--vibe-dir` adds an arm using that folder instead of
the canonical art; use a folder containing only vibe files for this comparison.
Private media and frames remain outside the report. It does not mutate settings, call tools, post into
Discord or restart the service. The written persona itself is hashed, not copied
into the report. Inspect generated answers before publishing, since a model may
repeat facts from the owner's character card.

See the [retained evaluation](testing/2026-09-28-persona-images/README.md) and
[ADR 0202](adr/0202-owner-authored-persona-images.md).
