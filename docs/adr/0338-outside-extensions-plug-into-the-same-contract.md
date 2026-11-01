# ADR 0338: Outside extensions plug into the same contract

Status: Proposed, 2026-11-01, for James to decide. Research and docs only; no
code changes. Extends [ADR 0328](0328-clankie-is-a-core-with-extensions.md) and
generalizes the owner-installed game modules of
[ADR 0234](0234-games-share-one-extension-contract.md#amendment-owner-installed-external-extensions-2026-10-17-vuh-2419).
Keeps the trust boundaries of [ADR 0251](0251-discord-owners-and-room-skills.md)
and [ADR 0244](0244-machines-join-clankie-at-an-access-level.md), and the
owner-machine-only rule of [ADR 0300](0300-clankie-runs-only-on-the-owners-machine.md).

## Context

James asked whether Clankie's extensions could become plugins that other people
write, maybe with a plugin marketplace.

Most of the pieces already exist:

- ADR 0328 split the service into a core and extensions behind one contract,
  `ClankieExtension` in [`@clankie/extension`](../../packages/extension/README.md):
  `contractVersion: 1`, an `id`, a settings key and parser, `needs` (the core
  ports it asks for by name), an inert `create`, and a runtime with `start`,
  `stop`, `health` and `projection`. `ExtensionSupervisor` hands each extension
  only the ports it named and contains its failures. The owner's on/off switch
  is `settings.extensions` (`clankie extensions on|off ID`, Settings →
  Extensions in the app).
- The built-in extensions (`relay`, `browser`, `computer`, `media`, `tracker-linear`,
  `world`, `voice`, `persona`) are still in-repo files that the composition
  root wires. `voice-extension.ts` and `persona-extension.ts` show the shape:
  each takes live objects from the composition root and projects HTTP routes.
  Their `needs` lists are empty because the core hands them what they need
  directly; the `CorePorts` in `extension-host.ts` include the credential
  broker, the whole `SettingsStore` and `process.env`. That is fine for code
  in this repository and far too much for a stranger's.
- `scripts/check-extension-boundary.mjs` still lists 24 core-to-extension
  imports in its baseline (down from 123 on 2026-11-01).
- Games already load outside code. Since 2026-10-17 the owner may add a module
  by absolute path to `gameplay.extensions`; the service imports it at start.
  The module exports an API version and gets a narrow host: non-secret options,
  a private state directory, the shared play ledger, credentials only in its
  own broker namespace, and a Go Live request. Rivals runs this way from its own
  repository.

### How the harnesses Clankie leads ship plugins

- **Claude Code**: a marketplace is any git repository (or local folder) with a
  `.claude-plugin/marketplace.json` listing plugins and their sources.
  `/plugin marketplace add owner/repo` adds a listing; `/plugin install
name@marketplace` installs one. There is no central server: GitHub hosts the
  files. Plugins (hooks, MCP servers, skills) run with the user's own rights;
  the safety model is "add listings you trust", plus managed settings that can
  restrict which marketplaces are allowed. Clankie ships its own seat and
  worker this way (`integrations/claude-plugin/.claude-plugin/marketplace.json`).
- **Codex**: `codex plugin marketplace add PATH`, then `codex plugin add
name@marketplace`. Hooks do nothing until the user reviews and trusts each
  definition in `/hooks`, and a changed definition needs review again
  (`integrations/codex-plugin/README.md`).
- **Herdr**: a plugin is a folder with a `herdr-plugin.toml` manifest (`id`,
  `version`, `min_herdr_version`, `platforms`, actions, panes) whose commands
  run as ordinary processes (`integrations/herdr-plugin`).

None of them sandbox plugin code. All three put the listing in a git repository
and leave trust to the user, and Codex adds a review step whenever something
that runs changes. None of them runs a server to host plugins.

## Decision

### What an outside extension is

An outside extension is a package or folder that exports the same
`ClankieExtension` the built-in ones use, plus one manifest. The owner adds it to
their config; the service loads it at start, after the core is ready, and it has
its own owner switch in `settings.extensions`, like `voice` or `relay`.

The manifest (`clankie-extension.json`, or a `clankie` field in `package.json`)
declares: `id`, `version`, the contract versions it supports, the entry module,
and the permissions it asks for. Clankie reads the manifest without running the
code, so the owner sees what it asks for before anything loads.

Settings gain `extensions.installed`: a list of `{ id, source, pin, granted }`.
The CLI is the interface (`clankie extensions add|remove|update|grant`), the app
shows the same list in Settings → Extensions, and a tool call or model output
never adds or grants an extension (as for games today).

### What it may touch

Only the core ports the contract offers, under the existing trust boundaries:

- **Permissions are ports.** Each port is one named permission: post to a
  conversation, add tools, add HTTP routes under `/v1/ext/ID/`, a private state
  directory, credentials in its own broker namespace (`ID` or `ID-*`), read its
  own settings key, write evidence, read a lease. Outside extensions get a new,
  narrow set (`OutsidePorts`), never today's `CorePorts`: no whole
  `SettingsStore`, no `process.env`, no unscoped credential broker.
- **Asked, then granted.** At `add` and on every `update`, the CLI or app lists
  each permission the manifest asks for, and the owner grants or refuses each
  one. A refused permission is simply not in the host object; if the extension
  can't run without it, it starts `degraded` with that reason. An update that
  asks for a new permission stays on the old version until the owner grants it.
- **No machine authority above the ceiling.** An extension never gets shell,
  screen or worker hiring as a port. When it needs the machine, it asks the core,
  and the core applies the machine's access level (ADR 0244) and who is asking
  (ADR 0251) at the moment of the effect, exactly as for Clankie's own tools.
  Its tools inherit the calling conversation's authority: in a mixed Discord
  room they are social only, and a room skill grant never lifts them.
- **Its output is untrusted.** What its tools return is model input, never
  instructions, the same as web pages or Discord messages.

**Plainly: these limits bind honest code, not hostile code.** An extension
loaded into the service's Node process runs as the owner's user and can import
`node:fs` or `node:child_process` and ignore its ports. The permission list
makes an honest extension's reach visible and keeps mistakes contained; it is
not a sandbox. That is the same bargain Claude Code, Codex and Herdr make, and
the docs and the `add` prompt must say so in those words. A real boundary needs
the extension in its own process under an OS sandbox (Option C below).

### Where they come from

1. **A local folder** (`clankie extensions add ./path`). No pin; the owner owns
   the code. This is the developer loop and how James tries someone's work.
2. **A git repository or npm package** (`clankie extensions add
github:owner/repo`, `npm:@scope/name`). Always pinned: a git commit sha, or
   an npm version plus its integrity hash from the lockfile entry. Clankie
   fetches it into `~/.clankie/extensions/ID/VERSION/`, installs its
   dependencies with lifecycle scripts off, and never follows a moving tag or
   `latest` at start. Updates happen only when the owner runs `clankie
extensions update ID`, which shows the new version, the changed permissions
   and a link to the diff, and asks.
3. **Later, a listing (a "marketplace").** A listing is a git repository with
   one `clankie-extensions.json`: for each entry, its id, description, source,
   pinned sha or integrity hash, the permissions it asks for, and who reviewed
   it. `clankie extensions listing add owner/repo` adds one; `clankie
extensions browse` and the app read it. Clankie's own listing would live in a
   public `Volpestyle/clankie-extensions` repository. Other people can publish
   their own listings the same way, and the owner chooses which to add.

What a listing needs, and what it costs:

| Need                 | How                                                                                                                              | Cost                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Integrity            | Pinned commit sha or npm integrity hash in the listing; Clankie refuses a mismatch. No signing keys to run.                      | None                                          |
| Review               | A pull request to the listing repository; an entry merges after someone reads the code at that sha. Reviewers are named in it.   | Reviewer time, the real cost                  |
| Updates to the owner | The listing moves its pin; the owner's Clankie notices on `browse` or once a day, then shows it in `clankie status` and the app. | None; the owner's machine polls GitHub        |
| Pulling a bad one    | The listing marks the entry `withdrawn`; Clankie switches it off at next start and tells the owner.                              | None                                          |
| Hosting              | GitHub serves the listing and the code. No server, database, accounts or payments.                                               | None, which meets the no-hosting-overhead ask |

Signing (Sigstore, npm provenance) can come later if listings grow; a pinned
hash from a reviewed listing already proves "this is the code someone read".
The real ongoing cost of a marketplace is review work and responding when an
extension misbehaves, not infrastructure. An unreviewed "community" section
would cost nothing to run and shift that risk to owners; this ADR leaves it out.

### What has to be true first, and the order

1. **The contract is stable and versioned.** `contractVersion` is `1` but has
   changed weekly during the reshape. Freeze a v1 of the outside surface only:
   manifest, `OutsidePorts`, projection (tools, routes, doctor checks). Built-in
   extensions can keep the wider `CorePorts`; outside ones get the narrow set.
   The host supports the current and previous contract version.
2. **The remaining core-to-extension edges are cut.** The 24 baseline edges are
   all built-in code; they don't block outside extensions directly, but until
   the persona and voice moves finish, the port list keeps changing. Freeze
   after ADR 0328's order step 5.
3. **A public SDK package.** Publish `@clankie/extension` (today `private: true`
   and shipped as `.ts`) to npm with the manifest schema, `OutsidePorts` types,
   a test host that runs an extension against fake ports, and a template repo.
   `@clankie/game-extension`'s module types fold into it, so Rivals and
   Minecraft keep working as a specialization.
4. **The loader.** Generalize `game-extension-modules.ts` into one loader for
   `extensions.installed`: manifest read, permission grants, pinned fetch, the
   supervisor's existing failure boundary, and doctor rows. `gameplay.extensions`
   keeps loading and migrates in place.
5. **One real outside extension proves it,** end to end against the real
   service (ADR 0221): move Rivals onto it, or write a small one (a weather or
   RSS tool) from the template in its own repository.
6. **Then the listing,** only once there is more than one outside extension
   worth listing.

**Smallest first step:** steps 1, 3 and 4 for local folders and pinned git
sources only, with Rivals as the proof. No listing, no npm, no review process
yet. It is mostly reshaping code that already ships for games.

## Options considered

- **A. In-process, owner-trusted modules with declared permissions
  (recommended).** The path above. Matches the harnesses James already uses and
  the games loader already in the service. Cheap. Not a sandbox, and says so.
- **B. Only MCP servers.** Outside authors write an MCP server and Clankie
  connects to it as a tool source. No new contract, and a separate process for
  free. But MCP can't add HTTP routes, settings, health, doctor rows, app
  screens or a lifecycle, and ADR 0328 already chose one contract for those.
  Keep MCP as a way an extension's _tools_ may be served, not the whole answer.
- **C. Out-of-process extensions under an OS sandbox.** Each outside extension
  runs as its own child process (macOS Seatbelt, as Codex uses for commands;
  something else on Windows), speaking the port contract over a socket. A real
  boundary: the permission grant becomes enforcement. Costs a wire protocol for
  every port, per-platform sandbox profiles, and slower tool calls. Recommended
  as the requirement for any listing beyond extensions James or Clankie's
  workers reviewed, not as the first step.
- **D. A hosted marketplace** (server, accounts, uploads, ratings). Rejected:
  hosting and moderation overhead James doesn't want, and ADR 0300 removed
  hosted parts for that reason.
- **E. No outside extensions.** Others fork the repository. Zero cost, but every
  addition becomes a core change, which ADR 0328 and the Rivals move were meant
  to stop.

## Consequences

- People can add tools, routes and settings to their own Clankie without
  forking him, from a folder or a pinned repository, and see what each one asks
  for before it runs.
- The built-in and outside extensions share one contract; outside ones get a
  narrower port set. Clankie's own extensions are not forced onto it.
- `@clankie/extension` becomes a public API with compatibility promises; changes
  to `OutsidePorts` then need a version bump and a deprecation window.
- A malicious extension can still do anything the owner's user can, until
  Option C. The install prompt, `clankie doctor` and the docs say this.
- A listing, if adopted, costs nothing to host and real time to review.

## Open questions for James

1. **The one decision:** should outside extensions start as owner-trusted
   in-process code (Option A: cheap, honest that it's not a sandbox), or wait
   for a real sandbox (Option C) before anyone else's code loads?
2. Should a listing exist at all, and if so, who reviews entries: James only,
   Clankie's workers with James approving, or named outside reviewers?
3. Should outside extensions be able to add app screens, or only tools, routes
   and settings? This ADR assumes the latter; app screens touch `clankie-app`.
