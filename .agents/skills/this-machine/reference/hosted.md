# Hosted Clankie

Hosted deployment, managed bodies, managed Discord, a Mac connected to a hosted Clankie, and customer support access.

## Hosted deployment

In the hosted coding image, `/opt/clankie` is the immutable seed and the body runs
`/state/install/current`, which it updates to official releases itself (ADR 0237;
see [updating the runtime](launcher.md#updating-the-runtime)). `/workspace` is
persistent project storage, and `/state` holds the owner home/settings/broker.
Use the existing CLI and skill roots. The whole body runs under the launcher
(`clankie-body`); replacing a container ends live workers, so reconcile persisted
intents before reassigning.
The gateway is only a portal. Managed bodies configure their included model
automatically; a funded first conversation requires no model login, API key,
Mac installation, or infrastructure setup. At the AI-credit limit, direct the
owner to their account for a pack or top-up. Optional personal SSH access or
media tools depend on the managed service's offering.

Optional provider-key management uses the owner model-key API
(`docs/model-keys.md` under the service root): GET `/v1/model-keys` lists the
same providers/models as `/model`; POST `/set`, `/validate`, `/select`, `/remove`
under that path manage broker API keys and the captain selection. The device
must accept **Take Control** (`terminalControl`) at pairing. Supervise cannot
manage keys; the local operator bearer can. Public gateway calls must use the
encrypted envelope. Keys are write-only: never ask for one in chat or put one in
shell arguments, logs or telemetry. The stored key is validated with a bounded
provider call that may incur a small charge; selection applies on the next
captain turn without a restart. The same API works on a self-hosted Mac.
These endpoints do not establish that the shipped app has an add-provider
screen: check the current client before sending the owner there. They are
never a prerequisite for a managed first reply.

The same devices link the owner's GitHub, Linear and Google accounts through
`/v1/accounts` (ADR 0196; `clankie accounts` on the CLI): a GitHub device flow
and browser OAuth with PKCE, run by the body, tokens only in its broker. Google
offers separate Gmail, Calendar and selected-file Drive consent using the body
catalog. Gmail and Calendar grants are read-only; Drive's selected-file grant
permits edits, while Clankie's implemented tools only read. Refresh and grouped revocation
remain on the body. Never ask for a provider token in chat; send the owner to
the app or `/connect accounts`. See the `connected-accounts` skill.

## Managed hosted bodies

`CLANKIE_HOSTED_BOOTSTRAP_FILE` supplies the signed managed host identity.
The managed image also installs a private runtime provider selected by
`CLANKIE_RUNTIME_PROVIDER_MODULE`; the public index loads it on every service
restart. That provider owns included-model policy, quotas, credits and
heartbeat accounting. Bootstrap identity alone does not enable those policies
in the public image. Check the selected image and installed module path when a
provider fails startup.
The service renews its host credential
through the fleet and stores renewals in the broker. Do not repair this by
running `/gateway` sign-in or editing the bootstrap. A fleet rejection needs the
managed tenant's entitlement/provisioning fixed. Unset means a self-hosted body.
Managed wake-key registration and busy reporting are automatic; see
`infra/hosted/README.md` under the doctor-reported service root for the contract.
The volume-backed pairing key registers before those calls or credential
renewal and signs each request. `pairing_key_required` triggers one
re-registration attempt. Persistent `body_signature_invalid` after three
attempts indicates clock skew beyond five minutes or a pairing-key mismatch;
inspect those conditions without exposing tokens, signatures or private keys.
The installed managed provider supplies a hired Pi worker's model configuration
(ADR 0197). Its forwarding and included/customer policy live in private
`clankie-ops/apps/body`; bootstrap identity alone does not configure a worker's
model. Do not log Pi into a provider or put a key in its `models.json`. If a
worker cannot reach its model, inspect the installed provider and the owner's
selection with `clankie doctor` and `clankie model`; manage the credential through
the owner model-key API above.
Clankie's Claude subscription auth is removed; `/auth anthropic` is API-key-only.
Hosted ChatGPT login and forwarding refuse pending OpenAI approval; offer a
provider API key or included usage. Never submit the waitlist, invent an approval
date or enable this path on the owner's behalf. Local/self-hosted ChatGPT and
native unmodified Claude Code/Codex seat logins keep their own supported paths.

## Managed Discord connection

Hosted Discord installation, channel permissions, status and disconnect belong
to the fleet account page. The shared official bot token never belongs in this
body's broker or bootstrap. Do not start a local official bridge with that token.
Remote addressed text reaches the same Discord captain through the sealed
`/v1/discord/ingress` connection API (`docs/discord-ingress.md`); it accepts neither
an operator bearer nor arbitrary grants. Mentions, DMs, replies and commands
can wake a sleeping body; other channel chatter is not replayed later. Without
Message Content access, unmentioned follow-ups and ping-disabled replies may
need a mention or DM. A failed delivery marked interrupted was admitted before
a restart: inspect effects before explicitly retrying it.

Hosted directory pages come from the managed provider and are restricted to the
bound server/current installation. Inspect `managedPolicy` before claiming a
saved policy reached the edge; pending or unavailable is not an acknowledgement.
The account dashboard uses a Discord-only owner permit. Disconnect/reinstall
revokes that connection grant; it does not create a terminal or paired-device grant.
For a managed Discord call, inspect the current connection and voice status;
the managed connection owns media and credentials. The tenant body receives only
sealed briefing, attributed captain handoff and voice self-tool callbacks.
Use the existing server/role and voice settings; a hosted customer supplies no
bot token or provider key. Report a pending wake or unavailable call as observed,
and keep live voice verification separate from a successful policy save.

## A Mac connected to hosted Clankie

`clankie login` signs in by email code. An account with a hosted Clankie pairs a
revocable hosted device; one without signs this Mac in for remote access (and
re-signs a signed-out Mac), so a bare `not_found` no longer means "wrong command".
Use `--email EMAIL --code-stdin` headlessly; `whoami` reports the machine and
access state without secrets. `logout` forgets this Mac's session/wake key and
selects This Mac for the next launch, leaving hosted work running; it never
touches remote access (`clankie remote-access off` does). `connect
hosted`/`disconnect` remain aliases. `/connection` and `/settings` expose modes.
Hosted mode never starts a local body; the footer says `Hosted · <machine>`.

Use chat/conversations, fleet, terminal, model, keys, persona and connections
against the selected host. Restart, reset and deprovision are account/control
plane operations, never device-session operations. The shared policy applies
to both operator bridge and legacy relay. Terminal control still executes its
user's raw input; the route policy is not a shell sandbox.

The console retains conversation/cursors per host; `--chat ID` overrides the
selection and `/reconnect` retries it. The fleet currently gives an account one
tenant, so login auto-selects it; the client supports a picker for multiple
results. Account tokens are not retained after pairing. Device credentials and
wake signing material live in the Mac broker; model/account keys stay hosted.

Status distinguishes Asleep/Waking, Sign-in expired, Access revoked and
Unavailable. A paired Mac wakes the body with the app's device-signed challenge
protocol. First login uses account wake. Never start a local copy to repair
hosted access. Local sockets, lifecycle, `seat`, `mcp` and shell escapes refuse.
`/remote-access` is self-hosted Remote access for this Mac (`/gateway` alias),
and checks for an existing hosted tenant before configuring a doorway.
Matching deployments and a real Mac/phone rehearsal are separate gates.

## Customer support access

The customer chooses Read state or Shell, a support reference and at most 72
hours in the hosted app or web account page. An owner can use the same body API
through `clankie support` or `/support`; see `docs/cli.md` for exact arguments.
Captain authority cannot issue grants. Read state includes conversation history
and Clankie state but excludes mutations and terminal output. Its pairing offer
mints a read-only device bound to the live grant, including during streams;
revocation or expiry ends access. Shell also permits commands and the content
they can read while its window is open. Treat the grant as the authority to
inspect a customer's body; ordinary fleet health access does not supply it.
