# Security policy

Report vulnerabilities privately to the repository maintainers. Do not put
exploit details, credentials, private message content, or user-session tokens in
a public issue.

Clankie's current security boundaries are:

- The clankie service and native producer/listener ports bind to loopback.
- Local services authenticate with brokered bearers. The remote relay requires a
  live device session with the `chat` grant on every request and tail poll.
- The credential broker is canonical for provider, Discord, mailbox, and
  internal credentials. Compatibility model/media provider keys may come from
  the process environment; logs and public protocol results remain secret-free.
- Discord, attachments, generated media responses, browser content, and model
  output are untrusted input. Machine tools reach Discord only through owner
  grants (`systemActorUserIds`, and optionally trusted guilds/channels). An
  individually granted actor in a shared room gets a one-shot tool-bearing
  turn; official-bot DMs and trusted guilds own a durable tool-bearing lane.
  Voice is as capable as the room it is in.
- Bot and personal-lab Discord credentials live in separate processes. The
  user-session body is off by default and requires explicit owner opt-in.
- Vox is a separate native process behind validated, bounded IPC.

High-priority reports include authentication bypass, cross-device or
cross-channel disclosure, credential exposure, unsafe attachment/media fetches,
Discord allowlist or consent bypass, native media parser issues, and any path
that gives untrusted input machine tools.

For containment, stop affected services with `clankie down`, preserve the
mode-0600 state logs without publishing them, revoke affected provider or
Discord credentials, rotate the operator bearer with
`clankie operator-credential rotate`, and revoke paired devices with
`clankie devices revoke <id>`.
