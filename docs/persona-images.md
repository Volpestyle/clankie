# Persona images

Give Clankie a folder of images that expresses his appearance and aesthetic:

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

## What loads

PNG, JPEG and WebP files directly inside the folder, sorted by filename using
locale-independent JavaScript ordering. The first eight supported filenames get slots;
a broken image keeps its slot so selection stays predictable. No recursive
walks or symlinks. Each source is limited to 10 MiB. Processed images fit within
1024 × 1024 and 128 KiB of base64 data each (at most 1 MiB for the whole board).
Aspect ratio is preserved; images are never enlarged. Pi's existing image
processor handles orientation and downsizing. Smaller inputs retain their bytes.

Status lists filenames, source and processed sizes, dimensions, loaded count,
skips and errors. An unreadable folder or image never prevents a normal turn.
Unsupported file extensions are ignored. Count-limited files are listed but not
opened. Images are reference data: words inside them are never instructions,
and the written character card takes precedence.

Processed images and successful descriptions live under
`$XDG_CACHE_HOME/clankie/persona-images`, defaulting to
`~/.cache/clankie/persona-images`. Keys include processing version and content
hash; renaming identical content does not require another visual description.
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
  characters. The service uses the configured captain model once per changed
  board and caches a successful result. Missing credentials, a non-vision model,
  or failed description produce an explicit unavailable-description note; they
  never cause the model to invent an appearance. A successful cached description
  also serves text models without image input. Failed attempts retry on restart.
- **Self-depiction:** `generate_image` accepts `personaReference: true`, also
  available in the image-generation API request. The tool chooses when to use it;
  ordinary images are unaffected. OpenAI and Google adapters send the full board.
  The current Grok adapter supports one reference and visibly refuses a larger
  board. `sourceRef` and `personaReference` cannot be combined.
- **Claude Code seat:** the output style and SessionStart hook are text-only.
  `clankie prompt --sections persona` includes the cached description. Its MCP
  image tool can use the board for self-depiction, but automatic visual prefix
  injection into Claude Code is not implemented.

Selecting images authorizes sending them to the configured captain model for
its caption and visual text turns, and to the configured image model when used
for self-depiction. It does not grant filesystem access to social participants.
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
```

The harness reads the real written persona and configured model, uses only the
public `branding/` images, alternates arms across twelve fixed prompts, and saves
the answers side by side. It does not mutate settings, call tools, post into
Discord or restart the service. The written persona itself is hashed, not copied
into the report. Inspect generated answers before publishing, since a model may
repeat facts from the owner's character card.

See the [retained evaluation](testing/2026-09-28-persona-images/README.md) and
[ADR 0202](adr/0202-owner-authored-persona-images.md).
