# Remote KH2 native head repairs — VUH-1927 / VUH-1955

The deployed `e979eaaa` launch reached `dispatched`, but the native head in
`pc/wM:p1` could not work. This repair addresses the four findings in
[VUH-1927](https://linear.app/vuhlp/issue/VUH-1927) and the missing runtime artifact
in [VUH-1955](https://linear.app/vuhlp/issue/VUH-1955).

## Causes and changes

- The development-channel flag explicitly presents an interactive confirmation.
  Launch now uses an installed lead plugin and its approved `--channels` entry.
  It never types an answer into the native pane.
- An `@inline` plugin was loaded for hooks but did not have the installed record
  required by Claude's channel registration. Native setup installs the dedicated
  `clankie-remote-leads` marketplace in the selected profile. Cache versions derive
  from the complete projected artifact. The lead plugin stays disabled outside
  the launched session.
- The standalone esbuild artifact crashed before reaching either SessionStart
  hook: `TypeError: Class2 is not a constructor` at `bridge.mjs:11219`, in
  `z.custom` during SDK schema initialization. This reproduced on the Mac with
  the original build script. Importing the shared Zod entry first initializes
  the wrapped schemas before the SDK. The resulting bundle reaches its binding
  validation and serves prompt, transcript and MCP routes. Session settings also
  disable the inherited worker/operator plugins, removing the worker-hook hint.
- The native executable inherited the logged-out default `.claude` profile.
  Read-only PC `auth status` reported that default logged out, and the existing
  `.claude-james` profile signed in to Claude.ai Max. Launch now selects an existing
  signed-in profile, carries that exact path through the private handoff, and
  refuses missing or ambiguous sign-in. It creates no profile or credential copy.
- Runtime source updates installed dependencies without building the bridge.
  They now build it in the staged checkout before stopping the old service.
  Missing artifacts return a 503 naming the build command, surfaced by the CLI.

Setup preserves other channel entries and permission fields, and refuses an
explicitly disabled policy. If the SSH account cannot write the Windows managed
policy, the journal names the administrator action James needs. No credentials,
PC files or existing PC panes were changed during this investigation.

## Verification

The focused run passed 23 cases across the remote lead HTTP/MCP contract,
real Windows launch/ConversationStore integration and runtime transaction files.
The added acceptance case exercises real files, private TCP handoff, actual Node
bundle, stdio MCP and HTTP routes. Both hooks exit successfully and the bundled
bridge answers `worker_reports`. Native Claude authentication/executable and
host identity are fixtures; this is local integration proof, not a live head.
The runtime transaction case executes a build process and verifies the artifact
survives staging/activation before shutdown. Existing authority, revocation and
local-captain-fallback coverage stays intact. Service typecheck passes.

Final root gate, checked base/HEAD, native plugin-manager receipt and landing SHA
are recorded in the issue evidence comment. Raw reports are retained under
`.local/vuh-1927d/` in the worker checkout; archived receipts are linked there.

## Remaining live acceptance

Deployment and a fresh live launch belong to the lead. `dispatched` remains a
handoff receipt, not readiness. Acceptance requires the deployed PC head to
answer a tool call, with its lead channel active and no hook crash. Existing KH2
lead `pc/w9:p2` was not inspected, typed into or changed. A new sign-in was not
needed according to the read-only status sample; actual token refresh and model
inference remain untested until that live launch.
