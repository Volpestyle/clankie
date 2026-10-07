# Worker harness sign-in

Sign the Claude Code and Codex worker harnesses into the owner's own accounts
(a Claude subscription, a ChatGPT plan) from a paired app or the CLI, on any
deployment, with no shell on the body ([ADR 0239](adr/0239-worker-harnesses-sign-in-with-their-own-logins.md)).
Each harness runs its own official login; credentials stay in that harness's
own store. This is separate from [model keys](model-keys.md), which configure
Clankie's own model.

Every route requires the local operator bearer or a paired device whose grant
includes `terminalControl` (Take Control); support access cannot call them.
Public gateway calls use the encrypted device envelope. Schemas and paths live
in `@clankie/protocol/harness-logins`.

| Method | Path                        | Request                                       |
| ------ | --------------------------- | --------------------------------------------- |
| GET    | `/v1/harness-logins`        | none                                          |
| POST   | `/v1/harness-logins/start`  | `{ "harness": "claude" }` or `"codex"`        |
| POST   | `/v1/harness-logins/status` | `{ "sessionId": "<returned UUID>" }`          |
| POST   | `/v1/harness-logins/code`   | `{ "sessionId": "…", "code": "<from page>" }` |
| POST   | `/v1/harness-logins/cancel` | `{ "sessionId": "…" }`                        |

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

Login links and codes are sensitive interaction data: do not log or persist
them or put them in conversation messages. Tokens never cross this API.

CLI and console:

```sh
clankie harness login status
clankie harness login codex     # prints the link and code on stderr, waits
clankie harness login claude    # prints the link, prompts for the code
```

`/harness-login` in the console runs the same flow. Ctrl-C cancels the sign-in
on the service.
