# VUH-2616: a standing reviewer gates a worker's landing

Tracks: [VUH-2616](https://linear.app/vuhlp/issue/VUH-2616).
Decision: [ADR 0287](../../adr/0287-a-standing-reviewer-gates-every-landing.md).

Two real Codex seats ran the full loop with no lead message in between:

1. The author submitted a patch.
2. The reviewer returned CHANGES.
3. The author resubmitted a new patch.
4. The reviewer approved it.
5. The author landed it.

The service routed the candidates and verdicts itself; no peer channel was used.

## Setup

- **Service.** A scratch Clankie service (`scripts/scratch-stack.mjs`, port 50017)
  ran from checkout `0ec4093fd`. The installed service was not touched.
- **Herdr.** A private scratch Herdr server, with its own `XDG_CONFIG_HOME` and
  socket inside the scratch directory, not James's sessions.
- **Project.** The scratch service's only project, `proof`, is a small git repo
  with a local bare `origin`. Its reviewer setting is `{ "role": "reviewer" }`.
  Its landing gate, `land.sh`, runs the tests, then `clankie review status` (exit
  0 only for an approved or waived patch), then pushes.
- **Seats.** Two Codex seats (`gpt-5.6-luna`, low effort) were hired through the
  scratch service's own hire route: `Proof reviewer three` with role `reviewer`
  and `Proof author two` with role `builder`. Their Codex overlays symlinked the
  owner's existing Codex login, as live hires do. Both overlays were deleted with
  the scratch directory.
- **CHANGES was induced.** The reviewer's brief listed three project standards
  that the author's brief did not mention: JSDoc, a test assertion, and range
  validation. That made a CHANGES round very likely; it is not evidence that the
  reviewer found something unprompted.

## Result ([`proof-review-gate.json`](proof-review-gate.json))

Fleet room, oldest first:

| #    | When (UTC)  | Kind          | From → to                  | What                                                                                       |
| ---- | ----------- | ------------- | -------------------------- | ------------------------------------------------------------------------------------------ |
| 3, 4 | 17:12:19–32 | lead_message  | Clankie → reviewer, author | The two hire briefs (attempts 1 and 2 are the failed `gpt-5.4-mini` hires below)           |
| 5    | 17:12:48    | peer_message  | author → reviewer          | Candidate `27ee4152`, patch `2f7df62e`, `price.mjs`                                        |
| 6    | 17:13:00    | peer_message  | reviewer → author          | CHANGES with three findings (JSDoc, test assertion, RangeError validation)                 |
| 7    | 17:13:12    | peer_message  | author → reviewer          | Candidate `281fd725`, patch `0b07fcfa`, `price.mjs` and `test.mjs`, `supersedes: 27ee4152` |
| 8    | 17:13:18    | peer_message  | reviewer → author          | APPROVE, bound to patch `0b07fcfa`                                                         |
| 9    | 17:13:28    | worker_report | author → Clankie           | "Landed VUH-2616 on main … 4e03e013"                                                       |

No lead message reached either seat between the briefs (3, 4) and the landing
report (9). Entries 5–8 are service seat deliveries (`source: review`). The room
shows them as `peer_message` so existing clients keep parsing.

The author ran `./land.sh` after APPROVE. `clankie review status` returned
`required: true, status: approved` for patch `0b07fcfa`, and the push put
`4e03e01` on the proof origin. Candidate `27ee4152` ended as `superseded` with
its CHANGES verdict still on it. Candidate `281fd725` ended as `approved`.

Seat transcripts: [author](author-pane.txt), [reviewer](reviewer-pane.txt).

## Clankie's own gate phase

`scripts/testing/landing-review.mjs` is the module `pnpm check:landing` runs. It
ran against the same scratch service, with this clankie checkout registered in
the scratch project:

1. It held the checkout's patch: `held`, `not_submitted`.
2. `clankie review waive --reason …` recorded an owner waiver on that patch-id.
3. The same check then returned `landable`, `waived`.

## What this does not prove

- **The installed service.** Nothing here ran on it. Its routes are unchanged
  until it is deployed, and until then the review phase is skipped
  (`reviews_unsupported`).
- **Lead notices reaching a real model.** The verdict notices woke the scratch
  lead conversation, and those turns failed, because the scratch service has no
  model. After this proof the service also records every review notice durably
  in the lead's chat. That recording is covered by code review only; no rerun
  followed.
- **Claude seats.** Every Claude profile's `clankie` marketplace points at the
  installed (pinned) plugin, so Claude seats would have loaded the old bridge.

## Incidents

- **The first hires failed.** `gpt-5.4-mini` is listed in Clankie's Codex
  subscription catalog, but Codex refused it for the ChatGPT account. Those seats
  never ran a turn and were closed.
- **The very first hire left an uncertain receipt.** The worktree had no native
  process helper (`pnpm fleet-proof:build`), so the hire could not confirm. That
  receipt was cleared from scratch state before the hires above.
