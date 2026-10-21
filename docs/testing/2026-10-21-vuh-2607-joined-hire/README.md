# VUH-2607: Clankie hires a worker on a joined machine

Tracks: [VUH-2607](https://linear.app/vuhlp/issue/VUH-2607) under
[VUH-1792](https://linear.app/vuhlp/issue/VUH-1792).
Decision: [ADR 0244 amendment, 2026-10-21](../../adr/0244-machines-join-clankie-at-an-access-level.md).

At `workers`, Clankie's own `hire_agent` with `fleet: "join-UUID"` starts a native
Claude worker on a machine that joined him, and the worker reports into the chat
that hired it. His own shell there stays refused at `workers`.

## Stack (`apps/clankie/scripts/prove-joined-hire.ts`)

- **Gateway:** the clankie-ops public gateway as a local process (ops `c9c9d36`),
  with one legacy host token. This is not the fleet: the ops fleet's memory mode
  needs Stripe test calls and Cognito, and its provisioner never boots a body.
  Nothing here proves fleet-signed or production behavior.
- **Home:** a self-hosted scratch body behind that gateway, doorway `connected`,
  model `openai/gpt-5.4-mini`.
- **Laptop:** its own Clankie state and broker, running this checkout's real
  `clankie join --gateway … --host … --directory WORKSPACE --json`, approved from
  the home with `clankie join approve CODE --access workers --directory WORKSPACE`.
  Its panes live in a named scratch Herdr session (`vuh2607-proof`) that the runner
  creates and deletes; the worker uses this Mac's native-default Claude sign-in.
- One owner turn hires; a queued owner turn asks for `joined_machine_shell`.

`PROOF_CLAUDE=stand-in` swaps Claude for a recorder that real Herdr accepts and
then drives the installed `clankie-worker` plugin's MCP server with the pane's
environment: every step except the model turn.

## Live proof with a real Claude worker (`proof-1792574246029`)

1. Home connected to the gateway; the laptop joined at `workers`
   (`join-d04b912b…`, `accessEnforcement: joined-host`).
2. Clankie's `hire_agent` returned `started`, seat `join-d04b912b…/w1:p2`, in two
   seconds, while the worker was still working on its brief.
3. The real Claude worker wrote `proof.txt` (`joined-hire-8921c0fb`) on the laptop
   and called `message_clankie`; the home stored a `worker_report` from
   `join-d04b912b…/w1:p2` to `global-default`.
4. The shell turn never ran: the home's OpenAI key had run out of credits
   (`You have no credits remaining`), which failed both later model turns.

The shell refusal is proven by the stand-in runs, with a real model turn:
`proof-1792572386016` and `proof-1792573774827` (final receiver code) both end with
`joined_machine_shell` refused at `workers`.

## What the live runs found

Earlier runs each stopped at a defect the stubbed adapter test could not see:

| Run | Failure                                                        | Fix                                                                                 |
| --- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | Herdr `invalid_agent_name` for the title "Pip"                 | The receiver names the agent with `herdrAgentName`, as local hires do               |
| 3   | Herdr `invalid_agent_argument` for a multi-line brief          | The brief is staged in a private 0600 file named by a one-line `@path` prompt       |
| 4   | The receiver read `agent.session`; Herdr sends `agent_session` | Parse `agent_session`                                                               |
| 5   | `clankie mcp` lane mode dropped the joined transport           | `connectLaneUpstream` gets the routed `fetchImpl` (the joined lead seat had it too) |
| 7   | `joined_worker_not_admitted` for a report in the first turn    | Admit as soon as `agent get` shows the session; an early report waits for admission |

Run 6 hit Claude's backoff from run 5's failed server. In runs 2–6 the pane's zsh
profile had put the installed `clankie` first; the runner now gives the laptop an
empty `ZDOTDIR`. On a real joined machine the installed `clankie` is the right one.

## Regression

`apps/clankie/test/joined-hire.integration.test.ts` runs the real join registry,
encrypted channel, receiver and Herdr, with `claude` as a recorder and Herdr's
answer to `agent start` held until after the worker reports. The worker's MCP
bridge runs through `runJoinedSeatHook`. Reintroducing any one of the five defects
above fails it. Refusals covered: a folder not approved at join
(`unknown_directory`), Codex (`harness_unavailable`, a follow-up), an autonomous
turn, and a level below `workers`.

## Not done here

- A shell-refusal turn in the same run as the real worker (blocked by the API
  key's credits).
- Codex on a joined machine.
- The seat bridge's local evidence tools still post with a direct fetch, so they
  fail for a joined seat.
- Fleet-signed hosted bodies, production gateway, the desktop app UI and Windows
  (VUH-1796).
