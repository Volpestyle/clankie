---
name: solution-space
description: Before building glue, adapters, or workarounds on top of a system you don't own (cloud service, framework, library, third-party API), check what that system already models. Use when about to reconcile a mismatch between two shapes, when working around a platform limitation recalled from memory, when estimating a change as "small" without having opened the file, and especially when catching yourself writing prose to justify a rough edge. Catches designs that work but are in the wrong solution space.
---

# Solution space

The expensive mistake is not a bug in the code. It is picking the first workable
mechanism and then optimizing inside it, having never checked the platform already
models the thing you're about to hand-build.

That failure ships as confident, working, tested code. Implementation will not catch it —
the design *works*. Only reading the platform's own model catches it.

## Triggers

Any one of these fires the check:

- About to write a translation layer, adapter, or glue that reconciles two shapes
- About to work around a platform limitation you're recalling **from memory**
- Estimating a change as "small" or "large" without having opened the file
- **You are writing a sentence that makes a rough edge acceptable**

The last one is the strongest signal and the easiest to miss, because it feels like good
engineering judgment. "Untidy rather than broken." "One line of copy closes it."
"Acceptable tradeoff." A design that fits the platform usually does not have the wart at
all. If you are drafting prose to make a seam tolerable, the seam is telling you that you
are in the wrong solution space.

## The check

Minutes, not hours. Stop when one of these lands:

1. **Enumerate the platform's primitives — all of them, not the one you know.** States,
   statuses, lifecycle hooks, message actions, modes. If a system has five states and your
   design engages two, read the other three before committing.
2. **Read the docs for the *adjacent* feature.** The answer is routinely in a section about
   a different use case that happens to have the same shape as yours. Search the platform's
   docs for the *property* you want ("self-service recoverable", "idempotent", "replayable"),
   not the feature name you started with.
3. **Grep your own repo before writing the method.** The helper may already exist. Cost
   estimates made without opening the file are guesses.
4. **Ask directly: does the platform already model the property I'm about to add?** If yes,
   the native version wins even when your version is already half-written.

## When to skip

Trivial changes. Systems you own and know. Cases where you've already read the primary
source this session. This is a reflex against unexamined design, not a research ritual —
two minutes of doc-reading, not a literature review.

## Worked example

Studio users invited via Cognito `AdminCreateUser` land in `FORCE_CHANGE_PASSWORD`. If the
7-day temp password expires, "forgot password" returns HTTP 200 and silently does nothing —
no email, no log. Users were unrecoverable without an admin.

The plan was: new `resendInvite()` wrapping `AdminCreateUser --message-action RESEND`, then
reconcile two email shapes (6-digit code vs temporary password), then a line of UI copy to
explain the mismatch to the user. It would have worked. Tests would have passed.

The line of copy was the tell — a wart being talked into acceptability.

Reading the docs for a *different* feature (CSV-imported users) surfaced `RESET_REQUIRED`:
a second "must set a password before sign-in" state that, unlike the first, **is**
self-service recoverable. `AdminResetUserPassword` moves a user into it and sends a code —
and `CognitoUserRepository.resetPassword()` already implemented it.

Same outcome, no new method, no email reconciliation, no explanatory copy, and the bug
self-heals on first use. The original plan was not wrong so much as answering a question
that didn't need to be asked.
