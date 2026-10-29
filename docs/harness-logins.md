# Worker harness sign-in

Sign the Claude Code and Codex worker harnesses into the owner's own accounts
(a Claude subscription, a ChatGPT plan) from a paired app or the CLI, with no
shell on the body ([ADR 0239](adr/0239-worker-harnesses-sign-in-with-their-own-logins.md)).
Each harness runs its own official login; credentials stay in that harness's
own store. This is separate from [model keys](model-keys.md), which configure
Clankie's own model.

Every route requires the local operator bearer or a paired device whose grant
includes `terminalControl` (Take Control); support access cannot call them.
Public gateway calls use the encrypted device envelope. Schemas and paths live
in `@clankie/protocol/harness-logins`.

| Method | Path                          | Request                                       |
| ------ | ----------------------------- | --------------------------------------------- |
| GET    | `/v1/harness-logins`          | none                                          |
| POST   | `/v1/harness-logins/start`    | `{ "harness": "claude" }` or `"codex"`        |
| POST   | `/v1/harness-logins/status`   | `{ "sessionId": "<returned UUID>" }`          |
| POST   | `/v1/harness-logins/code`     | `{ "sessionId": "…", "code": "<from page>" }` |
| POST   | `/v1/harness-logins/cancel`   | `{ "sessionId": "…" }`                        |
| GET    | `/v1/harness-logins/accounts` | none                                          |
| POST   | `/v1/harness-logins/remove`   | `{ "harness", "profile": "<label>" }`         |

GET returns `{ "harnesses": [{ "harness", "installed", "signedIn", "method"? }] }`.
Claude's `method` is `subscription` or `api_key` (an `ANTHROPIC_API_KEY` on the
body); Codex reports its own, e.g. `ChatGPT`.

Start answers `{ ok: true, sessionId, harness, expiresAt, state: "pending" }`;
poll status until `url` appears:

- **Codex** (`state: "pending"` with `url` and `userCode`): open the link, enter
  the code. Codex finishes by itself and the state becomes `complete`.
- **Claude** (`state: "needs_code"` with `url`): open the link, sign in, copy
  the code the page shows and POST it to `/code`. The state becomes `verifying`,
  then `complete`, or back to `needs_code` with `codeRejected: true` so the
  owner can send the code again in the same sign-in.

Terminal states are `complete`, `cancelled`, `expired` (15 minutes) and
`failed`; they drop the link and code. One sign-in runs at a time (`busy`, 409),
only its starter can read or cancel it (`session_not_found`, 404), and a harness
missing from the body answers `not_installed`. Completion is confirmed with the
harness's own status command, never the login's exit code alone. A completed
Claude subscription sign-in declines an `ANTHROPIC_API_KEY` on the body so the
subscription is used.

## Several accounts per harness

A body can hold several Claude or Codex accounts, each in its own profile home:
the default (`~/.claude`, `~/.codex`) plus `~/.claude-<label>` and
`~/.codex-<label>` and any home registered with `clankie accounts`. These are
the accounts hires choose among (`worker_accounts`).

`GET /v1/harness-logins/accounts` lists them from the same identity-keyed
reader: `{ harnesses: [{ harness, installed, accounts: [...] }] }`, one row per
signed-in identity (homes sharing a sign-in collapse into `profiles`) plus one
per signed-out profile. Each row has `profile` (what start and remove target),
`default`, `managed` (Clankie created it), `signedIn`, `identity` (email),
`plan`, `headroom` and `resetsAt` when usage was read, `ready` (Clankie would
hire on it now) and `held`. No home path, token or native account ID crosses it.
`GET /v1/harness-logins` stays the default home's status, unchanged for shipped
apps.

Start takes one of:

- `{ harness }`: the default home, as before.
- `{ harness, profile }`: re-sign exactly that profile's home. If the vendor page
  signs a different account in, the completed session carries
  `identityChanged: { before, after }` and the profile's labels move to the new
  identity, so a hire naming that label reaches what is signed in now.
- `{ harness, add: { label? } }`: create a fresh `~/.claude-<label>` or
  `~/.codex-<label>` (default label `account-N`) and sign a new account into it.
  It never reuses an existing label or home (`profile_exists`); a cancelled,
  expired or failed add deletes the home it created. If the account was already
  signed in elsewhere, the completed session names `duplicateOf`.

Sessions started this way carry `profile`. Remove signs one profile out with the
harness's own logout, which may revoke that sign-in: the owner confirms first.
A profile Clankie created is then deleted (`deleted: true`); any other stays,
signed out. The default and standard homes are never removed
(`default_profile`); re-sign them instead. A profile that does not exist answers
`profile_not_found`. A new Claude profile still needs its first-run setup and the
worker plugin (`clankie herdr prepare`) before hires use it; its row shows
`ready: false` until then.

Login links and codes are sensitive interaction data: do not log or persist
them or put them in conversation messages. Tokens never cross this API.

CLI and console:

```sh
clankie harness login status
clankie harness login codex     # prints the link and code on stderr, waits
clankie harness login claude    # prints the link, prompts for the code
clankie harness login accounts                  # every account per harness
clankie harness login claude --add [LABEL]      # a new account in a new profile
clankie harness login codex --profile work      # re-sign that profile
clankie harness login remove codex work [--yes] # confirms unless --yes
```

`/harness-login` in the console runs the same flow. Ctrl-C cancels the sign-in
on the service.
