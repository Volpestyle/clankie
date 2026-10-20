# VUH-2517 — shell-safe Claude hire briefs and failed-start recovery

Tracks: https://linear.app/vuhlp/issue/VUH-2517

VUH-2499 passed the entire first brief as a native startup argument. Herdr
0.9.3 refuses control characters before launching the harness. The failed start
retained its original fence and project allocation but omitted the native receipt
UUID from its result, preventing practical recovery of the absent pane.

## Observed Herdr boundary

In owned pane `w48:p1Q`, `herdr agent start … -- --version ARG` rejected every
individually tested C0 character **U+0001–U+001F** and C1 character
**U+007F–U+009F**, including LF, CR, tab, ESC and DEL, with
`invalid_agent_argument`. NUL cannot be passed in an OS argv and was not tested.

Backticks, single and double quotes, `$`, parentheses, backslashes, unicode
(`→`, `é`, emoji), and a **20,000-character** argument reached Claude and printed
`2.1.304 (Claude Code)`. Since `--version` exits instead of becoming an interactive
agent, Herdr then returned its ordinary startup timeout. This proves acceptance
at the encoder, not unlimited argument length. Unicode separators U+2028/U+2029,
NBSP, U+200B and U+FEFF also passed argument validation in the separate boundary
probe, which stopped at the occupied-pane check. The control-character sweep
used an intentionally invalid timeout to stop accepted arguments before launch;
controls failed earlier. No inference from shell metacharacters was needed.

All probe panes (`w48:p1Q`, `w48:p1R`, `w48:p1S`, `w48:p1T`) were owned by this
assignment and closed after capture. No other pane was steered or closed.

## Result

A fresh Claude hire writes one private JSON file in session state and submits
one short startup prompt referencing it with native `@file` expansion. Encoding
the brief as one JSON string keeps its controls and line count out of both shell
arguments and Claude's binary-file/line handling. Local creation uses directory
mode `0700`, exclusive file creation and mode `0600`. Remote launches reuse the
existing host-side private settings writer. The file remains for inspection.

The reference alone is not a delivery receipt. The native transcript parser
keeps the complete, active-chain JSON file attachment as an internal decoded
brief receipt. The existing exact-body/fingerprint checks then confirm it.
Truncated, changed or missing attachments remain uncertain, with no channel
fallback or replay. Session ownership, durable startup failures and the hiring
conversation's wake remain intact.

Failed starts expose their original `receiptId`, including retries inspecting a
retained failure. The failure wake also names it. An absent pane no longer
silently clears an uncertain hire fence on retry.

For old local failures that omitted the UUID, the operator may run
`clankie hire-receipt settle ALLOCATION_UUID abandoned`. It resolves exactly one
original by local fleet, harness, directory and pane, then applies the existing
two-census local abandonment. A live harness or uncertain inventory refuses.
The result names the native receipt; follow with
`clankie hire-receipt settle ALLOCATION_UUID release-allocation`. Abandonment
claims neither delivery nor historical non-launch. No state is hand-edited.

## Proof and checks

- **Real Claude TUI:** Claude Code **2.1.304**, Haiku 5.5, medium, final capture
  **2026-10-20 02:22:03Z**, session
  `892bff4e-ee16-49b0-849e-38a050b6703d`, owned pane `w48:p1T`.
  **14,700 bytes**, 120 sample lines plus instructions, with backticks, both
  quote types, `$HOME`, `$(literal)`, unicode and newlines. **One launch, one
  complete brief attachment, zero channel sends**, first-turn answer
  `VUH2517_LONG_FIRST_TURN_OK`. Native brief file mode was `0600`.
  `native-proof.json` retains source hashes; `native-sanitized.jsonl` retains
  the actual prompt, attachment and reply, with unrelated system content removed.
- **Focused checks:** **187 tests passed in eight files**, covering startup,
  late receipt reconciliation, ownership/failure retention, an absent-pane retry
  without replay, old-allocation abandonment/release across restart, remote
  isolation, and whole/incremental transcript parsing. Process discovery in the
  regression fixtures is synthetic; the TUI proof above uses real Herdr/Claude.
- **Compilation:** explicit touched source/test roots passed with the repository's
  bounded compiler runner. File-scoped formatting/lint passed.
- **Pre-integration checks:** `node scripts/check-swallowed-rejections.mjs
6aa010af8180aaecff7acb485add1dac77549f63` and `pnpm deadcode` passed.
  Knip printed one existing unmatched-entry-pattern hint, without an error.

An initial live run answered correctly but remained unconfirmed because the
parser still excluded file attachments. Its failure is retained in
`native-parser-before.json`; the parser was fixed before both successful captures.

## Delivery boundary

This evidence proves the source adapter with a real native TUI, and the supported
recovery path against durable fixture stores. The integration service supplies
the root landing gate. Deployment and recovery of live allocation
`eb02e5c2-295d-4fa2-81b6-da34ff0422a1` must be recorded separately after the updated
service is running. No live allocation has been changed by these source proofs.
Remote Windows native startup was not exercised.

[Raw probes, sanitized native proof, driver and focused checks](captures.tar)
