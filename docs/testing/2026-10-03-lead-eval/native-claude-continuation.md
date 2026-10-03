# Native Claude arm: partial engineering, execution held

The manual `native-subagents` selection now reports individual missing capabilities
before reading account credentials, Docker configuration or build artifacts. It
cannot launch. The campaign remains deferred; no Claude CLI, account query, model
turn, container, calibration or evaluation ran for this checkpoint.

## Built components

`lead-native-claude-plan.mjs` prepares a reviewable interactive CLI specification
from an explicitly selected image digest, bounded hash-checked Linux ELF artifact,
exact session UUID, models and independent repository indexes. It creates fresh
private HOME/config/temp directories and fixed argv/environment/settings. It does
not import credentials or execute the specification. The ELF check identifies
selected bytes; it does not verify their vendor, version or behavior. The declared
version remains unverified. The native image builder/probe is still Codex-only.

The plan selects restricted mode, no user/project/local settings sources, disabled
hooks, empty plugin settings, strict empty MCP configuration and explicit tools.
It supplies a worktree-isolated custom worker definition. These choices use the
[current CLI reference](https://code.claude.com/docs/en/cli-reference) and
[subagent reference](https://code.claude.com/docs/en/sub-agents). Restricted mode
still permits managed settings; effective configuration and all project/plugin
loading paths need pinned-image verification. Worktree isolation does not bind a
native child to our preallocated repository/index. The plan explicitly reports
that missing integration, and never grants launch authority. It contains no
headless `-p`, SDK substitute, owner-home inheritance or terminal typing path.

`stopNativeClaudeArm` delegates to the existing exact `LeadContainer.stop` boundary,
which kills and re-inspects the owned container, covering detached descendants.
Failed or mismatched stop receipts remain `native-claude-stop-unconfirmed`.
A root hook acknowledgement is never a stop receipt. This is deterministic fake
transport coverage only; actual descendant termination remains unrun.

`lead-native-claude-observation.mjs` bounds supplied transcript bytes and hook events,
retains only bounded lifecycle identity fields plus original payload hashes/byte
counts (never hook prompts, paths, responses or arbitrary extras), caps aggregate
encoded hook bytes at 1 MiB, rejects mismatched
roots/children and conflicting message counters,
and avoids counting repeated provider message IDs twice within a transcript.
Repeated provider message IDs across root/child transcripts make the aggregate
unknown; exported accounting retains only hashes of those IDs. Missing counters,
malformed records, unfinished children and later active turns
make the observed aggregate unknown. Nested cache detail is not added twice.
Well-formed observations still report `complete: false`, `authoritative: false`,
unknown account-wide usage and no confirmed containment stop. These are supplied
bytes, not a protected live collector or proof that no unseen agent/request exists.
No transcript path from a hook is opened. The format must be checked against the
selected real Claude version before any future collector uses it.

## Remaining engineering and minimum investigation

The blocking prerequisites are not an owner approval flag:

1. A pinned Claude image and credential-free runtime capability probe establishing
   the real interactive TUI process, effective configuration, tool/filesystem/network
   boundary, protected transcript collector, owner attachment and descendant stop.
2. A provider-backed, exact-account observer for ordinary-usage permission and both
   subscription windows. Imported auth labels, status text and transcript totals
   cannot replace this source or the existing shared admission barrier.
3. A fail-closed physical-request boundary for the root and every child, retry and
   compaction request. The [hook reference](https://code.claude.com/docs/en/hooks)
   says a timed-out UserPromptSubmit command hook can still let the prompt through.
   Hook observation is therefore insufficient to implement this guard.
4. Complete native descendant admission/inventory and worktree routing, with each
   writable child index bound before execution. Then wire an explicit manual TUI
   launch and transcript collection to the existing owner/admission/stop lifecycle.

The smallest next investigation is a source/contract audit of the selected Claude
binary/version for provider identity/quota and a synchronous physical-request gate.
If that needs private-account access or execution, propose the exact bounded
read-only capability check to James first. It is currently held, as are all live
model, Docker and calibration checks. If the supported native surface cannot
establish these properties, the arm stays unsupported; do not switch to an SDK or
rename hook fixtures as acceptance.

The [protected collector seam](native-claude-collector.md) now implements bounded
process/peer-checked capture and outside-mount retention for a future verified
Claude runtime. Its actual Claude capability and runtime integration remain
unavailable; no launch or accounting authority is derived from collection.
