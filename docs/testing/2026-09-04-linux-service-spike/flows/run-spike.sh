#!/usr/bin/env bash
# One runnable flow for the VUH-1053 proof: build from a tracked-source context,
# boot Clankie + relay in a Linux container, and complete a seat DM round trip
# through the app's own pairing client.
#
#   flows/run-spike.sh [clankie-repo] [clankie-app-repo]
#
# Requires the `clankie-herdr-linux:local` image (Herdr is a required runtime;
# `pnpm herdr:linux:smoke` builds it). Everything else is disposable.
set -euo pipefail

REPO="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)}"
APP_REPO="${2:-$(cd "${REPO}/../clankie-app" && pwd)}"
# The app client is read from a recorded commit, never from that repository's
# working tree: other lanes refactor there, and a proof must name what it ran.
APP_COMMIT="${CLANKIE_APP_COMMIT:-33e0ba9}"
APP_CLIENT_PATH="apps/mobile/pairingSession.ts"
APP_BARREL_PATH="packages/command-center/src/pairing/pairingUrl.ts"
# The launcher commit whose start/stop guards step 5b proves.
LAUNCHER_FIX="${CLANKIE_LAUNCHER_FIX:-a1500657}"
NAME="clankie-spike-$$"
IMAGE="clankie-linux-spike:$$"
CONTROL_PORT=14310
RELAY_PORT=14321
WORK="$(mktemp -d)"
trap 'docker rm -f "${NAME}" >/dev/null 2>&1 || true; docker rmi -f "${IMAGE}" >/dev/null 2>&1 || true; rm -rf "${WORK}"' EXIT

echo "== 0. build context: tracked files at HEAD only"
# Never build from the checkout itself: the working tree holds credentials,
# state, and node_modules that must not enter an image.
mkdir -p "${WORK}/ctx"
git -C "${REPO}" archive HEAD | tar -x -C "${WORK}/ctx"
# The Dockerfile itself is copied in, so the flow runs whether or not it is committed yet.
mkdir -p "${WORK}/ctx/scripts/release"
cp "${REPO}/scripts/release/clankie-linux.Dockerfile" "${WORK}/ctx/scripts/release/"
echo "   $(find "${WORK}/ctx" -type f | wc -l | tr -d ' ') files from $(git -C "${REPO}" rev-parse --short HEAD)"
echo "   clankie-app client: ${APP_COMMIT} ($(git -C "${APP_REPO}" rev-parse --short "${APP_COMMIT}"))"

echo "== 1. image"
docker build -q -f "${WORK}/ctx/scripts/release/clankie-linux.Dockerfile" -t "${IMAGE}" "${WORK}/ctx"

echo "== 2. container (--init is required: see breakage 1)"
docker run -d --init --name "${NAME}" \
  -p "127.0.0.1:${CONTROL_PORT}:${CONTROL_PORT}" -p "127.0.0.1:${RELAY_PORT}:4321" \
  -e CLANKIE_RELAY_URL="http://127.0.0.1:${RELAY_PORT}" "${IMAGE}" >/dev/null

echo "== 3. control-plane forwarder (stands in for the gateway; see breakage 2)"
docker exec -i "${NAME}" sh -c "cat > /forward.mjs" <<'FWD'
import { createServer, connect } from "node:net";
const [, , listen, target] = process.argv;
createServer((from) => {
  const to = connect(Number(target), "127.0.0.1");
  from.pipe(to); to.pipe(from);
  from.on("error", () => to.destroy()); to.on("error", () => from.destroy());
}).listen(Number(listen), "0.0.0.0", () => console.log(`forwarding 0.0.0.0:${listen} -> 127.0.0.1:${target}`));
FWD
docker exec -d "${NAME}" sh -c "setsid node /forward.mjs ${CONTROL_PORT} 4310 >/forward.log 2>&1 </dev/null"


echo "== 4. synthetic provider (transport only; no credential, no model proof)"
docker cp "$(dirname "${BASH_SOURCE[0]}")/synthetic-provider.mjs" "${NAME}:/synthetic-provider.mjs" >/dev/null
docker exec -d "${NAME}" sh -c "setsid node /synthetic-provider.mjs >/synthetic-provider.log 2>&1 </dev/null"
sleep 2
docker exec "${NAME}" sh -c 'curl -fsS http://127.0.0.1:18080/v1/models >/dev/null' \
  || { echo "synthetic provider did not start"; exit 1; }
docker exec "${NAME}" sh -lc 'cd /clankie && node apps/tui/bin/clankie.ts model add-local \
  --id spike --base-url http://127.0.0.1:18080 --models spike-echo --set' >/dev/null

echo "== 5. boot: starts Clankie + relay, never the activity surface"
docker exec "${NAME}" sh -lc 'cd /clankie && node apps/tui/bin/clankie.ts restart clankie' >/dev/null
docker exec "${NAME}" sh -lc 'cd /clankie && node apps/tui/bin/clankie.ts status'
docker exec "${NAME}" sh -c 'curl -fsS http://127.0.0.1:4310/health'; echo
# The forwarder only has something behind it once the service is up.
curl -fsS "http://127.0.0.1:${CONTROL_PORT}/health" >/dev/null \
  || { echo "control plane is not reachable through the forwarder"; docker exec "${NAME}" cat /forward.log; exit 1; }
echo "   control plane reachable from the host on ${CONTROL_PORT}"

echo "== 5b. VUH-1030: conflicts are scoped to this instance's own resources"
# The fix changed startService/stopService only, so `clankie status` (which calls
# inspectService) cannot exercise it. Drive the two changed branches directly,
# against real lsof, with activity's own ports free and a stranger elsewhere.
docker exec -i "${NAME}" sh -c "cat > /decoy.mjs" <<'DECOY'
// Carries activity's argv shape, listens nowhere near activity's ports.
import { createServer } from "node:http";
createServer((_req, res) => res.end("foreign")).listen(4399, "127.0.0.1", () =>
  console.log(`foreign look-alike pid ${process.pid} on 127.0.0.1:4399`),
);
DECOY
docker exec -d "${NAME}" sh -c \
  "setsid node /decoy.mjs --filter @clankie/discord-activity start >/decoy.log 2>&1 </dev/null"
sleep 2
DECOY_PID="$(docker exec "${NAME}" sh -c 'lsof -nP -iTCP:4399 -sTCP:LISTEN -t | head -1')"
[ -n "${DECOY_PID}" ] || { echo "decoy did not start"; exit 1; }
docker cp "$(dirname "${BASH_SOURCE[0]}")/guard-proof.mjs" "${NAME}:/guard-proof.mjs" >/dev/null

# The pre-fix supervisor, swapped in to show this case was a real regression.
git -C "${REPO}" show "${LAUNCHER_FIX}^:apps/tui/bin/service-supervisor.ts" > "${WORK}/service-supervisor.old.ts"
docker cp "${NAME}:/clankie/apps/tui/bin/service-supervisor.ts" "${WORK}/service-supervisor.new.ts" >/dev/null
docker cp "${WORK}/service-supervisor.old.ts" "${NAME}:/clankie/apps/tui/bin/service-supervisor.ts" >/dev/null
docker exec -e SPIKE_DECOY_PID="${DECOY_PID}" "${NAME}" sh -lc 'cd /clankie && node /guard-proof.mjs old'
docker cp "${WORK}/service-supervisor.new.ts" "${NAME}:/clankie/apps/tui/bin/service-supervisor.ts" >/dev/null

docker exec -e SPIKE_DECOY_PID="${DECOY_PID}" "${NAME}" sh -lc 'cd /clankie && node /guard-proof.mjs new'

# And a stranger on activity's own producer port must still block.
docker exec -d "${NAME}" sh -c \
  "setsid node -e 'require(\"node:http\").createServer().listen(4322,\"127.0.0.1\")' >/producer.log 2>&1 </dev/null"
sleep 2
docker exec -e SPIKE_DECOY_PID="${DECOY_PID}" "${NAME}" sh -lc 'cd /clankie && node /guard-proof.mjs producer'
docker exec "${NAME}" sh -c 'kill $(lsof -nP -iTCP:4322 -sTCP:LISTEN -t) 2>/dev/null; kill '"${DECOY_PID}"' 2>/dev/null; true'

echo "== 6. file credential broker"
docker exec "${NAME}" sh -c 'stat -c "%a %U %n" /state/credentials.json'

echo "== 7. pairing + seat DM round trip, through the app's own client"
# The barrel alias is the same narrowing clankie-app's own pairingSession.test.ts
# uses to keep React Native out of a Node run.
# Both the client and the barrel it imports come out of the recorded commit.
mkdir -p "${WORK}/app"
git -C "${APP_REPO}" show "${APP_COMMIT}:${APP_CLIENT_PATH}" > "${WORK}/app/pairingSession.ts"
git -C "${APP_REPO}" show "${APP_COMMIT}:${APP_BARREL_PATH}" > "${WORK}/app/pairingUrl.ts"
cat > "${WORK}/tsconfig.json" <<TSC
{
  "compilerOptions": {
    "module": "esnext",
    "moduleResolution": "bundler",
    "target": "esnext",
    "paths": {
      "@clankie/command-center": ["${WORK}/app/pairingUrl.ts"]
    }
  }
}
TSC
docker exec "${NAME}" sh -lc 'cd /clankie && node apps/tui/bin/clankie.ts pair --json' > "${WORK}/offer.json"
(cd "${REPO}" && pnpm --filter @clankie/clankie exec tsx --tsconfig "${WORK}/tsconfig.json" \
  "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pairing-and-seat-dm.ts" \
  "${WORK}/offer.json" "${WORK}/app/pairingSession.ts" \
  "http://127.0.0.1:${CONTROL_PORT}" "http://127.0.0.1:${RELAY_PORT}")

echo
echo "== done. container ${NAME} and image ${IMAGE} are removed on exit."
