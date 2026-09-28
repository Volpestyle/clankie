---
name: testing-archive
description: >-
  Archive a verification/debugging campaign into a durable dated record in the
  repo docs — narrative README, curated screenshot/video evidence, re-runnable
  driver flows. Use when asked to "document this debugging process", "archive
  the testing", "make a testing archive", or to preserve how a change was
  proven (on-device, e2e, exploratory) beyond what CI gates record.
---

# testing-archive

Turn a just-finished verification/debugging session into a dated archive entry
a future session can learn from and re-run. The value is the **narrative with
dead ends included** — CI records that gates passed; the archive records how
behavior was proven and which traps were hit on the way.

## When to use this

- The user asks to document/archive a testing, debugging, or verification
  session — especially one with screenshots, recordings, or driver scripts.
- A campaign surfaced non-obvious fixes or infra traps worth a durable record.

Do NOT archive routine gate runs (that's CI / the repo's quality doc) or
sessions with no evidence and no debugging story. Archive **in the same session
as the campaign** — the debug chronology and capture files don't survive
context loss.

## Layout

```
<docs-root>/testing/
  README.md                      # index: purpose, entry conventions, entry list
  YYYY-MM-DD-<campaign-slug>/
    README.md                    # the narrative record
    evidence/                    # curated captures, numbered+descriptive names
    flows/                       # driver scripts used (Maestro yaml, etc.), re-runnable
```

- `<docs-root>` is the package's existing docs dir (e.g. `apps/mobile/docs` in
  a monorepo package), not a new top-level location. Link `testing/` from the
  docs index alongside any existing historical-record precedent (spike
  reports, ADRs).
- Date the entry by when the campaign ran, not when the archive is written.
- Entries are historical records: the "docs are present-tense" rule applies to
  the index, **not** inside entries — dated past-tense narrative is the point.

## The entry README skeleton

Order matters; this is the shape that reads well:

1. **Header block** — date, code scope, what it was verified on (device/sim,
   data source: live vs fixture), and the driver toolchain with versions.
2. **What was wrong** — numbered root causes, each tied to the code.
3. **What was built** — table of piece / file / substance.
4. **Verification methodology** — the loop as a small Mermaid flowchart
   (gates → environment → driver → capture → analysis), then a paragraph with
   the exact commands or their skill cross-refs.
5. **Debug log** — *chronological*, numbered, each snag with its resolution.
   Highest-value section. Include:
   - dead ends and why they failed (wrong tool, bad selector, stale binary),
   - findings that became code fixes,
   - ambient noise that was **ruled out** (infra restarts, sibling-agent
     changes) so future readers don't misattribute symptoms.
6. **Evidence index** — table: file → what it proves. Every claim in sections
   2–5 should be backed by an evidence file or a quoted command; if a claim
   has neither, soften or cut it.
7. **Re-run instructions** — exact command to replay the flows, plus the
   assumptions baked into them (viewport size for point taps, paired client,
   server up).
8. **Outcome** — gates state, trade-offs deliberately left, and where the
   tuning knobs live.

## Evidence curation

- Plan visual capture before the live run ends. If the source is ephemeral
  (framebuffer, device UI, streamed world), capture bounded milestone frames
  during the run and record their timestamps/turn ids and hashes beside the
  trace; an archive pass cannot reconstruct missing pixels after teardown.
- Curate from everything captured; keep the story, drop near-duplicates.
  **Keep bug-state captures** (the pre-fix no-op, the stale-binary banner) —
  archives exist precisely for those.
- Rename to `NN-what-it-shows.png` so the directory listing reads as the
  story; the index table maps each to its claim.
- Budget a few MB per entry. Prefer a frame strip over raw video for motion
  claims; include the raw recording too when it's under ~1MB.
- Two captures that look identical ARE evidence when the claim is "nothing
  happened" (e.g. a gesture no-op) — say so in the index.

## Motion evidence (proving animation/physics from a recording)

Screenshots can't prove momentum or spring-back; a recording + frame analysis
can. Record with the platform capturer (`xcrun simctl io <udid> recordVideo
out.mov` — default codec, `.mov`; the h264 flag can write 0-byte files), then:

```bash
# timestamp every frame with visible motion (tune the scene threshold down for subtle motion)
ffmpeg -i out.mov -vf "select='gt(scene,0.0005)',showinfo" -f null - 2>&1 \
  | grep -o "pts_time:[0-9.]*"

# build an N-frame strip across the motion window found above
for t in 7.00 7.12 7.25 7.40 7.55 7.75 8.2; do
  ffmpeg -loglevel error -ss $t -i out.mov -frames:v 1 "f$t.png"
done
ffmpeg -loglevel error $(printf -- '-i f%s.png ' 7.00 7.12 7.25 7.40 7.55 7.75 8.2) \
  -filter_complex "hstack=7,scale=2100:-1" strip.png
```

The argument writes itself: input gesture lasted X ms, motion ran Y ms — the
difference is momentum/settle. Put the interpretation in the strip's index row
("finger-up at frame 3, overshoot at frame 4, rest at frame 7"). For deeper
frame tooling see the `motion-from-reference` skill.

## Flow/script hygiene

- Copy the *working* driver flows into `flows/`; mention the failed selector
  attempts in the debug log instead of shipping them.
- **Scrub session paths.** Captured flows often embed absolute scratchpad
  output paths (`takeScreenshot: /private/tmp/<session>/...`) — rewrite to a
  neutral `/tmp/...` or they leak session dirs and confuse re-runs.
- Note the flows' environmental assumptions next to the re-run command; point
  taps especially are viewport-tuned and silently mis-tap elsewhere.
- Reuse a repository-level archive viewer when one exists: point it at the
  dated entry and let it index the files present.

## Checklist

1. Create (or extend) `<docs-root>/testing/` + index README.
2. Copy + rename curated evidence; copy + scrub flows.
3. Write the entry README per the skeleton; verify every claim has evidence.
4. Add the entry to the archive index; link `testing/` from the docs index
   (first entry only).
5. Report total size and git status (archives ride the same commit wave as the
   change they verify).
