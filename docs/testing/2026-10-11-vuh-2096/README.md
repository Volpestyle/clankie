# Owner-device lead roster (VUH-2096)

Tracks: https://linear.app/vuhlp/issue/VUH-2096

The new `lead_chats` operator-dispatch read exposes the existing VUH-2003
projection to active owner-paired devices with `terminalControl`. It reuses the
captain's roster function; its shared `LeadChatSchema` is now in the public
protocol. The client has an additive optional `leadChats()` method. Replies
distinguish a ready roster from an unavailable observation. Existing requests
and old devices are unchanged.

The authenticated app boundary refuses hosted visitors, lesser-grant guests,
support devices, Discord, captain/operator bearers and revoked devices. It
rechecks exact device authority before releasing a read. Custom local operator
IDs remain supported. The hosted operator wrapper admits the new read only
through its existing paired-owner boundary.

Focused proof uses the real captain, conversation/settings stores, device session
signer and registry, HTTP dispatch, signed hosted pairing, WebCrypto gateway
encryption and protocol decoding. The Herdr census and signed fleet authority
are fixture inputs; no live seats, service ports, model turns or evals run.
The prior lead-message fixture is shared so the transport proofs read the same
real projection as the existing session-card and self-state proofs.

`clankie heavy -- pnpm exec vitest run` on the device-roster, hosted-WebCrypto and
lead-message integration files passed: three files / 12 tests, exit 0, 8.23s.
The hosted proof pairs both an owner and a visitor through signed encrypted
records; the owner receives the exact captain roster and the visitor is refused.
The wire capture contains neither roster operation plaintext nor device secrets.
The local proof refuses visitor, guest, support, Discord/operator/unknown bearer
and revoked-owner reads. Service typecheck passed (exit 0).
Focused hosted-operator compatibility and lane-MCP checks passed: two files /
20 tests, exit 0, 3.87s. Formatter on the 16 changed source/skill/guide files
passed (exit 0). Earlier fixture/import/setup failures are retained as failed
iterations; only the final runs count as passing evidence.

Wynn received the request/result shape and ownership clarification through the
native peer channel; both delivery receipts were consumed. Lead skill and CLI
guide document the same API. Per lead direction, integration's exact-tree gate
is authoritative; no duplicate local root gate runs. Landing remains pending.

[Verification capture](clankie://evidence/sha256/d96f94dbb35bd113a38369cb51c26a239256d8bee1d3c3401638a3ffd8b6afec)
contains the shared projection schema, transport proofs, diff and check outputs.
