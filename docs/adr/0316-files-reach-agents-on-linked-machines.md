# ADR 0316: Files reach agents on linked machines

Status: Accepted, 2026-11-01. Carries out the follow-up that
[ADR 0315](0315-connected-apps-pass-images-to-and-from-agents.md) named, on the
owner's go-ahead for that work ("to/from clankie workers", then "Build it
now"). Amends [ADR 0209](0209-owner-attachments-reach-agents-as-files.md) and
ADR 0315.

## Context

Owner attachments (ADR 0209) and a connected app's images (ADR 0315) reached
only seats on the Mac. A seat on a linked machine shares no filesystem with
the service, so both refused it. Agents on the PCs are where screenshots help
most: the KH2 mod's game runs there.

Clankie already reaches each linked machine over the owner's own ssh
(ADR 0184), runs short PowerShell or POSIX commands there, and copies the
worker plugin there with `scp` (VUH-1527). PC2's cmd.exe caps a command line
at 8191 characters, so no file can travel inside one.

## Decision

- **To a linked seat, attachments are prepared on the Mac and copied.** The
  service builds the message's folder exactly as for a local seat (HEIC JPEG
  copies and video keyframes included) in a scratch directory, with names
  every filesystem accepts. A command on the machine checks that the seat's
  working directory exists and clears a staging folder in the remote
  account's home; `scp` copies the folder there; a second command checks the
  workspace again, refuses a `.clankie` or inbox that is a symlink, junction or
  file, writes the inbox's `.gitignore`, and moves the folder to
  `.clankie/inbox/<message>/`. The note names the paths on that machine. Any
  refusal clears the staging folder, and nothing is sent.
- **From a linked seat, an image is read by a command there.** It resolves the
  path against the workspace, refuses anything outside it or reached through a
  symlink or junction, anything but a regular file, and anything over
  3.75 MB, then prints the file's base64. The Mac checks the bytes are a PNG,
  JPEG, GIF or WebP before returning them, as for a local read.
- **Files move only where workers may.** Both directions need the machine's
  access at Workers or above (ADR 0244); at Portal, and in Watch (ADR 0308),
  they are refused with the access message.

## Consequences

- A connected app's `message_agent` images and `read_image`, and the owner's
  own attachments, reach agents on the PCs.
- Each attachment message costs two short commands and one `scp` connection;
  an image read costs one command.
- The PowerShell commands are proven on the PCs themselves; CI proves the
  POSIX commands against a real shell.
