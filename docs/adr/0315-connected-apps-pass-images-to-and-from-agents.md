# ADR 0315: Connected apps pass images to and from agents

Status: Accepted by James, 2026-10-31 ("r u able to pass images over mcp? to/from
clankie workers", then "Build it now"). Amends
[ADR 0301](0301-claude-reaches-the-fleet-through-a-narrow-connector.md) and
[ADR 0174](0174-finished-files-belong-to-conversations.md).

## Context

A connected lead app could only send an agent text and read its screen as text.
It could not show a worker a mock or a bug screenshot, and it could not look at
a screenshot a worker took of a simulator, a game or a rendered page. The
pieces already exist on the Mac. Owner attachments
([ADR 0209](0209-owner-attachments-reach-agents-as-files.md)) upload an image
into a conversation in 512 KiB chunks and deliver it into a local seat's
workspace under `.clankie/inbox/<message>/`, where Claude Code and Codex open
it by path. The connector's allowlist refused those ops. Nothing returned an
image to an app at all.

A model writing a tool call can't send the bytes of a large image it was shown.
It can send a small one as base64, or the address of one already on the web.

## Decision

- **To an agent, an image is an owner attachment.** `message_agent` takes up to
  four `images`, each `{url}` or `{data}`. The relay turns each into bytes,
  checks that their leading bytes are a PNG, JPEG, GIF or WebP, uploads it into
  the agent's persona thread with `upload_begin`, `upload_chunk` and
  `upload_commit`, and sends the message naming the committed files. The relay
  confirms an upload's thread is a persona thread, as it does for a send. The
  service delivers them exactly as for the owner's own attachments. A refused
  image sends nothing.
- **An address is fetched only from the public web.** The relay fetches an
  `https` address only when its host is not local, a tailnet name or a bare
  name, and every address it resolves to is public: no loopback, private,
  link-local, carrier-grade NAT, multicast or IPv6 local range. It follows at
  most three redirects, each checked the same way, reads at most 20 MiB, and
  stops after fifteen seconds. A host could change its answer between the
  check and the fetch; the image check still refuses anything that isn't an
  image, and nothing fetched becomes an instruction.
- **From an agent, `read_image` reads one image in its workspace.** The new
  `seat_image` op names a seat and a path. The service resolves the seat's
  working directory, resolves the path through symlinks, and refuses anything
  outside the workspace's real path, anything but a regular file, anything over
  3.75 MB (so its base64 stays under the 5 MB a model takes per image), and
  anything whose leading bytes are not a PNG, JPEG, GIF or WebP. The relay
  returns it as MCP image content beside a line saying it is the agent's
  output. The op rides `terminalObserve`, like reading the agent's screen, and
  the relay passes its base64 through unredacted, like evidence bytes.
- **Only seated agents on the Mac, for now.** Both directions reach agents
  Clankie seats on this Mac. A seat on a linked machine refuses images and
  says so, as ADR 0209 already does for attachments, and nothing is sent.
  Herdr desktop app agents still can't be messaged. Carrying files to and from
  linked machines is a follow-up issue, decided in
  [ADR 0316](0316-files-reach-agents-on-linked-machines.md).

ADR 0174 kept publishing local because a remote device should not have the
Mac publish arbitrary paths. `seat_image` publishes nothing and keeps nothing:
it reads one image inside a seat's own workspace, the same containment root as
the images a seat names in its replies, and the image check means no other
file's contents leave the machine this way.

## Consequences

- A lead can brief a worker with a picture and check its work by looking.
- A worker that wants a lead to see something saves it inside its working
  directory, for example under `.clankie/inbox/`, and names the path.
- An image sent to an agent stays in its persona thread's delivered files and
  in its git-ignored inbox, as an owner attachment does.
- No new grant, route or setting. The connector's allowlist gains four ops.
