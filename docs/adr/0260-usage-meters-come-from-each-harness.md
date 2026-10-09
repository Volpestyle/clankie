# ADR 0260: Usage meters come from each harness's own CLI

Status: accepted by the lead for VUH-1961, 2026-10-09.
Tracked by [VUH-1961](https://linear.app/vuhlp/issue/VUH-1961).
Extends [ADR 0181](0181-clankie-is-independent-of-his-connections.md).

## Decision

Clankie reads how much of each Claude and Codex account is left by asking
that profile's own harness, the same way the worker-account probe already
asks for sign-in state:

- Claude: `claude -p /usage --output-format json --no-session-persistence`
  under the profile's `CLAUDE_CONFIG_DIR`, from the system temporary
  directory. Claude Code 2.1.295 answers it as a local command (`num_turns: 0`,
  no cost, about half a second) from the same data as its `/usage` screen.
  Only the `Current …` lines leave the machine; the rest of the screen names
  local skills and MCP servers. The probe calls it only when `claude --version`
  is at least 2.1.295, because an older CLI might send `/usage` to the model
  as a prompt.
- Codex: `account/rateLimits/read` from `codex app-server`, including the
  model-scoped limits it reports beside the account-wide one.

Clankie never reads either harness's OAuth token, so no credential reaches
settings, logs, receipts or the service's memory. CodexBar's alternative,
calling Anthropic's OAuth usage endpoint with the token from each profile's
keychain item, was rejected: it would put Clankie in possession of the token
and in charge of refreshing it, which could rotate the token out from under
Claude Code.

`headroom` is the tightest account-wide window. Model-scoped windows (Claude's
"Current week (Fable)", Codex's `gpt-reserve`) are reported but do not bound
every hire. With both harnesses usable, the fallback harness choice now takes
Codex only when its best headroom beats Claude's; unobserved usage still counts
as half.

## Consequences

- Readings are minute-precision, in the reset wording Claude prints with an
  IANA zone. Claude names no year; the next occurrence is meant. Unknown wording
  leaves the reset unknown.
- Claude Code keys its keychain entry by whether `CLAUDE_CONFIG_DIR` is set, so
  registering `~/.claude` as a labelled profile needs one sign-in with that
  variable set (`CLAUDE_CONFIG_DIR=~/.claude claude auth login`). The report
  names that step; Clankie does not sign anyone in.
- `GET /v1/usage` shares one reading for a minute across every surface that
  polls; `?refresh=1` reads again.
