# ADR 0250: Pi workers use the same usability view

Status: Accepted (2026-10-07), implementing the owner's hosted worker assignment
under VUH-1582. Complements [ADR 0207](0207-work-records-and-native-agent-delivery.md).

## Context

The Pi native adapter is pinned to CLI 0.87.1 and opt-in. The Linux runtime
image installed 0.84.2, the private managed body did not enable the adapter,
and automatic harness selection considered only Claude and Codex accounts.
Enabling the flag alone also failed because native capability and process proof
accepted only macOS. A hosted owner should not prepare accounts or harnesses.

## Decision

The public Linux image installs the adapter's independently pinned Pi CLI,
0.87.1. This is separate from the captain's SDK version. The private managed
body image opts into native Pi; ordinary public/self-hosted defaults remain off.

Linux Pi uses a direct ELF Node executable, the same pinned CLI file hashes,
and the original native process/session/controller binding. Linux kernel process
identity includes UID, birth, executable, cwd and foreground terminal identity;
loopback control must belong to that process. Changed or unobservable identity
fails closed. Other native harnesses keep their existing platform policy.

Pi participates in the shared worker account/usability report, not a special
hosted-only resolver branch. The report requires the enabled native capability
and a usable worker model/authentication path. Managed included usage or a
selected customer model comes from the existing runtime provider's Pi model
preparation; captain credentials alone do not establish native worker access.
Unknown capability, unavailable model or an owner hold prevents automatic
selection. Local observations confer no authority on a remote machine.

Automatic selection preserves the existing Claude/Codex preference rules and
can choose Pi from that same report, within the requested model constraints.
Admission still rechecks the native process, session and model preparation;
a report is not a delivery receipt. Uncertain dispatch never authorizes a
replacement worker, a replay or terminal keystrokes.

## Consequences

Hosted users have no setup step. A release needs matching public runtime and
private body image references. Source checks and local Linux boundary tests do
not prove a deployed tenant hire, billing or Discord-origin completion. Those
remain rollout verification; no AWS deployment is part of this change.
