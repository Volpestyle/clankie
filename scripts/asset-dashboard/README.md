# Art-asset dashboard

Generates a single self-contained HTML page for browsing everything in
`assets/`: palette swatches, the four clankie variants with live idle GIFs,
the per-tag animation renders (GIF + frame strip), props and the demo scene,
an atlas explorer that cuts all frames out of `leafguy-atlas.png` using the
coordinates in `atlas.gen.ts`, and the `.aseprite` source inventory. Every
image is embedded as a data URI, so the output opens anywhere with no server
and no references back into the repo.

## Files

| File            | Role                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `build.mjs`     | Scans `assets/`, parses the atlas manifest, injects one JSON manifest into the template. Dependency-free. |
| `template.html` | The dashboard page: layout, theming (garden-night dark / parchment light), zoom, search, atlas explorer.  |

## Usage

```bash
pnpm assets:dashboard              # snapshot → artifacts/asset-dashboard.html (gitignored)
pnpm assets:dashboard:watch        # live: serve on http://localhost:4173, rebuild +
                                   # auto-reload open tabs when assets/ changes
node scripts/asset-dashboard/build.mjs out.html          # snapshot to a custom path
node scripts/asset-dashboard/build.mjs --serve --port 5000
```

Live mode rebuilds on every page load, so what you see always reflects
`assets/` as it is right now. It also watches `assets/` recursively plus
`template.html` and pushes a reload to connected browsers over server-sent
events when anything changes.

## Notes

- The animation section renders from `assets/garden/review/`, which is
  untracked and transient. When those renders are absent the dashboard is
  still built and shows the regeneration command
  (`python3 assets/garden/tools/render_review.py`).
- Palette hex values and animation frame counts/notes mirror
  `assets/garden/README.md`; update both together when the art changes.
- The snapshot output is a moment-in-time embed — rebuild after asset changes
  (or use watch mode, which does it for you).
