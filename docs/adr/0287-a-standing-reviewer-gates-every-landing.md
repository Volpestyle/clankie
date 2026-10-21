# ADR 0287: A standing reviewer gates every landing

Status: accepted (James, 2026-10-21, "go for it" on
[VUH-2616](https://linear.app/vuhlp/issue/VUH-2616); design approved by the lead
the same day). Amends [ADR 0240](0240-changes-land-directly-on-main.md): the root
landing gate also holds a change until its project's reviewer approves that exact
patch. Builds on [ADR 0213](0213-clankie-retires-swarm.md) (native seat
proof) and [ADR 0221](0221-tests-prove-the-product-and-its-boundaries.md).

## Context

Before this, a lead wired up an independent reviewer for each change. On KH2 that
meant the lead copied every review packet between two workers by hand, because
their peer channel refused the messages. The reviews were worth it. One pass
over the VUH-2612 crash fix found three more stale-pointer sites, and another
found a soft lock between peers. But the lead was the bottleneck, and coverage
depended on the lead remembering to ask.

Two facts about the peer channel shaped the design:

- **Peer messages never cross a fleet boundary (ADR 0213).** A seat on one
  machine cannot message a seat on another, so those sends are refused as
  "unknown or ambiguous in this fleet".
- **A remote seat could not reach peers on its own machine either.** The peer
  catalog read only this Mac's Herdr inventory (`herdrRunner.list()` without a
  fleet), so every remote seat saw an empty catalog and every send was refused.
  This was found by reading the code and reproduced in
  `remote-peer-catalog.integration.test.ts`.

## Decision

**A project may name a standing reviewer.** The setting is `review` on the
project: either an exact seat (`{ seat: "FLEET/term_…" }`) or a project role
(`{ role: "reviewer" }`) that resolves to the live seats holding that role.
A role is the better default, because seats retire. It is set through
`POST /v1/operator/projects/update`, `clankie project settings PROJECT
--reviewer-role ROLE | --reviewer-seat SEAT | --reviewer none` and the TUI
`/project` menu. Snapshots show it only to clients that opt in
(`includeReview=true` / `projectReview`), so older strict clients are unaffected.

**The service routes candidates and verdicts itself.**

1. _Submit._ The author calls `submit_for_review` from its own seat. The bridge
   sends the exact `git diff --binary merge-base(origin/main)..HEAD` bytes. It
   uses the same native process proof as peer messages: the author's identity
   comes from that proof, never from fields in the request.
2. _Hash._ The service computes `git patch-id --verbatim` over the bytes it
   stores and refuses a mismatch with the id the bridge sent. That hash ignores
   the base, so it survives a clean rebase. It is exact about whitespace.
3. _Deliver._ The service sends a review packet to the first live reviewer seat
   that is not the author, through its own seat delivery (`source: review`). The
   packet holds the candidate id, hash, files, summary, evidence and any prior
   CHANGES findings.
4. _Verdict._ The reviewer reads the stored bytes with `review_candidate` and
   records `review_verdict { candidateId, patchId, verdict, findings }`.
   - It is accepted only from a seat that currently holds the project's
     reviewer setting, never from the author's seat or occupant.
   - It is accepted only when `patchId` equals the stored hash.
   - CHANGES needs at least one concrete finding.
   - The verdict reaches the author's seat directly, and reaches the author's
     lead as a service notice that asks for no action. The fleet room records
     the exchange. When author and reviewer run the same harness the record
     flags it (`sameHarness`), so weaker independence is visible, but the
     verdict still counts.
5. _Resubmit._ After CHANGES the author commits and submits again. Passing the
   same issue links the new candidate as `supersedes`, and the old one becomes
   `superseded`. A verdict always stays with its own hash, so an approval never
   covers a different patch.

**The landing gate holds.** `pnpm check:landing` asks the service, through the
checkout's own CLI (`clankie review status`), whether this checkout's patch-id may
land. Two states let it through:

- the checkout's project names no reviewer, or
- the hash is approved or waived.

Otherwise:

- With every check green and review pending, the gate records
  `checksExitCode: 0` and exits **3**.
- After APPROVE, `pnpm check:landing --revalidate` carries the green checks
  forward under ADR 0240's rules and asks about the review again. Exit 0 means
  push.
- A rebase that changes the patch changes its hash and needs a new review.

There are two fallbacks:

- **No answer from the service.** The gate holds only when the owner's settings
  name a reviewer for some project.
- **A service from before this ADR, or CI.** The review phase is skipped.

**Waivers are rare and on the record.** Only the owner (`clankie review waive
--reason`, operator credential) and the lead (the `waive_review` tool on the
operator lane) can waive review. A waiver needs a reason. It is stored on the
candidate for that exact patch-id, with who waived it, why and when, and it
appears wherever verdicts appear. A lead's waiver is also sent into that lead's
own conversation, so it is never silent.

**Peer catalogs read the sender's own machine.** `PeerSeatMessages.seats` now
takes the sender's fleet, so seats on the same remote machine can see and
message each other. Messages still never cross a fleet boundary. Review traffic
does not depend on peer messaging at all.

## Consequences

- The lead no longer relays reviews, and coverage no longer depends on the lead
  remembering. The lead's closure rules are unchanged.
- **Only the gate enforces the hold.** A direct push that skips
  `check:landing` is not stopped mechanically. ADR 0240 already accepted that
  exposure for the root gate itself. Landing history and the candidate records
  make a skipped review visible.
- **`clankie integrate` is not gated in this slice.** It lands composed batches
  whose combined patch matches no author's candidate. Checking each member is a
  follow-up ([VUH-2621](https://linear.app/vuhlp/issue/VUH-2621)).
- **The operator credential is the owner's authority**, as everywhere else. A
  local process that holds it can file an owner waiver. The record names the
  actor so misuse is visible.
- **The app's project settings row is not here.** The same API serves it; it is
  a clankie-app follow-up ([VUH-2622](https://linear.app/vuhlp/issue/VUH-2622)).

## Evidence

- `apps/clankie/test/review-gate.integration.test.ts` runs the whole flow through
  the real worker bridge tools, seat and operator routes, fleet-link allowlist,
  review store, real `git` and the owner CLI: author, reviewer, CHANGES,
  resubmit, APPROVE, then a clean rebase, drift and an owner waiver.
- `apps/clankie/test/project-work-policy.integration.test.ts` sets and clears the
  reviewer through the CLI and HTTP.
- `apps/clankie/test/remote-peer-catalog.integration.test.ts` reproduces the empty
  remote catalog and proves the fix.
- The live proof with real seats is recorded on VUH-2616.
