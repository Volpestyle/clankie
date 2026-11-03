# ADR 0351: Clankie proposes a setting change and the owner's tap applies it

Status: Proposed, 2026-11-03, from James's approval ("Add it") of an "Ask
Clankie" row in the app's Settings, relayed by his lead. Clankie explains any
option there and can offer to change one for him, behind a confirm step James
taps.

## Context

The app's Settings can talk to Clankie only as an ordinary chat. Nothing tells
his turn that James is looking at Settings, and nothing lets him offer a
concrete change the app could show and apply. The nearest pattern,
`propose_project_create`, has the host apply the change on the owner's
confirmation. Here the brief is stricter: model output is untrusted, and
Clankie must gain no path to write owner settings at all.

## Decision

- **A send can say where the owner is.** `SubmitOperatorConversationTurn`
  takes an optional `surface: { page: "settings", section? }`. `section` is a
  closed list of the app's Settings pages, never free text. The host turns it
  into one fixed context line on that turn ("the owner is sending from
  Settings, ..."); it grants nothing, and channel turns drop it.
- **Clankie can only propose.** The operator lane gets
  `propose_setting_change({ change, reason })`. `change` is one of a closed
  list:
  - the autonomy level
  - one extension's switch
  - pausing or resuming one routine
  - the usage overlay

  Each value is checked against that setting's own schema. Maximum trust,
  Watch, and Advanced or CLI-only settings are not on the list. The tool
  records an ordinary pending `owner_action` ask with the two fixed answers
  "Change it" and "Leave it", and a typed `settingChange` field. The host never
  writes a setting for it. `request_user_input` refuses `settingChange`, and
  its schema doesn't offer it.

- **The owner's app applies it.** The app reads the setting's current value
  through the owner settings API, shows the setting, old value and new value,
  and on the owner's tap applies the change with the same call its own control
  makes, on the device's Take Control authority. Only then does it answer
  "Change it". "Leave it" answers without a write.
- **Clankie hears the outcome as an answer.** The answer message says that
  "Change it" from the app means the app applied the exact change on the
  owner's tap, and that Clankie changed nothing himself and gained no settings
  authority.

## Consequences

- No new write path to owner settings exists. The trust boundary is the
  owner's tap in his app, as it is for every other setting he flips.
- Another surface can answer the same ask, such as the TUI or the feed. It shows
  the ask's fixed step ("open this in the Clankie app and tap Change it"), so
  "Change it" there is only the owner's word, not an applied change. Clankie
  should not treat it as proof.
- An older app ignores `settingChange` and shows the ask as an ordinary choice.
  An older host refuses `surface` as an unknown field, and the app resends
  without it.
