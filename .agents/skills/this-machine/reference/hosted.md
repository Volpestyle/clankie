# Hosted Clankie

Hosted deployment, managed bodies, managed Discord, and a Mac connected to a hosted Clankie.

## Hosted deployment

In the hosted coding image, `/opt/clankie` is the immutable install, `/workspace`
is persistent project storage, and `/state` holds the owner home/settings/broker.
Use the existing CLI and skill roots. Compose owns process restarts; replacing a
container ends live workers, so reconcile persisted intents before reassigning.
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

The same devices link the owner's GitHub and Linear accounts through
`/v1/accounts` (ADR 0196; `clankie accounts` on the CLI): a GitHub device flow
and Linear OAuth with PKCE, run by the body, tokens only in its broker. Never
ask for a GitHub or Linear token in chat; send the owner to the app or
`clankie accounts connect github`.

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
A hired pi worker runs on the body's own model path (ADR 0197): on included
usage, `clankie/default` through the loopback forwarder; on the owner's supported provider key, `clankie-customer/<model>` through the same loopback's
`/customer` route, which attaches the credential from the broker. Pi holds no
key there. Do not log pi into a provider or put a key in its `models.json`; if
a worker cannot reach the model, check the owner's selection and credential.
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
