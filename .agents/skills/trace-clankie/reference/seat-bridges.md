# Seat bridges: gotchas

Tracing deliveries between the service and a native operator or worker seat.

- **An owner app turn missing from a native operator seat.** Read
  `clankie status` (`seatBridges`) or doctor and the `seat_bridges` operator
  dispatch observation. Capabilities describe the loaded bridge, not installed
  source. No handshake is a legacy receiver; new owner turns use its plain
  message format and omit new wire fields. A stale bridge or lost ACK produces a
  conversation reconnect notice (`/mcp`). Match the original ID, conversation
  journal, bridge pump journal and head delivery fence. Diagnostic reads never
  ACK, replay or settle the original.

- **A stuck `message_clankie` claim.** Compare the exact authenticated receipt
  with the worker's running bridge version. Older worker bridges (0.6.2)
  recognize only `stored`; they keep returning `uncertain` even when the service
  returns an exact sealed `definitive: not_sent`. Updated files on disk do not
  update an already imported bridge. Keep the original claim and truthful
  receipt; never label an unsent message `stored`, delete runtime state, or send
  a replacement to bypass this gap.

- **A no-install remote lead.** The home service persists the launch
  delegation's hash and original native proof. Its bridge rereads the fleet link
  file on each request, so a restarted SSH relay may publish a new loopback
  address without a head relaunch. `clankie doctor` names disconnected or
  reconnecting lead chats; the fleet round's `leadChats` includes their receiver
  state. Inspect the remote hooks log only with authority for that machine. A
  missing proof, replaced native process, changed connection identity or revoked
  grant must never be repaired by rotating credentials. A deliberate relaunch
  into the same conversation reuses its recorded account label unless an
  explicit label overrides it.

Bridge pump journals, head receipts and liveness traps are in
[captain turns and Discord text](captain-and-discord.md).
