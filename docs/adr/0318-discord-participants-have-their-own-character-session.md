# ADR 0318: Discord participants have their own character session

Status: Accepted, 2026-10-31, on James's request for a dedicated isolated
participant session, automatic creation when absent, and owner-only real work.

## Decision

A participant is Clankie acting in one public Discord room. Its persistent
character history belongs to that room, independent of the current speaker.
Native character execution has its own conversation record and mailbox; an
Admin-to-Participant switch leaves any previous owner attachment and its
history alone. Private handoffs, held owner wakes and worker reports do not
enter the character. The owner chooses Pi or Claude once in the server settings. The first admitted
message creates the session. Subsequent messages reuse it; a closed native
process resumes the same history. Pi participant loops no longer require the
experimental room-loop switch.

Claude runs visibly in Herdr in a private character directory. Its launch
profile confines native file tools, disables inherited settings/MCP connectors
and ordinary project instructions, uses manual permissions, and asks for every
command, edit, network-research or skill invocation. Only the owner can approve
those requests in the native UI. A server role or ownership compatibility grant
cannot elevate this character. The session-only plugin projects public persona,
transcript synchronization and a correlated reply channel, without owner memory,
fleet skills or account tools. The owner's ordinary resume pointer is preserved.
Pi retains only its existing owner-configured bounded room-skill adapters.

The service journals launches before allocation. Lost responses are reconciled
against the original native inventory; uncertain launches are never duplicated. A launch that ends before binding is
held for owner recovery, so room traffic cannot open unlimited failed tabs.
Every dispatch proves the exact native occupant and restrictive argv. The same
proof and current configuration gate publication. Replies return only to their
original message; other harness output is not mirrored into Discord. A failed
native dispatch does not silently use Pi or an owner conversation. At most four
native character allocations are active at once.

Claude runs as the owner's OS user. Owner-approved Bash has that user's powers;
this design does not create a separate OS-account sandbox. Native startup and
trust prompts remain visible for the owner. The integration evidence uses a
fixture harness, so live Claude prompt enforcement and Discord delivery remain
unverified by this change's automated checks.

This amends participant behavior from ADR 0229 and ADR 0291. Admin-server
machine grants and explicitly linked private owner channels keep their existing
routes; a Participant server cannot link its character to the main conversation.

See [Discord rooms](../discord-rooms.md) and the [statecharts and boundary evidence](../testing/2026-10-31-participant-sessions/README.md).
