# Linux governor validation — manual, unrun

This procedure has **not run here**. During the VUH-1740 handoff, `docker info`
failed because `~/.docker/run/docker.sock` was missing. No Docker daemon was
started or installed. Run these commands only with an available Linux
Docker engine. They do not deploy the hosted service, run CoreSimulator, or hire
agents. The [existing evidence](README.md) distinguishes the preceding macOS
checks from this remaining Linux boundary.

Every image pull and container run holds the fleet's existing heavy permit.
The container has two CPU equivalents, 4 GiB RAM, no swap and at most 256 PIDs.
These are [Docker runtime limits](https://docs.docker.com/engine/containers/resource_constraints/),
not a service CPU or admission-latency budget. The container runs a frozen
installation, the focused native suites and a package typecheck; it does not run
the full repository check or a release build. Only a committed public Git archive
and the smoke script below are mounted, both read-only. Dependencies and caches
are created inside the new container; no host dependencies, caches, credentials,
agent directories or Docker socket enter it.

Use Bash from the review worktree after the final source and tests are committed.
`LINUX_SOURCE_REF=HEAD` captures that committed candidate; set it to the recorded
SHA when repeating a completed run. The source guard below refuses pending
governor or dependency changes. The preceding governor handoff was `6cd5c146`;
running that older archive does not verify the new targeted-observation cases.
Use the recorded image digest when repeating a completed run.

```bash
set -euo pipefail
cd /Users/james/dev/clankie-wt/bex-vuh-1740-admission-latency

FLEET_HEAVY=/Users/james/.herdr-handoffs/clankie-backlog-20261003/bin/heavy
LINUX_SOURCE_REF=HEAD
test -z "$(git status --porcelain -- packages/fleet-resources package.json pnpm-lock.yaml pnpm-workspace.yaml)"
LINUX_SOURCE_SHA="$(git rev-parse --verify "${LINUX_SOURCE_REF}^{commit}")"
LINUX_IMAGE_REF=node:24.20.0-bookworm
LINUX_PLATFORM=linux/arm64
mkdir -p .local
LINUX_VALIDATION_ROOT="$(mktemp -d "$PWD/.local/vuh1740-linux.XXXXXX")"
LINUX_RUN_ID="$(basename "$LINUX_VALIDATION_ROOT")"
mkdir "$LINUX_VALIDATION_ROOT/artifacts"

git archive --format=tar --output="$LINUX_VALIDATION_ROOT/source.tar" "$LINUX_SOURCE_SHA"
printf '%s\n' "$LINUX_SOURCE_SHA" > "$LINUX_VALIDATION_ROOT/source-sha.txt"
shasum -a 256 "$LINUX_VALIDATION_ROOT/source.tar" > "$LINUX_VALIDATION_ROOT/source-tar.sha256"
tar -tf "$LINUX_VALIDATION_ROOT/source.tar" > "$LINUX_VALIDATION_ROOT/archive-files.txt"
node - "$LINUX_VALIDATION_ROOT/archive-files.txt" <<'ARCHIVE_CHECK'
const fs = require('node:fs');
const entries = fs.readFileSync(process.argv[2], 'utf8').split('\n');
const forbidden = /(^|\/)(node_modules|\.git|\.local|\.data|\.cache|\.pnpm-store)(\/|$)|(^|\/)\.env(?:\.local)?$/;
const failures = entries.filter(path => forbidden.test(path));
if (failures.length) throw new Error(`Archive contains local state: ${failures.join(', ')}`);
ARCHIVE_CHECK

docker context show > "$LINUX_VALIDATION_ROOT/docker-context.txt"
docker info > "$LINUX_VALIDATION_ROOT/docker-info.txt" 2>&1
"$FLEET_HEAVY" docker pull --platform "$LINUX_PLATFORM" "$LINUX_IMAGE_REF" \
  > "$LINUX_VALIDATION_ROOT/image-pull.log" 2>&1
docker image inspect "$LINUX_IMAGE_REF" > "$LINUX_VALIDATION_ROOT/image-inspect.json"
LINUX_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$LINUX_IMAGE_REF")"
printf '%s\n' "$LINUX_IMAGE_ID" > "$LINUX_VALIDATION_ROOT/image-id.txt"
```

The default platform matches the ARM Mac used for the preceding evidence. A
different Linux platform is a separate recorded input. The resolved image ID,
platform, archive hash, OS package versions and frozen lockfile identify this
run. Apt repositories are fetched at execution time; the recipe is not a
hermetic OS rebuild.

Create the tiny, local smoke fixture. Its process must actually be PID 1. It
drops root privileges to the image's `node` account before probing the native
helper and real kernel pressure. The private policy uses load/core 16 and
minimum free memory 0 to isolate availability from the owner's default pressure
thresholds. It still uses the production pressure probe. PID 1 must remain an
invalid heavy requester, and no signal is sent to PID 1.

```bash
cat > "$LINUX_VALIDATION_ROOT/pid1-smoke.mjs" <<'PID1_SMOKE'
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createResourceGovernor } from '/work/packages/fleet-resources/src/governor.ts';
import { defaultResourcePolicy } from '/work/packages/fleet-resources/src/model.ts';
import { nativeBoundaryAvailable, processIdentity } from '/work/packages/fleet-resources/src/process.ts';

assert.equal(process.pid, 1, 'Node must be the actual container PID 1');
process.setgid('node');
process.setuid('node');
assert.ok(process.getuid() > 0 && process.geteuid() > 0);
const directory = await mkdtemp('/tmp/clankie-linux-pid1-');
const receipt = join(directory, 'must-not-be-created');
const governor = createResourceGovernor({ directory });
const policy = {
  ...defaultResourcePolicy(),
  heavySlots: 1,
  simulatorSlots: 0,
  maxLoadRatio: 16,
  minAvailableMemoryMb: 0,
};
try {
  await governor.configure(policy);
  assert.equal(await nativeBoundaryAvailable(), true);
  assert.equal(await processIdentity(1), undefined);
  const admission = await governor.admitBuilder();
  await assert.rejects(
    governor.runHeavy('/usr/bin/touch', [receipt]),
    /Fleet resource process identity unavailable/,
  );
  await assert.rejects(access(receipt), { code: 'ENOENT' });
  const snapshot = await governor.snapshot();
  const result = {
    schemaVersion: 1,
    sourceSha: process.env.LINUX_SOURCE_SHA,
    node: process.version,
    pid: process.pid,
    uid: process.getuid(),
    gid: process.getgid(),
    helperAvailable: true,
    pid1IdentityUnauthorized: true,
    pid1HeavyRejected: true,
    commandReceiptAbsent: true,
    admission,
    policy,
    leases: snapshot.leases.length,
    queued: snapshot.queue.length,
  };
  await writeFile('/evidence/pid1-smoke.json', `${JSON.stringify(result, null, 2)}\n`);
  assert.equal(admission.allowed, true);
  assert.equal(admission.pressure.healthy, true);
  assert.equal(result.leases, 0);
  assert.equal(result.queued, 0);
  console.log(JSON.stringify(result));
} finally {
  await governor.close();
  await rm(directory, { recursive: true, force: true });
}
PID1_SMOKE
shasum -a 256 "$LINUX_VALIDATION_ROOT/pid1-smoke.mjs" > "$LINUX_VALIDATION_ROOT/pid1-smoke.sha256"
```

Run one fresh container. `runuser` installs and checks as `node`; the final
`exec node` replaces the PID 1 shell. There is no `--init`, shared PID namespace,
privileged mode or published port. Docker's [run reference](https://docs.docker.com/reference/cli/docker/container/run/)
defines the resource and ID-receipt flags used here. Keep the container after
exit so failures can be copied out.

```bash
if "$FLEET_HEAVY" docker run --interactive \
  --name "$LINUX_RUN_ID" --cidfile "$LINUX_VALIDATION_ROOT/container.cid" \
  --label "clankie.validation=$LINUX_RUN_ID" \
  --platform "$LINUX_PLATFORM" --cpus=2 --memory=4g --memory-swap=4g --pids-limit=256 \
  --user 0:0 --workdir /work \
  --env "LINUX_SOURCE_SHA=$LINUX_SOURCE_SHA" \
  --mount "type=bind,source=$LINUX_VALIDATION_ROOT/source.tar,target=/input/source.tar,readonly" \
  --mount "type=bind,source=$LINUX_VALIDATION_ROOT/pid1-smoke.mjs,target=/input/pid1-smoke.mjs,readonly" \
  --entrypoint /bin/bash "$LINUX_IMAGE_ID" -s \
  > "$LINUX_VALIDATION_ROOT/container.log" 2>&1 <<'LINUX_RUN'
set -euo pipefail
mkdir -p /work /evidence
tar -xf /input/source.tar -C /work
apt-get update > /evidence/os-install.log 2>&1
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates git python3 procps util-linux >> /evidence/os-install.log 2>&1
corepack enable
mkdir -p /work/.local/corepack /work/.local/pnpm-store
chown -R node:node /work /evidence
node -p process.version > /evidence/node-version.txt
python3 --version > /evidence/python-version.txt
dpkg-query -W python3 procps util-linux > /evidence/os-packages.tsv
uname -a > /evidence/kernel.txt
printf '%s\n' "$LINUX_SOURCE_SHA" > /evidence/source-sha.txt
runuser -u node -- env COREPACK_HOME=/work/.local/corepack /bin/bash -c '
  set -euo pipefail
  cd /work
  corepack prepare pnpm@11.11.0 --activate > /evidence/corepack.log 2>&1
  pnpm --version > /evidence/pnpm-version.txt
  pnpm install --frozen-lockfile --store-dir /work/.local/pnpm-store > /evidence/frozen-install.log 2>&1
  pnpm exec vitest run --config vitest.config.ts \
    packages/fleet-resources/test/heavy-process.integration.test.ts \
    packages/fleet-resources/test/probe-failure.integration.test.ts \
    --maxWorkers=1 --reporter=default --reporter=json \
    --outputFile=/evidence/native-tests.json > /evidence/native-tests.log 2>&1
  pnpm --filter @clankie/fleet-resources typecheck > /evidence/package-typecheck.log 2>&1
'
exec node /input/pid1-smoke.mjs
LINUX_RUN
then
  LINUX_RUN_STATUS=0
else
  LINUX_RUN_STATUS=$?
fi
printf '%s\n' "$LINUX_RUN_STATUS" > "$LINUX_VALIDATION_ROOT/container-exit.txt"
LINUX_CONTAINER_ID="$(cat "$LINUX_VALIDATION_ROOT/container.cid")"
docker container inspect "$LINUX_CONTAINER_ID" > "$LINUX_VALIDATION_ROOT/container-inspect.json"
docker cp "$LINUX_CONTAINER_ID:/evidence/." "$LINUX_VALIDATION_ROOT/artifacts/"
test "$LINUX_RUN_STATUS" -eq 0
```

The selected files include the actual FIFO, wrapper/runner death, surviving
group, cancellation and PID-incarnation checks, plus availability and the new
targeted-observation cases. The targeted cases cover fresh live-to-exit facts,
per-PID denied reads and malformed, missing, duplicate or misbound replies.
Their count may change; require **zero failures in both files** rather than a
fixed historical count. No simulator suite or real `simctl` command is selected.

Expected artifacts under `LINUX_VALIDATION_ROOT`:

| Artifact                                                                        | Required result                                                                                                                                |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `source-sha.txt`, `source-tar.sha256`, `archive-files.txt`, `pid1-smoke.sha256` | Exact committed source and smoke input, without local state/install trees                                                                      |
| `image-inspect.json`, `image-id.txt`, `docker-info.txt`                         | Actual image/platform and engine constraints                                                                                                   |
| `artifacts/frozen-install.log`, `artifacts/pnpm-version.txt`                    | Frozen install succeeds with pnpm 11.11.0                                                                                                      |
| `artifacts/native-tests.json`, `artifacts/native-tests.log`                     | Both selected files pass, no failed tests                                                                                                      |
| `artifacts/package-typecheck.log`                                               | Package typecheck succeeds                                                                                                                     |
| `artifacts/pid1-smoke.json`                                                     | Actual PID 1, non-root UID, helper available, healthy real pressure, builder admitted; PID 1 heavy rejected, absent receipt, zero leases/queue |
| `container-exit.txt`, `container-inspect.json`                                  | Exit 0, no OOM kill; CPU/memory/swap/PID limits match the command                                                                              |

On failure, preserve the log, inspection and whatever artifacts exist. A
missing `pid1-smoke.json` is a failed or incomplete smoke, never a pass. Record
this Linux execution beside the existing evidence only after all gates pass.
This source-container check does not verify the complete hosted release image,
AWS IAM, external body providers, service latency/CPU budgets or CoreSimulator.

Cleanup uses only the recorded container ID and matching label. Docker supports
[copying artifacts from a stopped container](https://docs.docker.com/reference/cli/docker/container/cp/).
Keep the archive and evidence directory for review. The base image may already
belong to other work, so this recipe does not delete it or prune Docker state.

```bash
LINUX_CONTAINER_ID="$(cat "$LINUX_VALIDATION_ROOT/container.cid")"
test "$(docker inspect --format '{{ index .Config.Labels "clankie.validation" }}' "$LINUX_CONTAINER_ID")" = "$LINUX_RUN_ID"
if test "$(docker inspect --format '{{.State.Running}}' "$LINUX_CONTAINER_ID")" = true; then
  "$FLEET_HEAVY" docker stop "$LINUX_CONTAINER_ID"
fi
docker rm "$LINUX_CONTAINER_ID"
```

If container creation failed before writing `container.cid`, there is no
recorded container to stop or remove. Do not substitute name searches, process
kills or global cleanup commands.
