# VUH-2609: Clankie hires a Codex worker on a joined machine

Tracks: [VUH-2609](https://linear.app/vuhlp/issue/VUH-2609) under
[VUH-1792](https://linear.app/vuhlp/issue/VUH-1792).
Decision: [ADR 0244 amendment, VUH-2609](../../adr/0244-machines-join-clankie-at-an-access-level.md).
Shape and runner: [VUH-2607](../2026-10-21-vuh-2607-joined-hire/README.md).

At `workers`, Clankie's own `hire_agent` with `fleet: "join-UUID"` and
`harness: "codex"` starts a native Codex worker on the joined machine. The worker
is signed in with that machine's own Codex login and reports into the chat that
hired it.

## Live proof ([`proof-codex-1`](proof-codex-1.json))

`PROOF_HARNESS=codex apps/clankie/scripts/prove-joined-hire.ts … anthropic/claude-haiku-4-5`

The setup matches VUH-2607:

- the clankie-ops gateway as a local process (`c9c9d36`, legacy host token);
- a self-hosted scratch home behind it;
- a scratch laptop running the real `clankie join --json`, approved at `workers`;
- a named scratch Herdr session.

This is not the ops fleet, and it proves nothing about fleet-signed or production
behavior.

Steps:

1. **Join.** The home's doorway connected. The laptop joined as
   `join-36c82601…` with `accessEnforcement: joined-host`.
2. **Hire.** Clankie's `hire_agent` returned `started`, seat `…/w1:p2`.
   - The launch nonce was `e3f038b7…`.
   - Codex minted session `01a15e1b-fada-7ab1-a832-c73feb41f6cf`.
   - The adapter observed it in the new pane and admitted it, and Herdr shows it
     as `herdr:codex`.
3. **Work and report.** The real Codex worker wrote `proof.txt`
   (`joined-hire-ed69f4cb`). Its `message_clankie` report was stored as a
   `worker_report` from `…/w1:p2` to `global-default`, 31 seconds after the hire.
4. **Shell refused.** `joined_machine_shell` was refused:
   "has workers access; this request requires shell". The audit records the
   refusal. That turn then ended `service_restarted`: the runner tears the home
   down as soon as it has seen the tool result.

## Spend

The home ran `anthropic/claude-haiku-4-5` on the broker's Anthropic API key. The
key was copied into the scratch home only and deleted at teardown.

- **Model turns:** 3 (the hire, the turn the report woke, and the shell turn).
- **Model calls:** 7.
- **Tokens:** 297k in total, mostly cache reads.
- **Cost:** about $0.11.

The worker ran one short Codex turn on `account-bd8bcff4` (this Mac's native
default login).

## Before the run

- Starting Codex with no prompt at the proof path showed no folder-trust prompt.
- The regression (`joined-hire.integration.test.ts`) uses a real Herdr and a
  `codex` stand-in that mints its own session. It covers:
  - only the variables Codex hands its MCP server;
  - a re-admission refused with 403;
  - the bridge refusing a pane that holds another Codex session;
  - a message to the Codex worker refused.

  Reintroducing any of those five defects fails it.

## Not done here

- Messages to a Codex worker. They need the app-server launch: a local
  `codex app-server`, with messages sent as turns.
- Fleet-signed hosted bodies, the production gateway, the desktop app and Windows.
