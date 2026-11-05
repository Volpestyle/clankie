# Reading an agent's unsent input

Clankie's existing pane reader distinguishes an empty composer from a draft
before an authorized direct-prompt fallback. This is an observation of the
styled visible screen, not permission to send, answer a dialog or scroll.
The existing status, session, authority, channel and delivery-receipt checks
still apply ([ADR 0334](adr/0334-herdr-direct-prompting-is-the-fallback.md)).

The reader recognizes captured Claude and Codex layouts and these additional
native layouts:

| Harness                      | Recognized composer                                                        | Conservative limits                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode 1.18.35             | Left rail, textarea, blank separator, agent/model footer and bottom edge   | A placeholder needs different native placeholder/model styling. Leader-key dimming, mixed styles and unfamiliar layouts stay unknown. |
| Pi 1.3.0                     | Coloured horizontal rules followed by its dim cwd and context/model footer | Typed rules remain draft content. Clipped editors, scroll indicators, working-status borders and menus stay unknown.                  |
| Grok Build 1.0.70 fullscreen | Bordered `❯` composer with a Grok model footer                             | Nonempty content, including dim text, stays a draft. Missing edges and unfamiliar footers stay unknown.                               |

These are recognized layouts, not promises about every version, theme or
extension. Unstyled output never proves empty. A changed renderer can safely
refuse until its layout is captured and checked. Recognition adds no channel,
does not widen who can send and does not enable a fallback on desktop panes.

Herdr desktop `terminal.read` currently supplies plain text. Desktop input
therefore remains unknown, and desktop hires keep their existing worker
channels. The required styled visible-read capability is tracked on
[Volpestyle/herdr-app#9](https://github.com/Volpestyle/herdr-app/issues/9), our
fork. No upstream change is requested.

The regression fixtures contain sanitized native visible-cell captures.
Their [provenance and derived cases](../apps/clankie/test/fixtures/pane-draft/README.md)
distinguish captured startup screens from draft and malformed-layout mutations.
The integration test replays those cells through a private real Herdr server
and Clankie's normal styled visible-read runner. It sends no terminal input,
focus or scroll command and makes no model call.
