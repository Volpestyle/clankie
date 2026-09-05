# Clankie boots in a Linux container (VUH-1053)

Date: 2026-09-04 America/Chicago

Code: this receipt is produced at Clankie `32931f45` with the clankie-app client at `12a4e11`. The flow prints
the Clankie and clankie-app commits it actually runs on, so a later run stamps its own; the re-run recorded in
[`evidence/05-run-spike-flow.txt`](evidence/05-run-spike-flow.txt) is Clankie `a1500657` — the committed launcher
fix — with the app client pinned at `33e0ba9`. The lead rerun at Clankie `258f776d` / app `33e0ba9`
adds a direct unowned-stop regression and requires the new start to return healthy; its full output is
[`evidence/16-lead-run-spike-flow.txt`](evidence/16-lead-run-spike-flow.txt).

Image: `clankie-linux-spike` from [`flows/clankie-linux.Dockerfile`](flows/clankie-linux.Dockerfile), derived
from `clankie-herdr-linux:local` for its Herdr binary. **Throwaway proof image**: not a release artifact, not
the hosted service image, and not a signed distribution — the release path stays `pnpm release:build`.

Host: `linux/arm64` container on macOS, published only on loopback (`127.0.0.1:14310` control plane via an
in-container forwarder, `127.0.0.1:14321` relay). The live install on 4310/4321 is untouched.

## Verdict

**Pass.** The launcher brings Clankie and the relay up in a Linux container, the credential broker runs on
files, and a device pairs and completes a seat DM round trip — both through the app's own pairing client and,
separately, from the real iOS app binary built for this run. The reply is produced by a **synthetic local
provider**, so this proves pairing, transport, and durable settlement end to end, and proves nothing about
model behaviour.

Herdr is a required runtime here, not an optional one. The image copies the binary from the proven Linux image
rather than rebuilding Rust or Zig, and the service supervises it: `/health` reports `"herdr":"healthy"`
([`evidence/01-health.json`](evidence/01-health.json)) — the bundled runtime is live under the service in
Linux, which is the evidence VUH-1109's remaining Linux criterion asks for.

## What each criterion shows

| Criterion                                               | Evidence                                                                                                                           | Result                                                                                        |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `clankie` + `relay` healthy under the launcher registry | [`02-clankie-status.json`](evidence/02-clankie-status.json)                                                                        | Both `healthy` and `owned`; relay reports `devices on 127.0.0.1:4321`                         |
| Credential broker on a non-Keychain backend             | [`03-file-credential-broker.txt`](evidence/03-file-credential-broker.txt)                                                          | `600 root /state/credentials.json`, six brokered providers, state root `0700`                 |
| Device pairing + one seat DM round trip                 | [`05-run-spike-flow.txt`](evidence/05-run-spike-flow.txt), [`06-conversation-events.jsonl`](evidence/06-conversation-events.jsonl) | Device activated, advertised `relayUrl` reached the device unchanged, captain replied durably |
| Written breakage list                                   | below                                                                                                                              | Four observed, two fixed inside the spike                                                     |

`clankie restart clankie` starts exactly Clankie, the relay, and the Discord bridge: `resolveRestartTargets`
closes over `restartsWith`, and the activity surface names none, so it stays down and reports `unreachable`.

## The round trip

The driver ([`flows/pairing-and-seat-dm.ts`](flows/pairing-and-seat-dm.ts), driven by [`flows/run-spike.sh`](flows/run-spike.sh)) calls
`createLivePairingSession` from the app's own `apps/mobile/pairingSession.ts` — the shipped client, not a
reimplementation. It runs in Node with the `@clankie/command-center` barrel aliased to the real
`parsePairingUrl`, the same narrowing the app's own `pairingSession.test.ts` uses to keep React Native out of a
Node test. **This leg is client-library level.** The separate app-binary leg below supplies the native proof.

The device redeems a `clankie pair` offer against the container, confirms access, and receives
`relayUrl: http://127.0.0.1:14321` — the origin the container advertises, learned at pair time rather than
built in. The seat DM then rides the relay with the device bearer:

```
[message] operator  Linux container spike round two: can you hear me?
[turn]    accepted
[message] captain   Yes - I hear you from inside the Linux container.
[turn]    completed
```

That captain text comes from [`flows/synthetic-provider.mjs`](flows/synthetic-provider.mjs), a canned
OpenAI-compatible endpoint registered with `clankie model add-local`. No production credential is exported and
no provider is called.

## The app-binary leg — the real iOS app, paired and answered

The client-library proof above is not the strongest reading of the criterion, so the leg was repeated with the
actual app binary, built for this purpose from a recorded commit.

**Isolation.** A separate clone of clankie-app at `33e0ba9`, its own DerivedData, its own Metro on port 8091,
a purpose-made simulator `VUH-1053-native-pP` (iPhone 17 Pro, iOS 26.5), and the same loopback container. No
shared worktree, Metro port, simulator, or DerivedData was touched, no app source was changed, and the build
was capped at 4 workers after checking native concurrency with the lane working in that repo.

**Build.** `expo prebuild` → `pod install` → `xcodebuild -configuration Debug -sdk iphonesimulator`, with
`CODE_SIGNING_ALLOWED=NO` and no production signing: **BUILD SUCCEEDED, 0 errors**
([`evidence/14-native-build-and-runtime.txt`](evidence/14-native-build-and-runtime.txt)). This replaced the
2026-08-30 dev client, which was older than the JS it had to serve and failed on `RNCSafeAreaProvider`.

**The run.** Metro carried `EXPO_PUBLIC_CLANKIE_CONTROL_PLANE_URL=http://127.0.0.1:14310`, and the app came up
`lane=simulator-live profile=development-live pairing=live`. Then, entirely through the app's own UI:

1. A `clankie pair` code minted inside the container was typed into **Enter pairing code**, and the access
   review named the container as the host it was pairing with — `PAIRING WITH 3c03360f9db8`, its hostname —
   offering Chat, Steer, Observe terminal, and Take Control
   ([`evidence/10-native-access-review.png`](evidence/10-native-access-review.png)).
2. **Connect with Take Control** completed the pairing; the container logged `device activated`.
3. Messages home listed Clankie, and the conversation opened on its composer
   ([`evidence/11-native-conversation.png`](evidence/11-native-conversation.png)).
4. A message typed and sent from the app came back answered
   ([`evidence/12-native-reply-delivered.png`](evidence/12-native-reply-delivered.png)):

```
Native app on the Linux container: can you hear me?     Delivered
Yes - I hear you from inside the Linux container.
```

**Durably settled** in the container, not just on screen
([`evidence/13-native-durable-events.jsonl`](evidence/13-native-durable-events.jsonl)):

```
[message] operator: Native app on the Linux container: can you hear me?
[turn]    accepted
[message] captain:  Yes - I hear you from inside the Linux container.
[turn]    completed
```

The reply text still comes from the synthetic provider, so this proves pairing, transport, and durable
settlement from a real app binary — and still nothing about model behaviour.

One observation, cause unverified: twice, after a Metro reload, the app returned to the pairing screen and the
device session had to be established again. The container kept the device activated across it, so nothing was
revoked on the host side, but **this was not traced** — a persisted paired session would normally be expected
to survive a JS reload, and whether the secure store failed to write, failed to restore, or the reload raced
the restore is unknown. Worth a look before it is dismissed; it does not affect the round trip above, which
completed on an established session.

## Breakage list

Every macOS assumption this spike actually hit, with the layer it lives in.

### 1. A killed service never exits — container PID 1 does not reap

Layer: container runtime, surfacing in `apps/tui/bin/service-supervisor.ts` liveness.

With `sleep infinity` as PID 1, `clankie restart captain` reports
`App relay (pid 177) did not exit after SIGKILL` and refuses to continue. The processes are gone but unreaped:
`ps` shows `62 Zs [MainThread] <defunct>`, and `/proc/<pid>/stat` reports state `Z`. What was observed is
narrow — a container PID 1 that does not reap leaves a killed service visible to the supervisor's liveness
check — and this run says nothing about how any other init behaves.

**`--init` is required deployment setup, not a workaround.** Running with a reaping init makes `restart`
succeed, and every command in this archive uses it. The supervisor needs no zombie handling to accommodate an
image that declines to include an init.

### 2. The control plane has no inbound listener

Layer: service bootstrap, `apps/clankie/src/index.ts` (`const listenHost = "127.0.0.1"`, no env seam).

The relay serves `/health` and three conversation paths only, so `/v1/pairing/redeem`, `/v1/pairing/complete`,
and `/v1/devices/self` have no route in from outside the container. The product answer is the public gateway's
outbound socket (ADR 0151), which this spike does not provision.

Worked around with an in-container TCP forwarder standing in for that path. A hosted image needs either the
gateway or a listen-host seam; the workaround is not a design.

### The VUH-1030 guard, proved rather than asserted

`clankie status` calls `inspectService`, which VUH-1030 deliberately left alone, so status cannot show the fix
working. Step 5b drives the two branches that did change — `startService` and `stopService` — against real
`lsof` inside the container, with activity's own ports free and a stranger carrying activity's argv shape on 4399. The [lead rerun](evidence/16-lead-run-spike-flow.txt) exercises both unowned branches before creating
an owned service record:

```
stopService(activity) without an owned record: threw        # old guard
startService(activity): threw — occupied by a process…      # old guard
stopService(activity) without an owned record: returned     # new guard
startService(activity): returned — state healthy            # new guard
stopService(activity): returned                             # owned cleanup
PRODUCER PORT: a listener on 4322 blocks the start, as it should.
```

The old supervisor is swapped in from `a1500657^`. Both old unowned guards must refuse; both new guards
must return, and start must reach `healthy`. Any other exception fails the flow. The decoy's liveness is
checked after every step. A listener on producer port 4322 remains a real conflict and blocks start.

### 3. `activity` cannot be turned off by configuration

Layer: launcher registry, `apps/tui/bin/services.ts`.

`ACTIVITY` defines no `enabled()`, unlike the Discord services and the tunnel, so "activity may stay
`enabled()`-off" is unreachable. Not a blocker: a targeted `clankie restart clankie` never starts it.

### 4. The Discord bridge starts with nothing to talk to

Layer: launcher registry and settings defaults.

The active body defaults to `bot`, so `discord-bridge` starts and reports `healthy` with
`detail: "no presence session"` in a container that has no Discord credential. Harmless here, and it never
sends anything, but a hosted image runs a process with no purpose.

### Smaller observations

- The app's pairing snapshot labels the host `id: "mac"` regardless of platform; the container appears as
  `mac` with its hostname as the display name.
- `/state/captain` is created `0755` while its siblings are `0700`.
- The launcher needs **`lsof`** as well as `procps`: it resolves per-port owners to scope conflicts to its own
  instance (VUH-1030), and activity owns two ports, 4320 and producer 4322. Debian's node image ships procps
  but not lsof, so the image installs both. Step 5b proves the scoping with real `lsof` — see below.
- Assumptions that held: `procps` is present for the supervisor's `ps` scan, `node apps/tui/bin/clankie.ts`
  runs under Node 24's native type stripping, no workspace package has an install hook, and no native npm
  dependency needs a compiler.

## Reproducing

One flow does all of it — context, image, container, forwarder, synthetic provider, boot, and the round trip —
and removes its own container and image on exit:

```bash
docs/testing/2026-09-04-linux-service-spike/flows/run-spike.sh [clankie-repo] [clankie-app-repo]
```

It needs `clankie-herdr-linux:local` (Herdr is a required runtime; `pnpm herdr:linux:smoke` builds it) and
`clankie-app` checked out beside this repository. [`evidence/05-run-spike-flow.txt`](evidence/05-run-spike-flow.txt)
is that flow's own output.

The flow runs the launcher guard proof against both the old and current supervisor, then pairs and waits
for the seat DM to settle in one process. Its device token stays in memory. It records both repository SHAs;
the pairing client and `pairingUrl.ts` come from `git show` at the pinned app commit, so the flow never reads
that repository's working tree. Override that commit with `CLANKIE_APP_COMMIT`, and the old launcher fix
commit with `CLANKIE_LAUNCHER_FIX`.

### The native app leg

```bash
# Isolated clone, so the shared worktree, its Metro, and its DerivedData stay untouched.
git clone --local ~/dev/clankie-app <scratch>/clankie-app && git -C <scratch>/clankie-app checkout 33e0ba9
ln -s ~/dev/clankie <scratch>/clankie          # the app workspace resolves ../clankie/packages/*
(cd <scratch>/clankie-app && pnpm install --frozen-lockfile)

cd <scratch>/clankie-app/apps/mobile
CLANKIE_VARIANT=dev npx expo prebuild --platform ios --no-install
(cd ios && pod install)
xcodebuild -workspace ios/Clankie.xcworkspace -scheme Clankie \
  -configuration Debug -sdk iphonesimulator -destination "generic/platform=iOS Simulator" \
  -derivedDataPath <scratch>/dd -jobs 4 RCT_METRO_PORT=8091 CODE_SIGNING_ALLOWED=NO build

# A simulator of your own, never an existing one.
sim=$(xcrun simctl create "linux-spike" "iPhone 17 Pro" com.apple.CoreSimulator.SimRuntime.iOS-26-5)
xcrun simctl boot "$sim"
xcrun simctl install "$sim" <scratch>/dd/Build/Products/Debug-iphonesimulator/Clankie.app

# Metro on a port nobody else is using, pointed at the container.
EXPO_PUBLIC_CLANKIE_METRO_LANE=simulator-live \
EXPO_PUBLIC_CLANKIE_CONTROL_PLANE_URL=http://127.0.0.1:14310 \
  npx expo start --dev-client --port 8091 --clear
xcrun simctl openurl "$sim" "clankie://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8091"
```

Then pair with a `clankie pair` code from the container and send one message from the app.
`-jobs 4` is deliberate: another lane builds natively on this machine, and a saturating build starves it.
