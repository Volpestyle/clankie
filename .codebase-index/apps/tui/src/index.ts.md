# apps/tui/src/index.ts

Operator console entry point (requires a TTY on both
stdin and stdout). Builds everything and starts the
face shell against the single clankie service
(`CLANKIE_CONTROL_PLANE_URL`, default
`http://127.0.0.1:4310`).

Assembly order: Herdr roster + presence poller;
operator credential → `ClankieApiClient` (activity)
and presence auth; provider services (credential
store, model registry, config change callback that
updates the banner's model field); captain-route
client (bearer from `resolveCaptainRouteToken`) →
conversation client, lane-trace controller,
selection/tail stores under `.data/tui/`, and the
`OperatorConversationPromptSession`. Resolves the
initial conversation (`--chat` id, persisted
selection, or server default), surfacing failure as a
notice rather than dying.

The shell gets: all command sets, banner fields (with
herdr/tmux stage detection), a prompt-history path,
status extras (model ref + presence phase), and an
`onPrompt` that routes plain prompts through the
conversation session with a local-echo-suppressing
sink; `interruptMode: "detach"` because Esc only
stops observing a durable server turn. A fatal-error
envelope restores the terminal (SGR mouse + raw mode)
on uncaughtException/unhandledRejection before
exiting. On start it prints a connected/unavailable
notice, restores the durable transcript tail, and
loads the model config for the banner.
