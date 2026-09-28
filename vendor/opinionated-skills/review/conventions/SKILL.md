---
name: conventions
description: >-
  Decide a code-style question from evidence in the repo rather than from
  preference: enumerate every existing instance of the construct, count the
  forms, and follow the dominant one (or the newest, if two coexist and the repo
  is mid-migration). Where the code alone can't settle it, mine the repo's merged
  MR review threads for the norm the team already argued out. Invoke manually as
  /conventions <the decision>. Use when explicitly asked how this codebase
  already does something, whether a change is consistent with it, what this team
  prefers or would object to in review, or "which way would you lean" — NOT
  automatically whenever a naming, structure, or abstraction choice comes up.
---

# conventions

Style questions have no objectively correct answer, but they do have a
**locally** correct one. Find it by counting, not by taste.

## Why

The failure mode this prevents: presenting a personal style preference as an
objective finding. It sounds like reasoning ("this'll degrade when a second case
shows up") but it's a preference wearing a lab coat. A count settles in thirty
seconds what an argument won't settle at all.

## Method

**0. Look it up before you mine it.** Settled findings belong in the nearest
CLAUDE.md / AGENTS.md — typically a "Team code ethos (review expectations)"
section in the shared instructions file, which is auto-loaded every session.
If the question is already answered there, you are done in one read. Only mine
when it isn't.

1. **Name the construct precisely.** "Error message that varies by condition" —
   not "error handling". Vague framing returns useless greps and lets you see
   whatever you already believed.

2. **Enumerate every instance repo-wide — meaning THIS repo.** Produce a
   **count**, not an impression. `rg 'throw new BadRequestError' src --glob '!*test*' | wc -l`

   The repo being edited is the electorate. Sibling repos in the workspace, and
   the other side of a consumed API (a backend whose package the frontend
   imports), have their own dialects — their counts don't vote here. A form
   whose only precedent lives across a repo boundary is a deviation, not a
   convention, no matter how established it is over there.

3. **Classify the forms.** Separate the dominant form from the exceptions. Note
   what varies and how the codebase handles that variation.

4. **Ask the sharpest question: would my version be the ONLY one of its kind?**
   Near-decisive against it. This is the highest-signal check in the method and
   the cheapest to run — search for the shape you're about to introduce and see
   if it returns zero.

5. **Exclude tests** as evidence for production conventions. Test files have
   their own dialect.

6. **Check dates, not just counts.** If two forms coexist, `git log -S '<snippet>'`
   each and follow the **newer**. A repo mid-migration has a dominant-but-dying
   form; raw counts will point you at the thing being replaced.

7. **Check whether the count is bimodal.** If the same construct both survives
   in some places and gets deleted in others, one number is a lie — you have two
   populations. Find the variable that separates them; **that** is the
   convention, and it is more useful than either count. Symptom: your survey
   says "50 instances, clearly conventional" while your gut says the reviewer
   will still object. The gut is reading a split you haven't named yet.

## When the code can't answer: mine the review threads

Some norms never appear as a countable construct. "How much do we tolerate a
failure being hidden", "when is a fallback legitimate", "how defensive is too
defensive" are settled in review comments and never written down. The threads
are the archive — read them the same way, by enumeration and not by memory.

```sh
# every merged MR's human review notes, N pages back
glab api "projects/<group>%2F<repo>/merge_requests?state=merged&per_page=100&page=1" \
  | jq -r '.[].iid' > iids.txt
cat iids.txt | xargs -P 8 -I{} sh -c \
  'glab api "projects/<group>%2F<repo>/merge_requests/{}/notes?per_page=100" > notes/{}.json'
```

Then filter out `system: true`, bot accounts, and any note your own agent posted
(they cite the codebase back at you and inflate every count), and grep the
remainder for the theme.

**Rules for reading them:**

- **An open thread is not an unresolved one.** Reviewers rarely concede in
  writing; the argument stays open and the *code* resolves it. Check what
  actually shipped and what is still there today. Who got the last word is not
  evidence.
- **Attribute the positions.** A norm that is really one reviewer's standing
  objection is worth knowing as exactly that — it predicts the next review far
  better than a rule stated in the abstract.
- **The compromise is the convention.** When two reviewers deadlock and the code
  keeps a form the objector disliked, look for what got *added* alongside it.
  That addition — a log line, a guard, a comment — is the actual negotiated
  rule, and it generalizes.
- **Verify the precedent is reachable.** A surviving instance proves nothing if
  a `notNull` column, a default, or an upstream guard means it can never fire.
  Dead precedent is not precedent.

## Write it back

A survey you don't record is a survey you will run again. When you settle a
question that took real digging — especially one mined from review threads,
which is the expensive kind — add one line to the ethos ledger in the nearest
CLAUDE.md before you move on. One sentence: the rule, the discriminating
variable, and the tell that it applies.

Findings go in the ledger, which is read every session. The method stays here,
which is read only when invoked. Don't file a finding as a worked example and
call it captured — an example teaches the method, it doesn't answer the next
question.

Skip it for a one-off count that anyone can re-run in thirty seconds. The bar is
whether re-deriving it would cost more than reading it.

## Deviation

Conventions are not laws. Deviate when the convention is actively harmful in this
case, when the user says so, or when the newer form in a migration is still the
minority.

**Always say you're deviating and why.** Silent deviation is how a codebase ends
up with five ways to do one thing.

## Anti-patterns

- Sampling two files and calling it a convention.
- Importing another repo's convention across a boundary and calling it
  precedent — e.g. a backend's `*.contract.ts` file naming showing up in the
  frontend that consumes it. Familiarity from the sibling repo makes it *feel*
  conventional; the in-repo count is zero.
- Letting one recent commit outvote fifty older ones — unless step 6 shows a real
  migration.
- Reporting one number for a construct that has two populations. See method
  step 7.
- Treating an open review thread as an open question, or the last commenter as
  the winner.
- Counting your own agent's prior review comments as team precedent.
- Speculative "it'll degrade when we add a second case" as justification for
  abstraction now. If the second case doesn't exist, neither does the argument.

## Worked example

**Question:** should a brand-PATCH 400 branch between two messages via a ternary,
or extract a message-builder helper?

**Survey** (`acme-agent`, `src/api`, tests excluded):

- 18 `throw new BadRequestError`.
- Every one constructs its message **inline at the throw**.
- Variation is always handled by **interpolation**, never by branching:
  `Missing required fields: ${errors.join(', ')}`,
  `Agent limit of ${agentLimit} reached for the ${tier} plan`.
- **Zero** message-builder helpers exist anywhere.
- The proposed ternary would have been the only conditional message in the
  codebase.

**Answer: neither option on the table.** A single interpolated message —
`Brand cannot be updated while it is ${brand.deployStatus}` — matching the only
convention the codebase actually has. Smaller diff than either, and more
informative for every status rather than one special-cased.

A second pass on the same MR: `assert*`-that-throws had **zero** precedents,
`is*` predicates had **seven**. Dropped the assert helper, kept the predicate,
inlined the throws — even though that duplicates an error string, because
duplicating error copy inline is itself the convention here (`Missing required
fields:` appears verbatim in three handlers).

Note both answers landed outside the options originally being argued. That's the
usual outcome when you stop arguing and start counting.

## Worked example: a bimodal count

**Question:** is a `?? <default>` fallback conventional in `acme-api`, or does
it "conceal errors"?

**Naive survey:** ~50 instances of `?? '<literal>'` in `src`, none deleted in
recent history. Reads as settled convention. It isn't.

**Thread survey** (300 merged MRs, 466 human notes, 40 on-theme) shows a
standing disagreement, all threads still open:

- One reviewer, across four MRs: "upsert hides bugs" · "looks like we hide
  error" · "i dont see a reason to fallback. if wrong value comes from the
  upstream service, we will find it faster" · "better to have a failed service
  on staging rather than be fallen back to prod env vars".
- Another, across two: "better to ensure and fallback rather than blindly
  trusting external API which can change" · "it's our responsibility to not
  blindly trust everything".

**What the code says** — the count is bimodal, and the split is clean:

- At the **external** boundary the fallbacks all survived:
  `upstreamAgent.useCase ?? 'MULTI_USE'`, `brandId ?? ''`, `status ?? ''` are
  untouched today.
- Inside **our own** system they get deleted, and where the code must proceed
  past a surprise the compromise is a log: `createForAgent` still has
  `onConflictDoNothing()`, but a `logger.warn` was added and the thread closed.

**Answer:** the convention is neither "fall back" nor "never fall back" —
it's **a fallback is legitimate when it absorbs someone else's unreliability,
and concealment when it absorbs our own invariant.** Neither raw count could
have produced that; naming the discriminating variable did. The rule then
decides new cases the survey never saw.
