# ADR 0314: Setup adds the phone and the tailnet

Status: Accepted by James, 2026-10-31.

## Context

The three-step setup picks a Herdr session and then moves on. Adding the
iPhone still meant running `clankie pair` in a terminal, and adding another
computer meant writing an SSH alias first, because discovery only read the
owner's SSH config. Most owners who have more than one machine already have
them on one Tailscale network, and Tailscale already knows each machine's name,
platform and, for Tailscale SSH, its host keys.

## Decision

- **The owner's Mac app may mint an ordinary pairing offer.** A paired device
  with Take Control, calling over this Mac's own loopback (not through the
  gateway), may `POST /v1/pairing/offer`. Its offer is the same one-time
  offer the operator mints, with the same routes: sealed through clankie.bot
  when remote access is on, plus the configured direct route. It cannot mint a
  review or run offer. The event and log name the minting device as
  `device:<id>`. A device already with Take Control may revoke devices, so this
  adds no authority it lacked.
- **The offer carries its QR.** A device-minted offer also returns
  `qr: { size, modules }`, the deep link as QR modules row by row, so the app
  draws it with the SVG it already has and needs no QR library. Older clients
  ignore the field.
- **Discovery reads the tailnet.** `GET /v1/machines?discover=true` adds the
  online macOS, Windows and Linux peers from `tailscale status --json`, by
  their MagicDNS label, after the SSH-config candidates and without repeating a
  host either already reaches. Phones, offline peers and malformed names are
  left out, at most 16. The inventory shape does not change: a candidate uses
  the existing `name` and `platform` fields, so an older phone still reads it.
- **Tailscale's keys are trusted only on add.** Probes stay BatchMode with
  strict host-key checking. A Tailscale SSH peer is probed with the host keys
  Tailscale reports for it, from a private file that lives only for that
  discovery. When the owner adds the machine, those keys join the service
  user's `known_hosts`, so later fleet calls (which never accept a new key)
  reach it; an entry already there for that name is left alone. A peer running
  its own sshd, as Windows usually does, needs its key in `known_hosts`
  already, and the manual SSH host stays the fallback.

## Consequences

- Setup gains an "Add a device" step after the Herdr session: the phone QR on
  the Mac, the machines found on the tailnet with one tap each, and a manual
  SSH host.
- A tailnet machine added this way starts at portal access, like any new
  remote machine.
- Discovery takes at most two more seconds when Tailscale does not answer.
