# Credential request first slice

Work in progress for [#245](https://github.com/Volpestyle/clankie/issues/245)
and [ADR 0342](../adr/0342-desktop-work-runs-in-the-mode-the-owner-picks.md).
This is an implementation plan, not an available sign-in feature.

The first slice covers a hired worker asking for a credential, an owner answering
in the Clankie TUI or plain shell, and the credential broker filling an exact-origin
field in Clankie's own private browser. App, pet, Discord DM, guest desktop and
password-manager integrations remain later work.

The worker supplies the origin and field shape, never a credential value. Its
result is only `filled`, `declined`, `saved` or `failed`. The owner prompt names
the site and request. TUI input is masked; `clankie credentials answer` uses a
local no-echo prompt. Values go through the local owner API to the broker and
never enter chat, model input, transcripts, logs, scrollback or API responses.
One-time codes are never saved. Saved entries belong to the broker and are
scoped to the exact origin and username.

The broker binds each request to the original hire, browser target, document and
field. Wrong origins, redirects, foreign-origin frames, closed or replaced
requests and stale authority must refuse. Filling does not grant the worker new
authority. Browser observation and recording must remain outside credential
entry. The post-fill handoff is still a design decision: keep the target sealed
until an owner closes it, or explicitly include broker-controlled submission and
retirement of the credential-bearing document before agent access resumes.
No form submission is implied by this plan.

Proof will use an owned loopback sign-in page and isolated private browser,
without real sites or accounts. It must exercise the actual worker request,
local owner API, broker and browser path; cover the refusal cases above; and
search every fixture transcript, log, receipt and terminal output for the test
credential. Credential and authority code requires independent review before
rebase or merge.
