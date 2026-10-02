---
name: blast-radius
description: >-
  Find what a change could break somewhere else, then prove the one fact
  it's safe because of by running real code. Use for "blast radius of X",
  "what could this break", or reviewing a small diff you don't trust.
---

# blast-radius

A blast-radius writeup that merely sounds right reads as convincing
whether or not it is true. That is the trap. Don't ship the writeup —
prove the one or two facts the change's safety depends on by running code.

## Evidence ladder

For each safety fact, climb as far as is cheap, and say where you stopped.

1. **You said so.** Worthless on its own.
2. **You pointed at the real `file:line`.** Or the library's own source.
3. **You walked the failure path step by step and it doesn't reach.**
4. **You ran it.** A small script or test that calls the real code and
   fails loud if you're wrong. This is the target; usually one small
   script that imports what the app ships.
5. **You reproduced it in the running app.**

Every claim below rung 4 must be labeled **unproven**. Disclosure of
where you stopped is mandatory. Don't write it up as settled.

## The one fact

Most scary-looking changes are safe because of one fact. Find it and
prove it by running code, instead of enumerating maybes. If that fact
holds, most of the scary cases die at once.

Listing callers is not the job — grep is free. The job is the breakage
grep won't show: pinned or patched dep versions, serialized shapes read
elsewhere, timing, feature flags, consumers in another language, a wire
format, a DB column, code three hops downstream.

## What the review must establish

- What the change does, including the part the diff doesn't spell out:
  symbols added, changed, deleted, and what now behaves differently.
- The one fact it's safe because of.
- What lives where grep stops (the list above), cited as a real `file:line`.
  A search that finds nothing is still an answer; never invent a caller.
- Proof of the fact: the script or test, run, with what happened pasted. If
  it can't be proven cheaply, mark it unproven rather than rounding up.
- A real chance and a real cost for each remaining risk. Confirmed risks and
  cleared ones are listed separately.

## Hand back

- **What it does.** Including the non-obvious part.
- **The one fact.** State it, which rung you reached, and the proof.
  Unproven if you couldn't.
- **Confirmed risks.** How it breaks, `file:line`, how likely, how bad,
  how to check. Paste proof for the ones that matter.
- **Cleared.** What you checked and why it's fine — separate from confirmed.
- **Before you merge.** The cheapest test or repro that catches the real
  bug, including the script you wrote.
