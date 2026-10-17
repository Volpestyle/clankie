# Clankie v0.4.6

This replaces the unpublished v0.4.5 release. Its macOS release checks timed
out twice. The release fixtures now cancel expired work and use controlled
pressure readings, keeping production resource limits unchanged.
[VUH-2346](https://linear.app/vuhlp/issue/VUH-2346)

Clankie keeps a clearer account of what his fleet accomplishes, follows each
project's work rules, and recovers more reliably when machines, workers or
accounts stop answering.

## Work with a clearer purpose

- **Project work rules that hold.** Projects can cap work in progress, choose
  when Clankie reports, and constrain worker plans and models. Explicit model
  pins apply to hires, and each new work hire records why its effort fits the
  job. Existing manual hires and saved owner choices survive the upgrade.
  [VUH-2256](https://linear.app/vuhlp/issue/VUH-2256)
- **Auto measures outcomes.** Auto rounds record project progress, tracker
  outcomes and repository activity, flag drift, and retain corrections for
  later verification. `clankie auto rounds` reads the record; historical replay
  measures past progress without waking workers. Remote-only projects can use
  their origin's history too.
  [VUH-2283](https://linear.app/vuhlp/issue/VUH-2283),
  [VUH-2284](https://linear.app/vuhlp/issue/VUH-2284),
  [VUH-2285](https://linear.app/vuhlp/issue/VUH-2285),
  [VUH-2287](https://linear.app/vuhlp/issue/VUH-2287)
- **Spare capacity gets noticed.** Auto flags ready work that has room for more
  workers, or a backlog that needs planning before it is ready. The next round
  checks what changed, using the project’s worker caps, work in progress and
  account headroom.
  [VUH-2335](https://linear.app/vuhlp/issue/VUH-2335)
- **Fewer routine interruptions.** Idle leads collect routine worker reports
  into a round. Milestone reporting asks for one useful status update and
  flags routine posts. Usage-limited lead seats can move to an account with
  more headroom and return later.
  [VUH-2274](https://linear.app/vuhlp/issue/VUH-2274),
  [VUH-2286](https://linear.app/vuhlp/issue/VUH-2286),
  [VUH-2273](https://linear.app/vuhlp/issue/VUH-2273)
- **A shared fleet room.** An owner-only, durable conversation keeps the
  fleet's coordination record together.
  [VUH-2184](https://linear.app/vuhlp/issue/VUH-2184)
- **Projects reach the right lead and tracker.** Auto follows configured
  ownership and connected Linear bindings. Remote leads' tracker tools stay
  inside their assigned project, including issue reads.
  [VUH-2029](https://linear.app/vuhlp/issue/VUH-2029),
  [VUH-1968](https://linear.app/vuhlp/issue/VUH-1968)

## A steadier fleet across machines

- **Joined machines reconnect.** A joined machine reconnects after its home
  restarts, can open Claude seats in home conversations, and offers Clankie an
  audited shell within its access level.
  [VUH-1800](https://linear.app/vuhlp/issue/VUH-1800),
  [VUH-2128](https://linear.app/vuhlp/issue/VUH-2128),
  [VUH-2319](https://linear.app/vuhlp/issue/VUH-2319)
- **Workers recover without duplicate work.** Uncertain hires are reconciled
  against native inventory. Reports retry temporary remote proof failures;
  unresolved deliveries remain visible. Windows Codex backends are rediscovered
  after restarts, and refused closes preserve the worker's state.
  [VUH-2243](https://linear.app/vuhlp/issue/VUH-2243),
  [VUH-2208](https://linear.app/vuhlp/issue/VUH-2208),
  [VUH-2200](https://linear.app/vuhlp/issue/VUH-2200),
  [VUH-2311](https://linear.app/vuhlp/issue/VUH-2311)
- **Remote leads regain contact.** Temporary startup failures can be retried,
  and early orphan panes remain visible for recovery. A message whose arrival
  is unknown can be settled without resending it, so it does not block every
  later message to that worker.
  [VUH-2075](https://linear.app/vuhlp/issue/VUH-2075),
  [VUH-2358](https://linear.app/vuhlp/issue/VUH-2358)
- **Worker resource use stays with the worker.** Hired workers and operator
  sessions keep distinct resource identities, including on dedicated Codex
  servers.
  [VUH-2336](https://linear.app/vuhlp/issue/VUH-2336)
- **An OpenCode turn can fail without losing the worker.** Slow context reads
  and model errors fail the affected turn while keeping the seat available.
  [VUH-2348](https://linear.app/vuhlp/issue/VUH-2348)
- **The right signed-in account.** Harness accounts are discovered by identity,
  and Claude hires use the credential that admission checked. Recovered usage
  refreshes staffing capacity and is announced to the lead.
  [VUH-2145](https://linear.app/vuhlp/issue/VUH-2145),
  [VUH-2241](https://linear.app/vuhlp/issue/VUH-2241),
  [VUH-2310](https://linear.app/vuhlp/issue/VUH-2310)
- **More responsive under load.** Roster reads return a marked partial view
  instead of waiting indefinitely. Cached proofs and narrower report reads
  reduce repeated work. Integration gates share build slots, low disk space
  holds new heavy jobs, and finished worktrees and private caches can be
  reclaimed safely.
  [VUH-2216](https://linear.app/vuhlp/issue/VUH-2216),
  [VUH-2291](https://linear.app/vuhlp/issue/VUH-2291),
  [VUH-2132](https://linear.app/vuhlp/issue/VUH-2132),
  [VUH-2209](https://linear.app/vuhlp/issue/VUH-2209)

## Easier setup, evidence and everyday use

- **Choose his Clankie mailbox in one step.** Self-hosted installs signed in
  to a Clankie account can choose his mailbox from connected surfaces. The
  service confirms his address before switching; a failed connection leaves
  the current mailbox in charge and keeps stored IMAP settings for a return.
  [VUH-1764](https://linear.app/vuhlp/issue/VUH-1764)
- **Clearer Discord setup and recovery.** Paired devices can read official-bot
  setup status through the service. Pending disconnects survive interrupted
  replies and can be retried explicitly; unavailable setup explains its cause.
  [VUH-1766](https://linear.app/vuhlp/issue/VUH-1766)
- **Sharing recognizes recorded media.** MP4, WAV and MP3 files delivered in
  a conversation, including native Discord room artifacts, can be selected as
  Activity sources. Switching sources keeps an active share marked busy until
  it succeeds or fails. These paths have fixture coverage; live app setup and
  Discord acceptance remain pending.
  [VUH-1481](https://linear.app/vuhlp/issue/VUH-1481)
- **A better Mac handoff.** The installer starts the local service before
  handing off to the companion app. Custom install roots skip live harness
  linking. The companion app still has its own artifact and release gate.
  [VUH-1728](https://linear.app/vuhlp/issue/VUH-1728),
  [VUH-1730](https://linear.app/vuhlp/issue/VUH-1730)
- **Clearer model choices.** The console and CLI explain model names, funding
  and availability. Model selection follows the same eligibility rules through
  both current and older APIs; saved preferences remain readable.
  [VUH-2108](https://linear.app/vuhlp/issue/VUH-2108),
  [VUH-2110](https://linear.app/vuhlp/issue/VUH-2110)
- **Evidence storage controls.** Choose evidence storage through the CLI and
  console. Recorded evidence keeps its original destination when settings
  change. S3 support is a partial foundation; this release does not claim a
  complete managed storage service. Large recorded PNGs get bounded thumbnail
  previews for paired devices.
  [VUH-1913](https://linear.app/vuhlp/issue/VUH-1913),
  [VUH-1954](https://linear.app/vuhlp/issue/VUH-1954)
- **Questions in the console.** Answer owner asks from the mailbox modal;
  leads can cancel questions that later work has overtaken. Safe defaults and
  deadlines persist.
  [VUH-2150](https://linear.app/vuhlp/issue/VUH-2150),
  [VUH-2136](https://linear.app/vuhlp/issue/VUH-2136),
  [VUH-2256](https://linear.app/vuhlp/issue/VUH-2256)
- **Safer live views and browsing.** Live views use registered tracker IDs
  and cannot turn displayed text into terminal commands. Each conversation's
  browser has its own workspace. Hosted browser access is bound to the account
  session, and owner-device revocation is enforced.
  [VUH-2035](https://linear.app/vuhlp/issue/VUH-2035),
  [VUH-2129](https://linear.app/vuhlp/issue/VUH-2129),
  [VUH-2122](https://linear.app/vuhlp/issue/VUH-2122),
  [VUH-2215](https://linear.app/vuhlp/issue/VUH-2215)
- **Reliable updates and replies.** Scheduled installs wait for idle cutover.
  A healthy update can pass its canary under machine load; an unhealthy one
  cannot wait forever. Discord room turns expose refusal causes and recover
  unanswered deliveries once.
  [VUH-1756](https://linear.app/vuhlp/issue/VUH-1756),
  [VUH-2216](https://linear.app/vuhlp/issue/VUH-2216),
  [VUH-2142](https://linear.app/vuhlp/issue/VUH-2142)
- **Separate pet appearance.** The desktop pet has its own skin setting,
  independent of the lead's appearance.
  [VUH-2201](https://linear.app/vuhlp/issue/VUH-2201)

## Changes to settings and setup

Self-hosted browser clients need their exact origin in the service’s allowed
list before pairing: `clankie http allow-origins https://app.example.test`.
The default list is empty; wildcards are refused. Core and relay apply the same
list without a restart.
[VUH-2349](https://linear.app/vuhlp/issue/VUH-2349)

Fleet size, fleet model mode, verification mode, reporting style and fleet-wide
hire effort are retired controls. Saved values remain readable as migration
receipts; edits are rejected. Use numeric worker caps, project hiring rules,
per-job effort and owner reporting cadence instead. New Claude and Codex work
hires require recent usage information and preserve a 10% reserve. An owner can
explicitly override the reserve for a known usable account from the app; account
holds, exclusions and exhausted plans still apply.
[VUH-2256](https://linear.app/vuhlp/issue/VUH-2256)

This release provides Apple silicon macOS, Linux arm64 and Linux x64 service
archives. The companion app and hosted service have separate releases; hosted
features depend on the hosted service and your account. Hosted bodies install
official releases automatically while idle.
