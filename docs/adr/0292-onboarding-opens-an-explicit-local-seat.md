# ADR 0292: Onboarding opens an explicit local seat

Status: accepted (VUH-2784, James's 1a decision, 2026-10-25).
Extends [ADR 0152](0152-a-harness-takes-the-operator-seat.md) and
[ADR 0248](0248-owner-settings-use-one-revision-fenced-api.md).

## Context

Desktop onboarding must finish with Clankie working in the chosen surface:
the app, Claude Code or Codex. His worker harness is a separate preference.
The existing native launchers already own sign-ins, plugins, native delivery,
resume records and account selection. The app must not reproduce them.

## Decision

The owner API stores `captain.seat` with an independent revision; an absent
value means `app`. Saving changes only the next explicit launch choice. It
does not change worker defaults, existing native sessions, social lanes or
the service model. No hosted-onboarding variant is introduced.

An explicit start uses a caller-retained UUID. Before effects, the service
saves a durable request record. Repeated requests and post-restart status
reads reconcile that record. A mismatched revision refuses a new start;
replaying an existing request returns its original operation. Records are
retained so an old request cannot silently acquire another launch.

Every start creates a separate local workspace conversation. For app starts,
the service model must be ready. For terminal starts, the service sends one
native Herdr `layout.apply` request with a new tab and initial argv invoking
its own `clankie claude|codex --conversation ID`. The installation and control
plane are pinned; inherited worker identity is cleared. The request cannot
name a linked machine, existing pane, arbitrary command or account path.
Existing sessions receive no input or signals. Opening the new tab focuses it.

The operation distinguishes `starting`, `ready`, `failed` and `uncertain`.
A successful pane creation is only starting; terminal readiness requires the
service-observed native source to match the requested harness and its bridge
to be bound. Lost creation replies remain uncertain, with no automatic launch
retry. Original uncertain operations can reconcile to ready after binding.

Only the owner operator or a currently authorized Take Control device can
read, save, start or reconcile a seat. Authority is checked again before
conversation creation and native launch. Unsupported platforms and hosted
bodies refuse mutations. The paired-device relay validates the same node-free
protocol; adding routes to a gateway allowlist does not grant host support.

## Verification and limits

The core integration exercises real HTTP, SettingsStore persistence, the CLI
consumer, a private Herdr daemon and real initial-command child processes. It
checks fresh panes, independent worker preferences, duplicate requests,
restart reconciliation, and a lost reply after actual pane creation. The
terminal executable records argv; this does not claim vendor authentication
or a model turn. Paired-device HTTP tests prove Take Control authority and
refuse weaker and revoked grants before launch. The fresh-profile app
walkthrough and real subscription-backed native session remain app acceptance
evidence, not conclusions drawn from these fixtures.
