# Remote access, accounts and bodies

Clankie runs only on the owner's own machines. The phone reaches this Mac
through the public gateway's encrypted doorway, or directly on the LAN.

## Signing this Mac in

`clankie login` (and `clankie remote-access on`) signs in to the Clankie account
by email code and opens this Mac's remote-access doorway; restart the captain
afterwards. Use `--email EMAIL --code-stdin` headlessly. `clankie remote-access
off` takes the Mac off remote access. `/remote-access` (`/gateway` alias) is the
same flow in the console. There is no hosted Clankie to connect to: `clankie
connect` says so and changes nothing.

## Model keys and connected accounts

Provider-key management uses the owner model-key API
(`docs/model-keys.md` under the service root): GET `/v1/model-keys` lists the
same providers/models as `/model`; POST `/set`, `/validate`, `/select`, `/remove`
under that path manage broker API keys and the captain selection. The device
must accept **Take Control** (`terminalControl`) at pairing. Supervise cannot
manage keys; the local operator bearer can. Public gateway calls must use the
encrypted envelope. Keys are write-only: never ask for one in chat or put one in
shell arguments, logs or telemetry. The stored key is validated with a bounded
provider call that may incur a small charge; selection applies on the next
captain turn without a restart.
These endpoints do not establish that the shipped app has an add-provider
screen: check the current client before sending the owner there.

The same devices link the owner's GitHub, Linear and Google accounts through
`/v1/accounts` (ADR 0196; `clankie accounts` on the CLI): a GitHub device flow
and browser OAuth with PKCE, run by this machine, tokens only in its broker. Google
offers separate Gmail, Calendar and selected-file Drive consent using the body
catalog. Gmail and Calendar grants are read-only; Drive's selected-file grant
permits edits, while Clankie's implemented tools only read. Refresh and grouped revocation
stay on this machine. Never ask for a provider token in chat; send the owner to
the app or `/connect accounts`. See the `connected-accounts` skill.

## Support access

The owner chooses Read state or Shell, a support reference and at most 72
hours through `clankie support` or `/support`; see `docs/cli.md` for exact
arguments.
Captain authority cannot issue grants. Read state includes conversation history
and Clankie state but excludes mutations and terminal output. Its pairing offer
mints a read-only device bound to the live grant, including during streams;
revocation or expiry ends access. Shell also permits commands and the content
they can read while its window is open. Treat the grant as the authority to
inspect someone else's body; ordinary fleet health access does not supply it.

## Moving Clankie between bodies

[ADR 0286](../../../../docs/adr/0286-one-body-holds-clankie-at-a-time.md): one
body holds Clankie at a time. `clankie transfer` freezes the source, copies
identity, memory, conversations, projects and tracker, and activates the
destination. The source is released only after the destination is active. A
frozen or released body is dormant: `/health` carries `self` with
`releasedTo`, and everything else answers `503 body_dormant`.

- Never copy a state directory by hand. That starts a second Clankie with the
  same history.
- Never use `reclaim --force` unless the owner asks for it. It can leave two
  histories that are never merged.
- After a failure, rerun with the same `--transfer-id` and do not start a new
  transfer. The source stays frozen until the destination reports itself active.
- Credentials, sign-ins and paired devices never move.
- The old machine joins the new body (`clankie join`, then `transfer rebind`) to
  keep running workers.
- A dormant body answers only health, transfers and device session upkeep.
  Anything else is `503 body_dormant`, which means "he lives elsewhere", not an
  outage.
