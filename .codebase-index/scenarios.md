# scenarios

Frozen, hash-pinned gameplay verification
fixtures. Each scenario is a versioned directory
whose exact fixture bytes are pinned by a
.sha256 file, so success is derived from
authoritative environment state (emulator core,
Paper server) rather than model-authored claims.

- emulator/ — deterministic GBA scenario
  (verdant-path-trainer-battle/v1) for the
  gba_emulator profile.
- minecraft/ — server-authoritative Paper
  scenario (collect-craft-place/v1) with its own
  pinned server.properties.

Both follow the same shape: a README explaining
the freeze discipline, then <scenario>/v1/ with
the fixture, a binding.json tying it to an
environment (characterId clankie, lane
gameplay), and sha256 pins. Fixtures contain no
ROMs, savestates, credentials, or captured
media. New versions are new vN directories, not
edits — the bytes are the identity.
