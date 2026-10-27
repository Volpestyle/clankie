# ADR 0217: Fleet membership gets connected tools

Status: accepted (2026-10-04 owner decision). Supersedes the fleet **tool-access**
gate in [ADR 0216](0216-projects-own-agent-roles-and-tool-policy.md), including its
membership/authority and project-tool cutover sections. Project roles, caps,
hiring, approved workspaces and tracker binding remain in force. Native mailbox
and hire identity proof remain separate. Implementation and setup are in
[worker access](../worker-access.md).

## Decision

An admitted Clankie fleet member gets every connected MCP tool whose account
verifies, through a two-tool bridge. Local socket admission in the pinned Herdr
session, a live service-owned remote relay stream, or an authenticated remote
fleet bearer is sufficient. Tool access does not require per-process project,
workspace, native-session or hire proof. A bearer proves the fleet, not a pane.

James chose “it just works” after the trust tradeoff was stated: anything running
in a linked session can write through Clankie's connected account, including a
stray program in a pane or anyone holding a valid remote fleet token. This is an
accepted boundary, not an unimplemented project restriction. Tasks still limit
which outward actions a worker is authorized to perform.

The local macOS implementation observes the unique loopback socket owner and
microsecond process births through a bounded native `libproc` census. Fresh
observations bracket the current linked pane checks; an admitted connection's
identity pin can refuse replacement but never supplies cached admission. Socket
sharing, exit, reused PIDs, unknown ownership and changed bindings refuse access.
This replaces slow `lsof` socket scans without changing the accepted fleet
boundary. The release includes the helper; source startup builds it before
serving requests. Project and private-seat checks retain their separate authority.
The owner requires full same-user kernel observation; non-owner ancestors use
cross-user `sysctl` PID, parent and birth records, including a terminal's root
`login` process. Descriptor churn restarts a complete census, with up to 32
attempts and 1–8 ms jitter inside the unchanged 200 ms per-attempt and 600 ms
total budgets. Unknown owners and owner/ancestor changes still fail closed;
no partial census or earlier admission is reused. Bounded retries may still
refuse under sustained churn; an explicit current-request admission
403 precedes dispatch, while earlier uncertain receipts remain subject to
reconciliation.

The body keeps one native helper alive on private stdin/stdout pipes. A bounded
serialized request carries a monotonic ID; each job resets all proof state and
performs the same complete fresh observations. There is no admission cache or
helper listener. Each active proof has a 1 s transport timeout; queue wait does
not consume it. A fresh helper's first reply also pays for its start, so it gets
10 s instead: macOS assesses a binary on its first exec, which under gate load
took up to 2.2 s and refused legitimate callers (VUH-2496, amended 2026-10-19).
A silent helper still times out and refuses. Cancelling a queued job removes only that job. Cancelling an
active job drains its reply and discards it before releasing that observation,
so one caller cannot kill other callers' proofs. Queue depth remains capped at
128; queued callers can abort, but waiting under a burst can exceed 1 s.
A malformed reply, active
timeout or child exit refuses pending observations; a later request may start
a fresh helper. Herdr reads use
its existing JSONL socket API directly, avoiding a CLI process per read. Shutdown
closes only the body's own helper. This removes hot-path process launches while
preserving shared-descriptor, occupant, registry and binding revocation checks.
Refusals log fixed reason/stage/errno vocabulary without PIDs, paths or argv.

Foreground project identity uses the same native helper for same-user executable,
exact first launcher arguments and microsecond process births. It reads the shell
and native process together at both checkpoints, then binds their lifetimes to
the socket's kernel ancestry. This replaces the repeated foreground `ps`/`lsof`
spawns without caching an admission result. The two project observations enclose
both socket censuses; socket censuses enclose the private-registry checks. Keeping
each census clear of our own short-lived proof children avoids causing process-list
churn during that census. This remains a pair of observations, not an atomic
kernel snapshot. Restored private-seat checks still
observe the current occupant on each request; roster reads and provider write
checks retain their independent revocation fences. Existing generic hire receipts
with second-resolution display timestamps do not match the new kernel lifetime
format: they fail closed until a fresh hire records the full birth. No legacy
timestamp conversion grants an old receipt authority.

Private Codex launch registrations also compare fresh native births. New launch
records retain microseconds. Existing server-owned private records keep their
previous second-resolution comparison by formatting the observed kernel birth
identically; this does not promote them to a precise birth or create a new
registration. Actual socket ownership still uses the full birth and socket pin,
and restored records still require the matching live native occupant on every
check. These private launch records are distinct from generic hire receipts.

Fleet discovery lists exactly `clankie_tools` and `clankie_call`.
`clankie_tools` searches up to 20 qualified names/descriptions or retrieves up to
10 selected input schemas. It never dumps every server's catalog. `clankie_call`
dispatches a qualified tool through the existing rule matcher, argument restrictions
and account-bound MCP host. Linear worker-publishing tools requiring an exact
`personaId` remain excluded. Existing manual grants keep direct listing and
all their expiry, argument, revocation and account restrictions.

The owner setting `fleet.tools: connected | off` defaults to `connected`; the
CLI and TUI expose it. `off` removes fleet tools and refuses stale displayed
calls while manual grants keep working. Removing a connection invalidates that
fleet's admission. Calls recheck the account, setting and live admission immediately
before effects; the host retains its final account/configuration fence.

Turning the switch off, or losing admission, refuses every call whose final
pre-dispatch checks run after the change. After its own credential and connection
awaits, the host runs the fleet fence (admission, then the switch) and then its
configuration check. A call whose last asynchronous check has already read the old
state can still reach the provider after the change; this is not a cancellation,
and there is no proven bound on how many concurrent calls can be in that position.
That is the contract: the switch stops new calls, and calls already past their
checks may finish (decided 2026-10-04 on VUH-1585, the owner delegating the choice).
A hard stop would need a final check that does not await, such as an in-memory
switch kept by a settings watcher plus synchronous admission; it can be added if a
need appears.

Standing records are synthesized in memory from the current verified catalog,
not loaded from durable grant files. Audit principals include `fleet:ID:pane:PANE`,
with `pane:unverified` for bearer links. Codex hire discovery expects the two meta
names while on, or none while off, independent of project grants. The native
worker plugin contributes `message_clankie` separately.

```mermaid
flowchart LR
  L[Local admitted pane] --> F[Fleet authority]
  R[Live remote relay stream] --> F
  B[Remote bearer fleet link] --> F
  F --> K{fleet.tools connected?}
  K -->|No| N[No fleet tools]
  K -->|Yes| M[clankie_tools and clankie_call]
  M --> A[Verified accounts and worker-safe catalog]
  A --> C[Argument checks, live admission, account and setting fences]
  C --> H[MCP host dispatch with fleet and pane audit]
```

## Consequences

Project approvals and grants no longer constrain fleet provider access. Legacy
project/fleet grant records remain inspectable and explicitly revocable, without
being migrated or copied into standing authority. Project membership diagnostics
must distinguish eligibility for project policy from tools; unsupported native
proof does not mean a connected fleet pane has no tools.

This meets the tool-access objective previously assigned to VUH-1558 and VUH-1578.
Their other native delivery, membership, project or live verification scope remains
in their issue records. Fixtures establish deterministic bridge behavior; the
lead owns landing, re-pin and live PC native acceptance.

## Amendment: the exact Clankie Claude launcher (2026-10-09)

VUH-1922 found that `clankie claude` remains the pane's foreground process group
leader while the real Claude executable is its direct child. Treating that Node
launcher as Claude produced repeated `launcher_mismatch` refusals on healthy
operator requests. Generic wrapper admission remains forbidden.

For this one launch route, project proof verifies the service's installed Node
executable and canonical Clankie script, the kernel-observed `claude` subcommand,
and the shell → wrapper → Claude direct-parent chain in the same foreground
group. It brackets all three process lifetimes, executables and retained argv.
Claude must match the installed harness or its already-supported adjacent
release. The proof names Claude as the agent, preserving the socket ancestry
check; metadata supplies candidate hints only. A mismatched command, generic
wrapper, non-child, ambiguous candidate or changed observation still refuses.

Retryable process/FD census observations remain diagnostic counters, never
terminal refusal counts on their own. Failures after retries remain loud; no
load, caller or startup exemptions are introduced.

## Amendment: local fleet proof once per connection (2026-10-17)

The owner asked for fleet proof once per connection instead of once per request
([VUH-2389](https://linear.app/vuhlp/issue/VUH-2389)). On 2026-10-17 the live
service ran 126,589 proofs in under two and a half hours, about 14 a second,
against 110 worker reports. Each proof is two whole-machine descriptor censuses,
and the helper used about half a core. Most of them repeated an earlier proof on
the same pane: idle bridges polled every five seconds, and Node's five-second
server keep-alive gave each poll a new connection.

A successful local fleet proof is now bound to its connection. It records the
kernel owner, the lineage from the owner up to the pane shell (the whole chain
for a private seat) with each process's kernel birth, the pane claim, the shell
and the Herdr binding. A later request on the same live socket reuses it after
fresh rechecks of all of these: PID-local birth observations, a Herdr pane read,
the binding, the private-seat registry and any server-owned owner pin. A failed
or unavailable recheck discards the connection's proof and runs the full fresh
proof, with its refusals and metrics. The local listener keeps idle connections
for ten minutes so that Node `fetch` clients reuse them. This supersedes "never
supplies cached admission" and "no admission cache" above, for local fleet
admission only. Project proofs, private-seat registrations and remote links are
unchanged, and there is still no header PID or bearer fallback.

The accepted cost: a descriptor the proven owner hands to another process after
the proof is not observed until that connection is proven again, on a new
connection or after a failed recheck. Before, each request's census refused it.
The owner is already a member, so this equals that member proxying for another
process, which the boundary above already accepts. A full proof that sees a
second holder still refuses. The rechecks, the residual and the test evidence
are in the [native helper README](../../integrations/fleet-proof/README.md#proof-once-per-connection).

## Amendment: role tool profiles and per-actor budgets on Clankie's trackers (2026-10-27)

LOCAL-VUH-45 (Clankie Work Sync 6, in the built-in tracker)
narrows the "every connected tool" grant for the tracker vocabulary only. Other
connected accounts, and Linear-native tools outside that vocabulary, are unchanged.

**Role.** The host resolves a tracker role for every call, never from arguments.
Clankie's own calls are the **lead**, and the owner's route is the **owner**. Neither
is limited. A delegated fleet principal is a **reviewer** when its confirmed hire
holds its project's review seat or role (ADR 0287), or was hired as `reviewer`.
Any other principal is a **worker**, including an unconfirmed hire, an unverified
pane and a `project:` grant. The hire ledger and owner settings decide the role,
as in [ADR 0216](0216-projects-own-agent-roles-and-tool-policy.md).

**Profile.** Workers and reviewers keep everything hired seats wrote in the live
audit log on 2026-10-27: comments, issue events, issue creation and updates,
evidence bundles and checks, leases and runs. They also keep every read,
`list_changes`, project status updates, labels and guided reviews. They do not
see or call `post_run_control`, `save_issue_status`, `save_project`,
`post_retire_guided_review` or the inbox tools. In `save_issue`, `cycle` and a
completed-category `state` are refused. In `post_issue_event`, `stage:
owner-verified` is refused. The catalog drops those tools and arguments: on a
built-in-only service, the tracker schemas a worker can read fall from 61 tools
to 53, about 16.7k to 13.7k tokens (legacy Claude tokenizer, an estimate). Hidden
verbs stay callable by name, so the host can refuse them with `role_not_allowed`
and the caller's `role`. The store's own owner/lead checks are unchanged and
still back this up.

**Budget.** Each worker or reviewer principal has an interactive and a
background class (`clankie_call` `background: true`), each with 600 requests an
hour and 60 writes a minute. Owner and lead calls are not counted. A refusal is
`tracker_request_budget` with `retryAt`, like `linear_request_budget`, plus
`retryAfterMs`. Refused calls are not counted. The budget covers built-in and
repository-convention tracker calls; Linear HTTP keeps its own account budget.
These defaults are well above the observed fleet-wide peaks of 111 events an
hour and 17 creates in 45 seconds. A `list_changes` long poll (`waitMs` up to
20 s) costs at most 180 requests an hour plus one per commit it returns.

**Recording.** A refusal writes nothing to the tracker. A store write for each
refusal would let a runaway loop amplify the lock contention that budgets exist
to prevent. The host instead logs `tracker.policy.refused` with the reason,
role, tool and principal, and counts refusals per actor for the request window.
`GET /v1/tracker/request-budget` serves the budgets and those counts, and
`clankie doctor` and `clankie work status` show them.

```mermaid
flowchart LR
  C[clankie_call from a hired seat] --> R{Host role from hire and project review policy}
  R -->|lead or owner| B[Tracker backend]
  R -->|worker or reviewer| P{Verb in role profile?}
  P -->|no| X[role_not_allowed: nothing written, logged and counted]
  P -->|yes| U{Class budget left?}
  U -->|no| Y[tracker_request_budget with retryAt]
  U -->|yes| B
```

Separating the owner's route from Clankie's (LOCAL-VUH-4) stays outside this
amendment. Today a hire that uses the operator credential through `clankie work`
still writes as Clankie for the owner.
