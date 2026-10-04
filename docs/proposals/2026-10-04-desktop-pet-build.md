# Desktop pet build brief

Lead and harvest owner: Herdr pane `w3Z:p19`. Scope changes: James, through
the lead. Worker: Codex `gpt-6.1-sol` at xhigh, with native subagents at
`gpt-6.1-sol` medium.

## Decisions to build

- Public service side: [clankie ADR 0220](../adr/0220-clankie-has-one-present-tense.md).
- App side: `~/dev/clankie-app/docs/adr/0059-clankie-lives-on-the-desktop.md`.
- Design and playable prototype: <https://claude.ai/artifact/HiRjtPWAjaqJLFGxo4doa3>.
  Use it as the reference for feel: moods, hover pill, drag-walk, resize,
  minis with a "+N" badge, the pocket panel's Chats and Work tabs.

## Result

Clankie lives on the macOS desktop as a floating window of the existing
react-native-macos app. He shows his present-tense mood from one `presence`
read and opens a small chat and work panel that reuses the app's own screens.
He works against local and hosted Clankie through the app's paired device
session.

## Slices

Each slice gets one Linear issue in the
[Clankie project](https://linear.app/vuhlp/project/clankie-7f2de0de4a75/overview),
under one parent. File them first, through Clankie's connected bridge
(`clankie_tools` / `clankie_call`) using the `linear-issues` skill, and keep
each issue's state and evidence current. If the bridge isn't available, ask
the lead to make the writes.

1. **`presence` operation (clankie).** Add a strict, cursor long-poll operator
   operation shaped like `fleet`. It returns `mood` (`thinking`, `in_voice`,
   `playing`, `leading`, `needs_you`, `idle`), `detail`, `since`, the active
   seat count, and the pending owner item, if any. Derive it from existing
   sources (captain lanes, Discord presence, live play activity, fleet seats,
   pending approvals) with no new state. Add it to the hosted operator
   allowlist and make sure the relay passes it through. Show it in
   `clankie status`. Update `docs/cli.md` and the OpenAPI spec as the repo's
   conventions require.
2. **`desktop` tool (clankie).** Add a captain tool that lets him emote, move,
   or say a line on a desktop body. It goes out through `presence` as a
   transient expression with an expiry. Clients never take keyboard focus for
   it. Respect owner quiet hours if a setting exists; otherwise add a TUI- and
   CLI-exposed one. Update the shipped skill or tool description that needs
   the lesson.
3. **Art sync (app).** Add a re-runnable script that copies the built
   `~/dev/clankie/branding/pet/clankie-pet.{png,json}` and
   `clankie-mini.{png,json}` into app assets and generates a typed manifest,
   the way `assets/garden-atlas/atlas.gen.ts` does. The art is still being
   refined by another agent (pane `w3Z:p1F`). Never edit `branding/pet/`;
   rerunning the sync is how new art comes in.
4. **Pet window (app, native macOS).** A borderless, non-activating floating
   panel on every Space and in full-screen app spaces, hosting its own React
   Native root, and able to run while the main window is closed. Clicks only
   land on his opaque pixels, so the transparent area passes clicks through.
   Drag him anywhere; resize at whole scales from 2× to 6×; remember position
   and scale per display. Add a login-item setting. No Accessibility
   permission.
5. **Pet body (app).** A sprite player for the Aseprite sheet that honors
   per-frame durations (the `think` easing lives there) and one-shot tags.
   Behavior:
   - mood from `presence`
   - walk while dragged
   - hop on hover
   - `fall_asleep` → `sleep` → `wake` when idle
   - `catch` while a file is dragged over him
   - two tinted worker minis, then a "+N" badge
   - unreachable (`offline`) when the relay or service doesn't answer, never
     shown as sleep

   Honor Reduce Motion.

6. **Pocket panel (app).** A hover pill with compose, dictate and list
   buttons. The panel has Chats (the history drawer's directory: new chat, his
   threads, worker threads, Discord rooms) opening a compact chat screen with
   a composer, and Work (agent seats from `fleet` plus in-progress work items;
   tapping an agent opens its thread). "Open in app" brings the main window to
   the same chat. Files dropped on him go through the existing attachment
   upload operations. Reuse `ChatHistoryDrawer`'s directory,
   `ClankieChatScreen` and `WorkDestination` logic rather than forking them.
   On-device dictation into the composer may land as a follow-up issue if it
   blocks the rest. Record that in Linear if so.
7. **Connect screen (app), last.** Switch `ConnectAvatar` to the hero sprite:
   `think` for connecting, `alert` for asking, `offline` for wilted, `hop` into
   `happy` for celebrating, and `fall_asleep` → `sleep` for asleep. The garden
   skin stays for multi-agent scenes.

Order: 1 and 3 can start in parallel. 4 and 5 need 3. 6 needs 1 and 4.
2 follows 1. 7 needs 3 and runs last. Split work across your native subagents
by these boundaries, one owner per slice.

## Shared checkouts

Both checkouts are shared with other agents; load `shared-checkout`.

- In `~/dev/clankie`, pane `w41:p3` is editing `packages/protocol/src/index.ts`
  and `docs/adr/README.md` for Minecraft. Put the `presence` schemas in their
  own `packages/protocol/src/presence.ts`. Coordinate the one-line union and
  allowlist hunks in `index.ts` with that pane's owner before writing; don't
  race it.
- In `~/dev/clankie-app`, other agents have uncommitted dock and model-key work.
  Leave those files alone.
- The lead owns the uncommitted ADRs (0220, 0059) and this brief; ask before
  changing them. `branding/pet/` belongs to the art agents.

Commit your own paths on `main` in logical commits after each slice's checks
pass. Don't push, release or restart shared services.

## Acceptance

- Each slice has focused tests that pass, plus `pnpm check` in clankie and the
  app's equivalent checks before handoff. Known unrelated failures get named,
  not hidden.
- **Live proof on this Mac:** the macOS app built and running against the local
  service, with the pet:
  - showing a real mood change (start a captain turn, then watch `think`)
  - dragged, resized and remembered across a relaunch
  - opening the panel, continuing a real conversation, and listing real seats

  Capture screenshots or a short recording.

- Dropping a file on him reaches the conversation as an attachment.
- The service turns "unreachable" when the local service stops, and the pet
  recovers when it comes back.

## Report

Message the lead pane only for a decision, a cross-owner conflict, or a real
blocker. When everything's done, reply in your pane with a few lines: outcome,
commits, checks and results, evidence paths, Linear links, and open gaps.
