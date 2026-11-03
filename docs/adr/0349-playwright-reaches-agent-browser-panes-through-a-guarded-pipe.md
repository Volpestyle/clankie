# ADR 0349: Playwright reaches agent browser panes through a guarded DevTools pipe

Status: Accepted, 2026-11-03, implementing James's approved request relayed by his lead: "let agents drive the Herdr Browser with Playwright instead of reinventing it", with no open-to-anyone debug port, a token only Herdr hands out, and a guard in front of CDP. Amends [ADR 0344](0344-agents-drive-herdr-browser-panes-through-herdr.md), whose "No network port" decision now allows this one guarded loopback endpoint. Tracked in [#560](https://github.com/Volpestyle/clankie/issues/560); built in [Volpestyle/herdr-app#5](https://github.com/Volpestyle/herdr-app/pull/5).

## Context

ADR 0344 gave agents a small set of Herdr commands (`browser.snapshot`, `browser.click` and the rest). The audit in #560 compared them with Playwright. They cover navigation, ref clicks, waits and viewport screenshots. They lack JavaScript evaluation, locators, network and console events, full-page screenshots, cookie access and new pages. Rebuilding Playwright command by command would never catch up. Agents already know Playwright.

ADR 0344 rejected Chromium's remote debugging port because any local program could drive every page, including the person's signed-in ones, with no notion of panes. That reason still holds against the raw port.

## Decision

**`browser.cdp` hands an agent a token-gated loopback endpoint for `chromium.connectOverCDP`. The endpoint is a filtering bridge Herdr owns, not Chromium's port.**

- Chromium serves DevTools only on a pipe. Herdr claims fds 3 and 4 when the app starts and adds `--remote-debugging-pipe` to its own browser process. The pipe never leaves the app.
- The first `browser.cdp` on an agent-profile pane starts a WebSocket on `127.0.0.1`. Its path carries a 256-bit token that is random per launch and returned only by that command, over the user-only control socket. The endpoint therefore has the same trust line as every other ADR 0344 command. Even with the token, any `Origin` (a web page) and any non-loopback `Host` (DNS rebinding) are refused.
- Each client gets its own browser session. The bridge shows only agent-profile targets, and it releases and detaches paused hidden ones. It denies browser-level methods by default, including context creation, browser-target attach, close/crash and default-context storage. `Browser.close` only disconnects the client. Person panes refuse `browser.cdp` and never appear.
- CEF profiles are not DevTools browser contexts. Playwright's cookie calls therefore become page-scoped `Network` calls on an agent page, and `clearCookies` is refused. The end-to-end proof caught `Storage.getCookies` on a page session returning the person profile's cookie; that path is denied everywhere.
- `context.newPage()` opens a real agent pane beside the pane that minted the endpoint, so the owner sees every page an agent drives.

## Consequences

- Workers use Playwright's full API on a pane the owner can watch, with no browser download and no second Chromium.
- Raw CDP bypasses the password-field refusal and the `confirmed` guard of ADR 0344's commands. The bridge's answer is reach: only the agent profile, never person panes. Sign-ins still go through the ADR 0342 vault card. All agents share the agent profile and its panes.
- Not available: new contexts, permission grants, `clearCookies`, Playwright download events (agent downloads save in the app home) and adoption of page-opened popups. `goBack` needs `waitUntil: 'commit'` because Playwright cannot pass its flag that disables Chromium's back/forward cache.
- Person-profile downloads now open Chromium's save dialog (a gap from the #560 audit). A URL allowlist was optional in the request and is not built.
- Installing a build with this bridge on the Mac needs the owner's yes, like any Herdr Browser swap.
