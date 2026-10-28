# ADR 0299: The owner's app gives the verdict on finished work

Status: Accepted by the lead for LOCAL-VUH-58, 2026-10-28. Extends
[ADR 0226](0226-one-tracker-tool-surface.md)'s owner-only stage moves and
[ADR 0245](0245-one-owner-ask-across-surfaces.md)'s verify asks. The isolation it
does not provide belongs to [ADR 0253](0253-owner-confirmation-needs-an-isolated-authority.md).

## Context

The app's Proof deck (LOCAL-VUH-58) shows finished built-in items with their
evidence. The owner swipes right to say the work works, or left to send it back
with a note. Only a `human` actor may move an item to `owner-verified` or back
(`moveStage`). Under owner closure, the owner answers the landing's `verify` ask
in the mailbox, and the tracker owner loop writes as the owner.

Under lead closure (LOCAL-VUH-11), the owner loop raises no ask, and lead-closed
items stay at stage `landed`. The owner's paired app writes as an `app` actor,
which `moveStage` refuses. So with lead closure, nothing on the owner's phone can
verify or send back a finished item.

## Decision

Add the built-in tracker write `post_owner_verdict {issueId, bundleId, verdict,
note?}`. `verdict: "works"` moves the item to `owner-verified`. `verdict:
"send_back"` requires a note; in one write it posts the note as an owner comment
and moves the item back to `accepted` with the note as the `reopened` body.

**Who may call it.** Only the owner's app: an authenticated device principal that
is active, holds `terminalControl`, has no support grant, was not minted by a
hosted account or for support, and is not an automation `run` pairing. The host
checks the device record and passes `ownerApp: {deviceId}` in the write
context. Tool arguments cannot set it. Its item events (`verified`, or `comment`
and `reopened`) belong to the owner (`human`, `via: "owner_app"`) and record the
`deviceId`. The records it touches keep the `app` actor that carried it. It is reachable
through the `tracker_sync` transaction route and the device paths of
`/v1/tracker/call` and `/v1/tracker/owner/call`.

**What it refuses** (`owner_app_required` unless noted):

- the operator bearer, on every route. It proves a local caller, not the human;
- every MCP lane: hired workers, reviewers and Clankie's own lead and room lanes.
  The tool is also left out of their catalogs;
- the repository-scoped `clankie work` path;
- devices minted for a hosted account, for support or for an automation run;
- a `bundleId` that is not the item's current bundle (`bundle_superseded`), so the
  verdict is about the proof the owner saw;
- an item that is not landed or delivered (`verdict_not_due`), one with no bundle
  (`evidence_bundle_required`), and a send back with no note (`note_required`).

**No CLI path.** `clankie work` and `clankie work owner` authenticate with the
operator bearer, which this write refuses on purpose. At the terminal, the owner
keeps the existing owner routes; this verb exists only for the paired app.

## Consequences

- Agents cannot verify or send back through this path. Their actor is stamped by
  the host, and they never receive `ownerApp`.
- Verify asks keep their own path. The app answers a pending ask with
  `input_answer`, and the owner loop applies it. The deck uses the verb only for
  items with no pending ask.
- **Same-user gap.** A process running as the owner's OS user can read the
  operator bearer and mint and redeem an ordinary pairing offer. That would give
  it a device this write accepts. The check keeps agents' own tools from
  verifying; it does not resist a hostile same-user shell. ADR 0253's isolated
  authority and per-action signer (for example Face ID over `{issueId, bundleId,
verdict}`) would close that gap. This verb is a natural first protected action
  for it.
