# Machine access

A device is where the owner talks to Clankie. A machine is where he acts.
Use `clankie machines --json` to read each machine's `accessLevel` and
`accessEnforcement`. Owners choose one cumulative level:

| Level   | Available work                                                     |
| ------- | ------------------------------------------------------------------ |
| portal  | Talk to Clankie; no native worker, general shell or screen effects |
| workers | Hire and control native workers within their approved workspaces   |
| shell   | General shell and filesystem tools, plus workers                   |
| screen  | Desktop capture/input, plus shell and workers                      |

Set a level through the authenticated owner API with
`clankie machines access NAME portal|workers|shell|screen`, or through
Settings → Machines / `/machines`. Existing local installs default to screen;
new or ungranted remote machines default to portal. Never infer a machine
level from its name, an SSH connection, a Discord owner or a room skill grant.
Machine permission and who may ask are independent checks. A bounded service
adapter doing its own I/O is not a grant of the caller's general shell.

The API is `PATCH /v1/machines/:id/access` with `{ "accessLevel": "workers" }`.
The paired-device command is `set_machine_access` with `id` and `accessLevel`.
Workers and joined clients cannot raise their own level. Unknown machines,
invalid levels and unavailable policy refuse. Native coding tools recheck
policy on each call, owner-pane polls require shell before and after waits,
worker launches recheck after waits, and screen input
rechecks before each effect. Recovery remains available after revocation.
Lowering a level does not terminate existing workers or undo completed work.

Current enforcement is reported as `service-preference`: the service checks
its own tools but runs under the owner's account. Do not call this an OS
sandbox or authenticated joined-host enforcement. Joined transport and
receiver proof are VUH-1800; local OS isolation is VUH-1804. A joined receiver
must check its own owner-approved level and directory grants before executing
worker, shell or screen requests, regardless of what the sender claims.
