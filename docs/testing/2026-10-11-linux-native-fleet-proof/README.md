# VUH-2118 Linux native fleet proof

Tracks: https://linear.app/vuhlp/issue/VUH-2118

[Raw results and retained failures](clankie://evidence/sha256/2a4ba7c4c17297da6cc57dcabebdb0e982433b69fd95430a2e76162ba047dcf7).

V1 supports only a kernel-proven **initial PID namespace**. Containers using a
private PID namespace refuse with `unsupported_pid_namespace`. The trusted
hosted-container receipt is a separate open follow-up, VUH-2120; no bearer, PID
header or account route replaces native proof. Darwin's C helper is unchanged.
The per-guarantee Darwin/Linux mapping is in
[the helper guide](../../../integrations/fleet-proof/README.md#linux-host-boundary).

## Real proof environment

The positive producer ran inside owned, removed-on-exit Docker containers using
`--init --pid=host`: the **initial PID namespace of Docker's Linux VM**, not a
private container PID namespace. Kernel `6.12.76-linuxkit`; Ubuntu 24.04 arm64 and
emulated x64; unprivileged UID/GID 65534; no network; two CPUs, 2 GiB memory,
256-PID ceiling. Procfs masks and seccomp were disabled for these owned producers;
no privileged container, host account changes, PC/WSL calls or existing jobs
were involved. Sources were mounted read-only and the existing images unchanged.
The negative producer omitted `--pid=host` and refused clearly.

Images: `clankie-vuh1823-build:{arm64,x64}`. Native Pi 0.87.1 was installed into
owned `.local/pi-{arm64,x64}` prefixes through governed containers using each
image's Linux Node/npm. No model turns, provider sign-ins, owner credentials or
evals were performed. The native Pi TUI runs in a fresh isolated real Herdr
namespace, with the actual installed Herdr Pi integration and production worker
MCP consumer/stdio bridge.

## Inspected results

- Manual Docker contract suite: both architectures' real kernel socket/birth/
  ancestry/FD boundaries, both native Pi TUI tools+reports, private-namespace
  refusal and the real native Codex listener passed (six of six cases). Each kernel suite ran 12 cases: 11 passed, one root-only case
  skipped. That case separately passed with an owned root producer and readable
  foreign-user FD tables.
- Each real Pi TUI discovered `proof_read`, called the real HTTP MCP provider,
  read its owned file and stored one durable report through `message_clankie`.
  Herdr supplied its actual session binding. A same-user outsider forging the
  pane header was refused with HTTP403 and no effect; revoked binding also
  refused with HTTP403.
- Actual native Codex 0.160.1 passed kernel birth and canonical Unix-listener
  ownership; changed PID, endpoint, canonical path and exited process refused.
  Its owned producer used `clankie-runtime:ac45d633e5ed`, no network, 512 MiB
  memory and 128 PIDs. The requested socket path resolves to a daemon socket;
  the fixture uses the same canonical-path contract as production.
- Tests schedule real owned process births to force complete-census retries and
  continuous churn to prove bounded refusal. No kernel records or successful
  proof replies are fabricated. Per-request receipts record census attempts and
  fixed refusal reasons. Shared descriptors, permissions, birth changes, ancestry,
  cookies and namespace checks remain terminal, outside the churn-only retry.
- Portable focused checks: 89 passed, two Linux opt-ins skipped. Native reason
  vocabulary is checked against both production helpers. Full app source/test
  typecheck passed before the added journey; a focused typecheck covering the
  new journey and Docker tests also passed. Scoped formatting/lint passed.
- A fresh native adversarial reviewer found no remaining concrete same-user
  spoofing or lifetime blocker. Reviewed helper SHA256:
  `488082566f3c1d8c8247da531e1e032d905f9eb0345544f31923250fc546218d`;
  review bundle `24750ea7eddf727456684703d74cd34bbea4d0c4b3742c37172e8b0d12e25ebb`.

Earlier failing runs are retained, including namespace-design failures, real
census churn, telemetry incorrectly entering snapshot equality, native fixture
setup mistakes and type errors. They are not passing evidence. The final
complete scan never substitutes a partial result when its deadline expires.

## Reproduce

Prepare each owned Pi prefix with the matching recorded image (use
`--platform linux/amd64` and `x64` for the emulated run):

```sh
mkdir -p .local/pi-arm64
clankie heavy -- docker run --rm --init --pull never --cpus 2 \
  --memory 2048m --pids-limit 256 \
  --mount "type=bind,src=$PWD/.local/pi-arm64,dst=/proof-prefix" \
  --entrypoint /usr/local/bin/npm clankie-vuh1823-build:arm64 \
  install --prefix /proof-prefix --no-audit --no-fund \
  @earendil-works/pi-coding-agent@0.87.1
```

Then run the recorded manual producer suite:

```sh
LINUX_FLEET_DOCKER_TEST=1 clankie heavy -- pnpm exec vitest run \
  apps/clankie/test/linux-native-fleet-docker.integration.test.ts
```

This manual-only test prepares the **production release helper** inside each
owned container with `buildFleetProof`, bundles the real native journey, runs
the owned producers and tears them down. Ordinary root/CI runs skip Docker.
An initial-namespace Linux host can run the kernel-only wrapper with
`LINUX_FLEET_PROOF_TEST=1 clankie heavy -- pnpm exec vitest run
apps/clankie/test/linux-native-fleet.integration.test.ts`.
The opt-in names intentionally avoid `CLANKIE_`: the repository's test isolation
clears inherited Clankie configuration and credentials before test imports.

## Limits and open work

This is a real native TUI and production admission/MCP/report component journey,
not owner-account onboarding or a provider-backed model-turn acceptance. Owner
account and physical phone acceptance remain VUH-1823 gaps. Hosted Linux bodies
construct the same LocalFleetLink; Linux now starts its listener/discovery, but
private containers still refuse until VUH-2120 implements a trusted receipt.
Kernel observations, like Darwin, cannot atomically exclude an unobserved change
and reversal or a descriptor queued in SCM_RIGHTS. Unknown observations refuse.
The exact-tree integration gate is authoritative; no duplicate local root gate
was run. Final landing receipts are published on VUH-2118.

## Landing-gate fixture registration

**Full-gate result:** batch `94616c52-a8a9-4b25-ab04-6eff2ace46e2` failed
with exit 1 at deadcode (91.78 seconds): Knip reported the native journey and
Pi extension fixtures as unused because esbuild loads their paths dynamically.
The isolated tree `ac6e3d44-9881-49a6-976c-de103770c324` failed identically
(exit 1, 91.90 seconds); its original request is terminal. Both are now explicit `apps/clankie` fixture entries in `knip.json`, beside the
existing native fixtures. `clankie heavy -- pnpm deadcode` passed on the corrected
tree; its existing unmatched Codex skill entry hint remains. Scoped formatting
passed. Proof/runtime sources and their adversarial-review hash are unchanged.
The failed gate is retained as [failed evidence](clankie://evidence/sha256/4b774b966e88589019613bfe37fa32465ae7fe062802afb4b5ff701c631dc218).
