# VUH-1900: plain Claude receives an idle wake on Mac

Tracks: [VUH-1900](https://linear.app/vuhlp/issue/VUH-1900).
Linked Windows PowerShell/Git Bash activation and live proof remain in
[VUH-2084](https://linear.app/vuhlp/issue/VUH-2084).

The Mac implementation installs a stable Clankie-owned zsh pane launcher and Claude
PATH shim. It preserves explicit channels and arguments, checks the selected
plugin profile on launch, and passes through outside the selected Herdr session
or with a disabled plugin. Local external preparation and removal use the
operator API and existing machine setup policy. Bundled zsh panes prepare at
service start. Doctor distinguishes active PATH from configuration for future
panes; docs describe setup, undo and limitations.

Raw observations named below are keys inside the archived `proof.json` bundle
listed in [evidence.json](evidence.json), together with the checked source snapshot.

## Live result

On 2026-10-11 UTC, the active linked Mac Herdr session was `external/default`,
not the bundled runtime. Preparation set only its `default_shell` and reloaded
configuration; existing panes and agents were left alone. The config symlink to
its canonical dotfiles source stayed intact. No dotfiles commit was made.

A new owned pane, `w47:p2X`, ran plain `claude` from an ordinary shell prompt
without a hire or channel arguments. Claude Code `2.1.296` showed
`plugin:clankie-worker@clankie` as its selected channel. Herdr observed native
session `deeaf9d4-2bda-4fed-b27f-329cf4715381` idle (`native-before.json`).

Clankie sent `message_seat` to its discovered **seat ID**,
`term_65d867be7e9c1144`. The pane-ID form returned `unknown_seat`; it was not
the census seat address. The successful original was
`seat-89acf59b-89d1-4fb7-bdbc-a983bce0cdc5`.

- Native channel event: `2026-10-11T01:30:32.704Z`, with that original event ID.
- Native assistant reply: `2026-10-11T01:30:39.255Z`, `VUH1900_IDLE_WAKE_OK`.
- Herdr then observed `done` (`native-after.json`, `idle-after.txt`).
- The durable receiver delivery receipt is in `receiver-delivered.json`.

`native-transcript.jsonl` retains only the matching queue event, channel message
and assistant reply. This proves model awareness of the idle wake, beyond a
transport receipt or argument capture. No agent prompt or fallback message was
typed. The owned proof pane was closed after saving its result.

## Machine setup

The exact canonical Herdr config diff is in `config.diff`:

```toml
[terminal]
default_shell = "/Users/james/.clankie/herdr-pane/default/pane-shell"
```

The lead approved that stable reference and reserved committing the dotfiles
edit for himself. Repeating preparation returned `changed: false`
(`setup-idempotent.json`). `doctor.json` retains only the shim diagnosis and
this proof pane's bridge observation. The worker's old pane correctly reported
`configured-for-new-panes`, rather than claiming its PATH was already active.

Undo after the new API is available:

```sh
clankie herdr prepare local --claude-path-shim remove
```

The pre-deployment preparation used the same source function directly under the
lead's explicit setup approval. It did not restart the service or Herdr.

## Checks and landing

Focused checks passed: three files, 19 tests, including a native child process,
a real interactive zsh PTY, a real release-layout esbuild bundle, config symlink
preservation and API/CLI authorization. Service and TUI typechecks passed.
All commands ran through `clankie heavy --`; the final focused log is retained
in the evidence bundle.

Integration exposed two older exact-shape doctor assertions. Both now explicitly
expect the shim diagnosis: `unverified` when a Mac binding cannot be read, or
`unsupported` on other platforms. The doctor, setup command and owner command
consumer files passed together (38 tests). No other exact-shape doctor consumers
were found in apps, packages or scripts.

An OS sandbox consumer also exposed eager launcher-asset resolution when importing
an arbitrary esbuild bundle. Resolution now happens only during explicit shim
installation; importing a bundle requires no launcher asset. The real sandbox,
native launches, release layout, assetless bundle and doctor consumers passed
together (46 tests across five files).

The tests cover `/tmp` resolving to `/private/tmp` and preserve original config
bytes during setup. The bundled-layout test verifies that preparation copies
the standalone launcher asset rather than the release entrypoint. Existing
sessions were not restarted. The landing gate and pushed commit are recorded
in the issue's final evidence comment; landing uses `clankie integrate --push`.

## Remaining gaps

Automatic activation is Mac zsh only. Explicit custom shell launchers are
preserved and refused by setup. Caller-selected settings, print/admin/bare
launches and nested Claude processes pass through. Aliases/functions and
absolute executable paths can bypass PATH. Plugin/channel trust and native
worker membership still apply. Existing Claude sessions retain their original
channel selection. Windows implementation and idle-wake proof were not run.
