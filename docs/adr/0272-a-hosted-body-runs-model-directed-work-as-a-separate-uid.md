# ADR 0272: A hosted body runs model-directed work as a separate uid

Status: Proposed (VUH-2320, 2026-10-16). Not a boundary until increment 2 lands
and the launcher opts in (increment 3). Until then a hosted body keeps today's
single-uid model.

## Context

A hosted body is one container per owner. Everything in it runs as `node`:
the service, its state on `/state`, its credentials (`/state/credentials.json`),
the release it runs and updates (`/state/install`), and everything a model
directs. That last group covers the captain's coding tools, Herdr and every
worker pane, the Codex app-server, and harness sign-ins.
Model output is untrusted (Discord, web pages, repositories), so a
prompt-injected tool call can do anything the service can:

- rewrite the support grant record the host's shell watcher trusts
  (the VUH-1367 residual: a rewrite loop holds a revoked shell open
  while fleet sync is down);
- read the credential broker file and every bearer;
- edit the release root, so the next service start runs its code;
- rewrite the event log, device registry, settings and telemetry spool.

The container already drops every capability and runs with no published port,
so the tenant boundary (VUH-1068) holds. What is missing is a boundary inside
the tenant, between the service and the work it directs.

## Decision

Model-directed execution runs as a second unprivileged uid, `clankie-agent`.
The service keeps `node`, owns `/state`, and never executes content the agent
can write.

### Mechanism

A launcher opts in by starting the container as root:

```sh
docker run --user 0:0 --cap-drop ALL \
  --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETPCAP \
  --cap-add SETUID --cap-add SETGID \
  --security-opt no-new-privileges ...
```

- **Root, at startup only:** the image's root entrypoint (`clankie-separate`) refuses to run without `NoNewPrivs`.
  - It makes `/state` service-only, except a traversable release and the agent's own home `/state/agent`.
  - It gives `/workspace` a shared `clankie-workspace` group.
  - It then drops to `node` through `setpriv`, keeping only SETUID and SETGID, as ambient capabilities and as the whole bounding set.
- **The service** uses those two capabilities for one thing: starting agent work through `setpriv --reuid=clankie-agent ... --inh-caps=-all --ambient-caps=-all`.
- **An agent process** holds no capabilities, cannot switch back, and cannot ptrace or signal the service.
- **Setuid binaries:** the image strips every setuid/setgid bit, and `no-new-privileges` blocks any that remain.

Proven in `node:24.20.0-bookworm-slim` on 2026-10-16:

- the agent child is uid 1001;
- its CapPrm, CapEff and CapAmb are all 0;
- `setpriv --reuid=node` fails.

Started as today (`node`, `--cap-drop ALL`), the image behaves exactly as now
and no agent uid is configured.

### Threat model after the change

The adversary is model-directed code running as `clankie-agent`.

It **cannot**:

- write anything under `/state`: the event log, credentials, settings, the grant record, the telemetry spool or the release root;
- read the service's state or credentials;
- change the code the service runs;
- regain capabilities, or ptrace or signal service processes;
- read service processes' `environ` or `fd` entries;
- get code run as `node`, because the service never executes workspace content.

It **can still**:

- read and write `/workspace`;
- run any program as itself;
- use the network as the container can;
- fill the shared volume or exhaust CPU and memory (the container's limits still apply);
- reach the service's loopback API (unauthenticated routes only, plus whatever the worker credentials it is given allow);
- lie to the service through Herdr output and worker reports, which are already untrusted.

The service uid still runs the captain's own reasoning and the tools it authors.
Those are an authority question (what a prompt-injected captain may ask the
service to do), not a uid question, and stay governed by the existing trust rules.

### Seams that cross the uid

Each must run as the agent, or accept the agent explicitly, before the boundary is real.

| Seam                                                                                                                                                                         | Today                                                                                | Needs                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Captain native tools (`captain/machine-coding-tools.ts`): read/write/edit/ls/find run in-process; bash/powershell/grep spawn                                                 | service uid                                                                          | an agent-uid tool host; the service proxies each call (increment 1)                                                                                                                        |
| Herdr supervisor and server (`herdr-runtime.ts`), so every pane and worker                                                                                                   | service uid                                                                          | runs as agent. **Herdr forces its sockets to 0600**, so the service reaches it through a group-accessible relay run by the agent-side supervisor, or runs its Herdr CLI calls as the agent |
| Service-side Herdr calls: `captain/herdr-watch.ts`, `herdr-terminal.ts`, `herdr-terminal-control.ts`, `herdr-native-request.ts` socket requests, census/fleet modules        | direct socket or CLI                                                                 | go through the relay or agent-side execution                                                                                                                                               |
| Native identity proofs: `local-fleet-process.ts` with `libexec/local-fleet-proof` (socket owner, births, ancestry); `fleet-harness-processes.ts`, `project-process-proof.ts` | require `uid === process.getuid()`; read `/proc/<pid>/fd`, which does not cross uids | an explicit agent-uid allowance, with the observation performed agent-side where `/proc` access is needed                                                                                  |
| Codex `app-server` (`captain/codex-app-server.ts`), its socket directory check (`stat.uid === getuid`)                                                                       | service uid                                                                          | agent uid; the socket directory owned by the agent                                                                                                                                         |
| Harness sign-ins (`harness-logins.ts`, `captain/harness-accounts.ts`); the Claude worker setup (`hosted-claude-worker.sh`)                                                   | write `/state/home/.claude*`, `.codex`                                               | run as agent; credentials in `/state/agent`, migrated once from `/state/home`                                                                                                              |
| Heavy job store (`fleet-resources/native.py`, `linux-namespace.py`)                                                                                                          | same-uid ownership and modes                                                         | agent work uses its own registry under its home; service and agent pools are separate on a hosted body                                                                                     |
| Service git/`gh` in the workspace (`integrate.ts`, `work-items.ts`)                                                                                                          | service uid                                                                          | runs as agent. Running as `node` in an agent-owned repo would execute agent-controlled `.git/config` (`core.fsmonitor`); git's `safe.directory` refusal is the fail-closed fallback        |
| Pane and tool environment                                                                                                                                                    | inherits the service's                                                               | the agent's own HOME and XDG roots, with service-only and secret variables removed (`agentEnvironment`)                                                                                    |
| Release root readability                                                                                                                                                     | 0700 under `umask 077`                                                               | traversable for the agent; setgid shared group so self-installed releases stay readable; never agent-writable                                                                              |
| Owner-configured stdio MCP servers, routine checks                                                                                                                           | service uid                                                                          | stay service uid: owner-authored, not model output (revisit if a model can author them)                                                                                                    |
| `docker exec`                                                                                                                                                                | defaults to the image user                                                           | defaults to root under `--user 0:0`; ops scripts must pass `--user node`                                                                                                                   |

### Increments

1. **Boundary and captain tools:** the image user and groups, setuid stripping, the root entrypoint, the agent-uid tool host, and an image E2E with a scripted model.
   - It ships behind the launcher flag and is labelled "not a boundary yet". While workers stay `node` in a shared `/workspace`, the agent can plant code a worker later runs.
   - It is not landed on its own unless that label is explicit in docs and doctor.
2. **Herdr and workers as the agent:** every row above except the owner-authored ones, and an image E2E with a real Herdr pane and worker under a scripted model. **The boundary becomes real here**, inside a container launched with the flags.
3. **Flip:** clankie-ops `run-body` adopts the flags above.
   - The watcher fixture and docs drop the VUH-1367 residual.
   - Ops scripts that `docker exec` pass `--user node`.
   - This is owner/lead work in the private repo.

## Consequences

- A prompt-injected tool can no longer tamper with the service's state, credentials or code on a separated body.
- The support grant record becomes trustworthy against model-directed writes.
- Startup gains a root phase with four extra capabilities that the service never holds. That code is small, ships in the image, and refuses to run without `no-new-privileges`.
- A hosted body has two heavy-job registries.
- Repositories the agent creates are refused by service-uid git. That is deliberate.
- macOS and self-hosted Linux installs are unchanged.
