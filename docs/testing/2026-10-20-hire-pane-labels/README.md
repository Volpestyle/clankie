# Hire pane labels

Tracks: https://linear.app/vuhlp/issue/VUH-2541

The hire allocator previously labelled panes with `title · role`, with no task
caption. Herdr's agent metadata title and terminal OSC title are separate from
its manual pane label; `herdr-watch.ts` and `herdr-census.ts` fall back to the
harness title. Saved-session adoption also used that observed title rather than
the requested human name.

`hire_agent` and `spawn_seat` now accept `taskTitle`. New panes use the manual
label `Name · task`, falling back to the role and then `Work`. Routing keys,
harness names and paths are filtered from captions. Confirmed saved-session
starts replace their temporary reconciliation marker on their newly allocated
pane. Already-live resumes keep their existing pane. Persona adoption uses the
requested human name, so the roster and pet strip retain the name alone.

## Checks

`clankie heavy -- pnpm exec vitest run` with these five files: **59 passed**.

- `apps/clankie/test/hire-name.test.ts`
- `apps/clankie/test/hire-layout-journey.test.ts`
- `apps/clankie/test/codex-seat-hire.test.ts`
- `apps/clankie/test/claude-hire-startup.integration.test.ts`
- `apps/clankie/test/native-session-resume.test.ts`

The adapter tests assert both hire labels at allocation. The real Herdr journey
uses a fresh private socket and native processes that emit the reported OSC
titles. `Wren · Chats drawer` survives `Claude Code` and `✳ Claude Code`;
`Ines · Chats drawer` survives POSIX and Windows worktree captions. Assertions
also retain the unrelated pane's unsent draft, focus, placement and labels.
The captured socket calls, snapshots and cleanup receipt are archived beside
this document. These terminal producers exercise the OSC boundary; they are
not paid Claude/Codex model hires or native Windows runtime proof.

Consumer inspection: `fleet-roster.ts` prefers `persona.name`, as do the app's
Messages model and destination. `fleet-roster-work.ts` derives work from
`liveSeatIssue` and confirmed seat membership, not pane titles. No consumer
contract change or app edit was needed for VUH-2510/VUH-2512.

## Live proof still pending

The owner will deploy and perform fresh hires. Read back each new pane's manual
label and roster name on Mac and PC, distinguishing the dynamic terminal title.
No installed runtime was restarted or deployed, and no pre-existing pane was
renamed or closed by this work.
