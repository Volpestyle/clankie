# VUH-1745 security review

**Approved for source security and concurrency**, reviewed independently on
2026-10-06 at 15:51:33 UTC. No unresolved security finding remains in the
snapshot below. This approval does not establish native Claude acceptance or
authorize deployment.

Base commit: `a00d7d8e5f1138680a26d099a81f228acf407115`.
SHA-256 of the twelve implementation, test and documentation files' binary
diff against that base:
`2b9bada93ea5b1d7cc9dffecfc5156c0b01b10d16cffc1cef162e5860c69c14b`.
The evidence directory and this review are outside that diff.

## Conclusions

- Exact live TCP tuple, authenticated SSH output, one-use return-channel nonce,
  native process ancestry, pane and native-session checks remain required.
  Headers, fleet bearers and client catalog reports do not supply native pane
  authority. Fresh process proofs remain necessary across requests.
- An expired observation keeps its original ID and capacity for at most 30
  further seconds. Its late reply releases capacity but cannot become proof
  or satisfy a newer request. The cap remains 16 observations. Unknown or
  duplicate settled replies invalidate the relay. Terminal grace closes a
  genuinely stalled relay through existing proof invalidation and retirement
  cleanup. No command is replayed.
- Typed transport failures return controlled 503 codes before evidence is
  recorded, at either report proof stage. Wrong or absent pane proof stays 403. Ordinary discovery still treats failed observation as unavailable
  proof. Failure diagnostics expose fixed reason codes and numeric status,
  without arbitrary server bodies, raw exceptions, paths or credentials.
  Timeouts and allowlisted reset failures retain their reason during response
  body reads; redirects are refused.
- The mod preserves idle, active-turn/tool, background-agent, generation and
  native-session guards. Stale results cannot update a replacement session.
  Warning history survives a healthy check, and backoff limits repeated
  background traffic. No automatic pane restart or steering was introduced.

The review initially rejected indefinite retention of expired observations;
the bounded grace resolves that availability risk.

## Evidence and limits

The five-file focused gate passed 131 tests, typecheck and lint. After the final
helper amendment, its gate passed all 12 helper tests plus format, package
typecheck and focused lint. The other 120 tests' inputs were unchanged, giving
132 distinct verified focused tests. The helper tests use real HTTP listeners
and the shipped helper; native engine and identity are explicit surrogates.
The reviewer read the completed results and did not rerun suites.

[Windows results](windows-relay.json) demonstrate that the baseline relay dies
on an observation deadline, while the patch rejects that caller, discards its
late reply, accepts the next observation and serves a new exact-tuple TCP
stream. That stream opens after recovery. It does not establish survival of
an already-open native Claude connection; existing-stream behavior has relay
boundary-test coverage. The isolated driver cleaned up only owned resources.

[Incident events](link-window.json) correlate repeated relay disconnects and
SSH session refusal with the reported warning window. They lack original
request-level timeout diagnostics, so the historical initiating caller remains
unproven. Owned native PC Claude acceptance, its hire/cleanup receipt and
deployed refresh evidence remain open, as described in [the evidence record](README.md).

## Exact file hashes

All hashes are SHA-256; paths are relative to the repository root.

| File                                                            | SHA-256                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------ |
| `.agents/skills/this-machine/SKILL.md`                          | `41ba4711dcf0805ffe7fd93c49e611289286802d4b0660cfccde1d4f8399e085` |
| `apps/clankie/src/app/seat-routes.ts`                           | `246e9d8f422e6de4f1f1db6116878185fb4655cd70d0457d28ac65e51738a317` |
| `apps/clankie/src/fleet-link.ts`                                | `0e42576df94b8263209f989473a39064424f4689dca23c886c9456e5ba94bc00` |
| `apps/clankie/src/remote-fleet-relay.ts`                        | `a251c4ebfef44ca7ac0c4d54b6c71da198adb96ed4d9a815a59ca5023026d4c5` |
| `apps/clankie/src/remote-project-proof.ts`                      | `616f28627f95a02a9a2768c79793360e0725f9cc739d6615ac9270b20ca8f068` |
| `apps/clankie/test/claude-tool-catalog-mod.integration.test.ts` | `144f751a83ec5dfad292584e4aa55ffb42b6db9f1bd80cb2a9ba23376ef6943f` |
| `apps/clankie/test/remote-fleet-relay.test.ts`                  | `2266ae6133c527c7f6aab671bf367fbd1e0fcb66ec46321451eb59dbeba47607` |
| `apps/clankie/test/remote-project-proof.test.ts`                | `d5bd2b9cf5cd2bbc84e46239cc87fb56172d35c77790fa5be01eb99e52ef6b82` |
| `apps/clankie/test/tool-catalog-health.test.ts`                 | `e9baab8b6b168a8a3b8a84d4840f077ed3fb67bb0181a78571e2393aff6a649e` |
| `docs/cli.md`                                                   | `3fa93f82bd11548f5b5b08fb101a8861499aab2d52493a452f69e00ff3fa74ef` |
| `integrations/claude-plugin/worker/mods/report.mjs`             | `c8edfd61317211784b93eb4acd23ebd82b6a0cda58e6fd3ba834422a3faaf8d9` |
| `integrations/claude-plugin/worker/mods/tool-catalog.mjs`       | `341405b98f4d1a2e2a8e074864ab0a78cf221a326f4730608a9f2edbe70ebbfa` |
